import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../src/migrate.ts';

// Lock and planner behaviour of migration 1709's own statements. The assertions read the
// installed function text, so a rewrite of the update statements is what they follow.
const digest = 'ab'.repeat(32);
const canary = 'RACE-CANARY-evidence';

async function cluster() {
  const postgres = await startPostgresCluster();
  const pool = new Pool({ ...postgres.connection, max: 8 });
  return { pool, async stop() {
    try { await pool.end(); }
    finally { postgres.remove(); }
  } };
}

async function revision(pool: Pool, text: string) {
  const id = randomUUID();
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const bytes = Buffer.from(JSON.stringify({ text }));
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, `urn:rezics:work:${randomUUID()}`]);
  await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
  [id, variant, `op-${id}`, createHash('sha256').update(bytes).digest('hex'), bytes.length, bytes,
    JSON.stringify({ text })]);
  return id;
}

/** One manifest of `count` Content-bound items; source-bearing ones carry an `exact` quote. */
async function manifest(client: Pool | PoolClient, principal: string, claim: string, contentRevision: string,
  count: number, source: boolean) {
  const id = randomUUID();
  const operation = randomUUID();
  await client.query(`INSERT INTO verification.receipt
    (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
    VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`, [operation, principal, `k-${id}`, digest, id]);
  await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
    predecessor, item_count, manifest_digest, operation_id, principal_id)
    VALUES ($1, $2, $2, 'challenge', NULL, $3, $4, $5, $6)`, [id, claim, count, digest, operation, principal]);
  await client.query(`INSERT INTO verification.evidence_item
    (revision_id, ordinal, stance, content_revision_id, selector, availability)
    SELECT $1, g, 'supports', $2,
      CASE WHEN $3 THEN jsonb_build_object('exact', 'bulk-source', 'start', g)
           ELSE jsonb_build_object('start', g) END, 'available'
    FROM generate_series(0, $4::int - 1) AS g`, [id, contentRevision, source, count]);
  return id;
}

async function committed(pool: Pool, principal: string, claim: string, contentRevision: string, count: number,
  source: boolean) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = await manifest(client, principal, claim, contentRevision, count, source);
    await client.query('COMMIT');
    return id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function tombstone(client: Pool | PoolClient, revisionId: string, erasureId: string, epoch: number) {
  await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1 AND availability = 'available'`, [revisionId]);
  await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [revisionId, erasureId, epoch]);
}

