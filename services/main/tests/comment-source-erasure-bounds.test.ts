import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { applyContentErasure, checkContentErasureTargets, ContentErasureInvalid,
  ContentErasureStale } from '../src/modules/erasure/content.ts';
import { assertReplayedCommentSourcesTerminal, ContentRecoveryConflict,
} from '../src/modules/work/content-recovery-coverage.ts';

const digest = 'ab'.repeat(32);
const quote = 'bulk-source';
const annotation = 'authored annotation stays';

async function cluster() {
  const started = await startPostgresCluster();
  const pool = new Pool({ ...started.connection, max: 4 });
  return { pool, async stop() {
    await pool.end();
    started.remove();
  } };
}

async function accessTables(pool: Pool) {
  await pool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL,
      released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL REFERENCES access.governance_preservation_hold(id),
      operation_id text NOT NULL, material_ref text NOT NULL, reason text NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (hold_id, operation_id, material_ref))`);
}

/** One resource, `count` revisions, each with one comment quote and one evidence selector. */
async function population(pool: Pool, count: number, label: string) {
  const work = `https://rezics.com/id/${randomUUID()}`;
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const bytes = Buffer.from(JSON.stringify({ text: label }));
  const byteDigest = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, work]);
  const revisions = (await pool.query<{ id: string }>(`INSERT INTO content.revision
    (id, variant_id, operation_id, format, model, provenance, byte_digest, byte_length, serialized_bytes, body)
    SELECT gen_random_uuid(), $1, $2 || g::text, 'rezics-content-json-v1', 'fixture', '{}', $3, $4, $5, $6::jsonb
    FROM generate_series(1, $7) AS g RETURNING id::text`,
  [variant, `${label}-`, byteDigest, bytes.length, bytes, JSON.stringify({ text: label }), count])).rows.map(row => row.id);
  await pool.query(`INSERT INTO content.receipt
    (operation_id, request_digest, action, outcome, variant_id, revision_id)
    SELECT 'comment-' || id::text, $2, 'comment.create', 'succeeded', $3, id
    FROM unnest($1::uuid[]) AS id`, [revisions, digest, variant]);
  await pool.query(`INSERT INTO content.comment
    (id, operation_id, request_digest, revision_id, resource_id, variant_id, author, exact, prefix, suffix, body)
    SELECT gen_random_uuid(), 'comment-' || id::text, $2, id, $3, $4, $3, $5, 'pre', 'suf', $6
    FROM unnest($1::uuid[]) AS id`, [revisions, digest, work, variant, quote, annotation]);
  const principal = randomUUID();
  const claim = `https://rezics.com/id/${randomUUID()}`;
  await pool.query(`WITH planned AS (
      SELECT id AS content_revision, gen_random_uuid() AS receipt_id, gen_random_uuid() AS manifest_id
      FROM unnest($1::uuid[]) AS id
    ), receipts AS (
      INSERT INTO verification.receipt
        (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
      SELECT receipt_id, $2::uuid, 'evidence.record', 'k-' || manifest_id::text, $3, 'succeeded', manifest_id
      FROM planned
      RETURNING id
    ), manifests AS (
      INSERT INTO verification.evidence_set_revision
        (id, claim, claim_revision, purpose, predecessor, item_count, manifest_digest, operation_id, principal_id)
      SELECT planned.manifest_id, $4, $4, 'challenge', NULL, 1, $3, planned.receipt_id, $2::uuid
      FROM planned JOIN receipts ON receipts.id = planned.receipt_id
      RETURNING id
    )
    INSERT INTO verification.evidence_item
      (revision_id, ordinal, stance, content_revision_id, selector, availability)
    SELECT planned.manifest_id, 0, 'supports', planned.content_revision,
      jsonb_build_object('exact', $5::text, 'start', 0), 'available'
    FROM planned JOIN manifests ON manifests.id = planned.manifest_id`,
  [revisions, principal, digest, claim, quote]);
  return { work, variant, revisions, principal, claim };
}

async function openCounts(pool: Pool, revisions: readonly string[]) {
  const comments = (await pool.query<{ open: number; bodies: number }>(`SELECT
    count(*) FILTER (WHERE exact IS NOT NULL OR prefix IS NOT NULL OR suffix IS NOT NULL)::int AS open,
    count(*) FILTER (WHERE body = $2)::int AS bodies
    FROM content.comment WHERE revision_id = ANY($1::uuid[])`, [revisions, annotation])).rows[0]!;
  const evidence = (await pool.query<{ open: number; bound: number }>(`SELECT
    count(*) FILTER (WHERE NOT source_terminal AND selector->>'exact' IS NOT NULL)::int AS open,
    count(*) FILTER (WHERE source_terminal)::int AS bound
    FROM verification.evidence_item WHERE content_revision_id = ANY($1::uuid[])`, [revisions])).rows[0]!;
  return { comments, evidence };
}

test('65 and 256 revisions clear comment and evidence selectors under one journal', async () => {
  const source = await cluster();
  const { pool } = source;
  const access = new Pool({ ...pool.options });
  try {
    await migrateContent(pool);
    await accessTables(pool);
    for (const count of [65, 256]) {
      const { work, revisions } = await population(pool, count, `bound-${count}`);
      await expect(checkContentErasureTargets(pool, work, revisions)).rejects.toBeInstanceOf(ContentErasureInvalid);
      const erasureId = randomUUID();
      expect(await applyContentErasure(pool, { preservationAccess: access, erasureId, erasureEpoch: '5',
        resourceId: work, revisionIds: revisions })).toEqual({ applied: count });
      expect(await openCounts(pool, revisions)).toEqual({
        comments: { open: 0, bodies: count },
        evidence: { open: 0, bound: count },
      });
      const bound = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM verification.evidence_item
        WHERE content_revision_id = ANY($1::uuid[]) AND source_erasure_id = $2 AND source_erasure_epoch = 5`,
      [revisions, erasureId])).rows[0]!.n;
      expect(bound).toBe(count);
      await assertReplayedCommentSourcesTerminal(pool, revisions, erasureId, '5');
    }
  } finally {
    await access.end();
    await source.stop();
  }
}, 90_000);

test('evidence closure refuses a missing selector, a wrong journal, a rollback and a preservation hold', async () => {
  const source = await cluster();
  const { pool } = source;
  const access = new Pool({ ...pool.options });
  try {
    await migrateContent(pool);
    await accessTables(pool);
    const missing = await population(pool, 1, 'missing');
    const missingId = missing.revisions[0]!;
    const missingErasure = randomUUID();
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [missingId]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 4)`, [missingId, missingErasure]);
    await pool.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 4)', [[missingId], missingErasure]);
    await expect(assertReplayedCommentSourcesTerminal(pool, [missingId], missingErasure, '4'))
      .rejects.toThrow(`erased source selectors remain: ${missingId}`);
    expect((await openCounts(pool, [missingId])).evidence.open).toBe(1);

    const wrong = await population(pool, 1, 'wrong');
    const wrongId = wrong.revisions[0]!;
    const wrongErasure = randomUUID();
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [wrongId]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, 6)`, [wrongId, wrongErasure]);
    await expect(pool.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 7)',
      [[wrongId], wrongErasure])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 6)',
      [[wrongId], randomUUID()])).rejects.toMatchObject({ code: '23514' });
    expect((await openCounts(pool, [wrongId])).evidence.open).toBe(1);
    await pool.query('SELECT content.erase_comment_sources($1::uuid[], $2::uuid, 6)', [[wrongId], wrongErasure]);
    await pool.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 6)', [[wrongId], wrongErasure]);
    await expect(assertReplayedCommentSourcesTerminal(pool, [wrongId], wrongErasure, '7'))
      .rejects.toThrow(ContentRecoveryConflict);
    await assertReplayedCommentSourcesTerminal(pool, [wrongId], wrongErasure, '6');

    const rolled = await population(pool, 1, 'rolled');
    const rolledId = rolled.revisions[0]!;
    const rolledErasure = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1`, [rolledId]);
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 8)`, [rolledId, rolledErasure]);
      await client.query('SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 8)',
        [[rolledId], rolledErasure]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await pool.query<{ exact: string; source_terminal: boolean }>(`SELECT selector->>'exact' AS exact,
      source_terminal FROM verification.evidence_item WHERE content_revision_id = $1`, [rolledId])).rows[0])
      .toEqual({ exact: quote, source_terminal: false });
    expect((await pool.query('SELECT 1 FROM content.revision_erasure WHERE revision_id = $1', [rolledId])).rowCount)
      .toBe(0);
    expect((await pool.query<{ availability: string }>('SELECT availability FROM content.revision WHERE id = $1',
      [rolledId])).rows[0]?.availability).toBe('available');

    const held = await population(pool, 1, 'held');
    const heldId = held.revisions[0]!;
    const holdId = randomUUID();
    await pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
      VALUES ($1, $2, 'legal hold')`, [holdId, held.work]);
    await expect(applyContentErasure(pool, { preservationAccess: access, erasureId: randomUUID(),
      erasureEpoch: '9', resourceId: held.work, revisionIds: [heldId] })).rejects.toBeInstanceOf(ContentErasureStale);
    expect(await openCounts(pool, [heldId])).toEqual({
      comments: { open: 1, bodies: 1 },
      evidence: { open: 1, bound: 0 },
    });
    expect((await pool.query<{ availability: string }>('SELECT availability FROM content.revision WHERE id = $1',
      [heldId])).rows[0]?.availability).toBe('available');
    expect((await pool.query('SELECT 1 FROM content.revision_erasure WHERE revision_id = $1', [heldId])).rowCount)
      .toBe(0);
  } finally {
    await access.end();
    await source.stop();
  }
}, 60_000);

test('257 targets and duplicates are refused before any query', async () => {
  let calls = 0;
  const queried = () => { calls += 1; throw new Error('erasure queried'); };
  const pool = { query: queried, connect: queried } as unknown as Pool;
  const ids = Array.from({ length: 257 }, () => randomUUID());
  const command = { preservationAccess: pool, erasureId: randomUUID(), erasureEpoch: '1',
    resourceId: `https://rezics.com/id/${randomUUID()}`, revisionIds: ids };
  await expect(applyContentErasure(pool, command)).rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(applyContentErasure(pool, { ...command, revisionIds: [ids[0]!, ids[0]!] }))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(checkContentErasureTargets(pool, command.resourceId, ids.slice(0, 65)))
    .rejects.toBeInstanceOf(ContentErasureInvalid);
  await expect(assertReplayedCommentSourcesTerminal(pool as unknown as PoolClient, ids, command.erasureId, '1'))
    .rejects.toThrow('source terminal check exceeds the retained target bound');
  expect(calls).toBe(0);
});