test('a direct insert waits behind an erasure and then cannot add source text', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const principal = randomUUID();
    const claim = `https://rezics.com/id/${randomUUID()}`;
    const raced = await revision(pool, canary);
    const erasure = randomUUID();
    const erasing = await pool.connect();
    const inserting = await pool.connect();
    try {
      await erasing.query('BEGIN');
      await tombstone(erasing, raced, erasure, 2);
      await erasing.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 2)', [[raced], erasure]);
      await inserting.query('BEGIN');
      const id = randomUUID();
      const operation = randomUUID();
      await inserting.query(`INSERT INTO verification.receipt
        (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
        VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`, [operation, principal, `r-${id}`, digest, id]);
      await inserting.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
        predecessor, item_count, manifest_digest, operation_id, principal_id)
        VALUES ($1, $2, $2, 'challenge', NULL, 1, $3, $4, $5)`, [id, claim, digest, operation, principal]);
      const outcome = inserting.query(`INSERT INTO verification.evidence_item
        (revision_id, ordinal, stance, content_revision_id, selector, availability)
        VALUES ($1, 0, 'supports', $2, $3::jsonb, 'available')`, [id, raced, JSON.stringify({ exact: canary })])
        .then(() => 'inserted', (error: { code?: string }) => `rejected:${error.code}`);
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO verification.evidence_item%'`)).rowCount ?? 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(1);
      await erasing.query('COMMIT');
      expect(await outcome).toBe('rejected:23514');
      await inserting.query('ROLLBACK');
    } finally {
      await erasing.query('ROLLBACK').catch(() => undefined);
      await inserting.query('ROLLBACK').catch(() => undefined);
      erasing.release();
      inserting.release();
    }
    expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM verification.evidence_item
      WHERE content_revision_id = $1`, [raced])).rows[0]?.n).toBe(0);
  } finally { await source.stop(); }
}, 60_000);

test('row locks on source-free or terminal history do not block erasure and its statements use the partial indexes', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const principal = randomUUID();
    const claim = `https://rezics.com/id/${randomUUID()}`;
    const quiet = await revision(pool, 'quiet');
    const finished = await revision(pool, 'finished');
    const erasure = randomUUID();
    const quietSets: string[] = [];
    const finishedSets: string[] = [];
    for (let set = 0; set < 64; set++) {
      quietSets.push(await committed(pool, principal, claim, quiet, 32, false));
      finishedSets.push(await committed(pool, principal, claim, finished, 32, true));
    }
    await tombstone(pool, quiet, randomUUID(), 1);
    await tombstone(pool, finished, erasure, 3);
    expect((await pool.query<{ cleared: number }>(
      'SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 3) AS cleared',
      [[finished], erasure])).rows[0]?.cleared).toBe(2048);

    const replay = async (revisionIds: string[], id: string, epoch: number) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '500ms'");
        await client.query("SET LOCAL statement_timeout = '5s'");
        const result = await client.query<{ cleared: number }>(
          'SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, $3::bigint) AS cleared',
          [revisionIds, id, epoch]);
        await client.query('COMMIT');
        return result.rows[0]!.cleared;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
    };
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM verification.evidence_item WHERE revision_id = ANY($1::uuid[]) FOR UPDATE',
        [[...quietSets.slice(0, 4), ...finishedSets.slice(0, 4)]]);
      expect(await replay([finished], erasure, 3)).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    const definition = (await pool.query<{ prosrc: string }>(`SELECT prosrc FROM pg_proc
      WHERE oid = 'verification.erase_evidence_sources(uuid[], uuid, bigint)'::regprocedure`)).rows[0]!.prosrc;
    const statements = definition.match(/UPDATE verification\.evidence_item[\s\S]*?;/g) ?? [];
    expect(statements).toHaveLength(2);
    // No row lock is taken on evidence history ahead of the updates.
    expect(definition.replace(/--.*$/gm, '').replace(/UPDATE verification\.evidence_item[\s\S]*?;/g, ''))
      .not.toMatch(/evidence_item/);
    await pool.query('ANALYZE verification.evidence_item');
    const planned = await pool.connect();
    try {
      await planned.query('BEGIN');
      await planned.query('SET LOCAL enable_seqscan = off');
      const expectedIndexes = ['evidence_item_open_source', 'evidence_item_terminal_source'];
      for (const [position, statement] of statements.entries()) {
        const bound = statement.replace(/\brevision_ids\b/g, '$1::uuid[]').replace(/\berasure\b/g, '$2::uuid')
          .replace(/\bepoch\b/g, '$3::bigint');
        const plan = (await planned.query<Record<string, string>>(`EXPLAIN (ANALYZE, FORMAT TEXT) ${bound}`,
          [[quiet, finished], erasure, 3])).rows.map(row => row['QUERY PLAN']).join('\n');
        expect(plan).toContain(expectedIndexes[position]!);
        expect(plan).not.toContain('Seq Scan');
        expect(plan).not.toMatch(/Rows Removed by Filter: [1-9]/);
        expect(plan).toContain('Update on evidence_item');
      }
      await planned.query('ROLLBACK');
    } finally {
      await planned.query('ROLLBACK').catch(() => undefined);
      planned.release();
    }
  } finally { await source.stop(); }
}, 120_000);

test('a transaction-long snapshot cannot erase evidence sources', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const principal = randomUUID();
    const claim = `https://rezics.com/id/${randomUUID()}`;
    const stale = await revision(pool, canary);
    const snapshot = await pool.connect();
    const erasure = randomUUID();
    try {
      await snapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await snapshot.query('SELECT 1');
      const evidence = await committed(pool, principal, claim, stale, 1, true);
      await tombstone(pool, stale, erasure, 4);
      await expect(snapshot.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 4)',
        [[stale], erasure])).rejects.toMatchObject({ code: '25000' });
      await snapshot.query('ROLLBACK');
      expect((await pool.query<{ exact: string | null; source_terminal: boolean }>(
        `SELECT selector->>'exact' AS exact, source_terminal FROM verification.evidence_item
         WHERE revision_id = $1`, [evidence])).rows[0]).toEqual({ exact: 'bulk-source', source_terminal: false });
      expect((await pool.query<{ cleared: number }>(
        'SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 4) AS cleared',
        [[stale], erasure])).rows[0]?.cleared).toBe(1);
    } finally {
      await snapshot.query('ROLLBACK').catch(() => undefined);
      snapshot.release();
    }
  } finally { await source.stop(); }
}, 60_000);
