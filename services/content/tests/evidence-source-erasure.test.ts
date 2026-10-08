import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { migrateContent } from '../src/migrate.ts';
import { evidenceDigestKeys, evidenceSourceTextKeys } from '../../main/src/modules/verification/schema.ts';
import { VerificationInvalid, VerificationStore } from '../../main/src/modules/verification/store.ts';

const root = resolve(import.meta.dir, '../../..');
const canary = 'QUOTE-CANARY-ζ-evidence';
const nestedCanary = 'NESTED-CANARY-ζ-label';
const otherCanary = 'OTHER-PASSAGE-η-kept';
const authoredNote = 'authored note stays';
const digest = 'ab'.repeat(32);

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function cluster() {
  const state = join(root, '.temp', `evidence-source-erasure-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  const user = process.env.USER ?? execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port, user, database: 'postgres', max: 8 });
  return { pool, port, user, state, async stop() {
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  } };
}

function native(id = randomUUID()) { return `https://rezics.com/id/${id}`; }

async function revision(pool: Pool, text: string) {
  const id = randomUUID();
  const variant = `urn:rezics:variant:${randomUUID()}`;
  const bytes = Buffer.from(JSON.stringify({ text }));
  const byteDigest = createHash('sha256').update(bytes).digest('hex');
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, `urn:rezics:work:${randomUUID()}`]);
  await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
  [id, variant, `op-${id}`, byteDigest, bytes.length, bytes, JSON.stringify({ text })]);
  return id;
}

async function observation(pool: Pool, principal: string) {
  const record = randomUUID();
  const id = randomUUID();
  await pool.query(`INSERT INTO source.record (id, provider, namespace, external_id)
    VALUES ($1, 'fixture', 'work', $2)`, [record, record]);
  await pool.query(`INSERT INTO source.observation (id, record_id, principal_id, media_type, retention,
    coverage, rights_evidence) VALUES ($1, $2, $3, 'application/json', 'not-retained', '{}', '{}')`,
  [id, record, principal]);
  return id;
}

async function withClient<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function erase(pool: Pool, revisionId: string, erasureId: string, epoch: string) {
  return withClient(pool, async client => {
    await client.query('SELECT id FROM content.revision WHERE id = $1 ORDER BY id FOR UPDATE', [revisionId]);
    const tombstone = await client.query('SELECT erasure_id::text FROM content.revision_erasure WHERE revision_id = $1',
      [revisionId]);
    if (!tombstone.rowCount) {
      await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1 AND availability = 'available'`, [revisionId]);
      await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, $3::bigint)`, [revisionId, erasureId, epoch]);
    } else if (tombstone.rows[0]?.erasure_id !== erasureId) {
      throw new Error('revision tombstone belongs to another journal entry');
    }
    const cleared = await client.query<{ cleared: number }>(
      `SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, $3::bigint) AS cleared`,
      [[revisionId], erasureId, epoch]);
    return cleared.rows[0]!.cleared;
  });
}

test('content-bound source text clears once under the revision journal and cannot be rewritten', async () => {
  const source = await cluster();
  const { pool } = source;
  try {
    await migrateContent(pool);
    const lists = await pool.query<{ source_keys: string[]; digest_keys: string[] }>(
      `SELECT verification.evidence_source_text_keys() AS source_keys,
              verification.evidence_digest_keys() AS digest_keys`);
    expect(lists.rows[0]).toEqual({ source_keys: [...evidenceSourceTextKeys], digest_keys: [...evidenceDigestKeys] });

    const principal = randomUUID();
    const store = new VerificationStore(pool);
    const claim = native();
    const claimRevision = native();
    const cited = await revision(pool, canary);
    const unrelated = await revision(pool, otherCanary);
    const observed = await observation(pool, principal);
    const selector = { exact: canary, prefix: 'Before', suffix: 'After', quote: canary,
      start: 4, end: 20, range: { start: 4, end: 20 }, digest };
    await expect(store.recordEvidence(principal, randomUUID(), claim, { claimRevision, expectedHead: null,
      items: [{ stance: 'supports', contentRevision: cited, selector: { kind: 'whole' },
        availability: 'available' }] })).rejects.toBeInstanceOf(VerificationInvalid);
    await expect(store.recordEvidence(principal, randomUUID(), claim, { claimRevision, expectedHead: null,
      items: [{ stance: 'supports', contentRevision: cited, selector: { exact: canary, note: authoredNote },
        availability: 'available' }] })).rejects.toBeInstanceOf(VerificationInvalid);

    const evidenceKey = `evidence-${randomUUID()}`;
    const evidenceInput = { claimRevision, expectedHead: null as string | null, items: [
      { stance: 'supports' as const, observation: observed, selector: { field: 'releaseDate' }, availability: 'available' as const },
      { stance: 'supports' as const, contentRevision: cited, selector, availability: 'available' as const },
      { stance: 'contradicts' as const, contentRevision: cited,
        selector: { ...selector, quote: `${canary}-b`, exact: `${canary}-b` }, availability: 'available' as const },
      { stance: 'uncertain' as const, graphReference: 'urn:rezics:graph:evidence-source',
        selector: { label: nestedCanary }, availability: 'available' as const },
    ] };
    const recorded = await store.recordEvidence(principal, evidenceKey, claim, evidenceInput);
    const evidenceId = recorded.evidence.revision.split('/').at(-1)!;
    expect(recorded.evidence.items[1]?.selector).toMatchObject({ exact: canary, start: 4, digest });
    expect(recorded.evidence.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const manifestBefore = recorded.evidence.manifestDigest;
    const receiptBefore = (await pool.query<{ request_digest: string }>(
      `SELECT request_digest FROM verification.receipt WHERE result_id = $1 AND action = 'evidence.record'`,
      [evidenceId])).rows[0]!.request_digest;
    await expect(store.recordEvidence(principal, randomUUID(), claim, { claimRevision,
      expectedHead: evidenceId, items: [
        { stance: 'supports', contentRevision: cited, selector, availability: 'available' },
        { stance: 'supports', contentRevision: cited, selector, availability: 'available' },
      ] })).rejects.toMatchObject({ code: '23505' });

    const legacyId = randomUUID();
    const legacyOperation = randomUUID();
    const legacyDigest = createHash('sha256').update(legacyId).digest('hex');
    const legacyClient = await pool.connect();
    try {
      await legacyClient.query('BEGIN');
      await legacyClient.query(`INSERT INTO verification.receipt
        (id, principal_id, action, idempotency_key, request_digest, outcome, result_id)
        VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`,
      [legacyOperation, principal, `legacy-${legacyId}`, legacyDigest, legacyId]);
      await legacyClient.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
        predecessor, item_count, manifest_digest, operation_id, principal_id)
        VALUES ($1, $2, $3, 'challenge', NULL, 1, $4, $5, $6)`,
      [legacyId, claim, claimRevision, legacyDigest, legacyOperation, principal]);
      await legacyClient.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance, content_revision_id,
        selector, availability) VALUES ($1, 0, 'contradicts', $2, $3::jsonb, 'available')`,
      [legacyId, cited, JSON.stringify({ kind: 'TextQuoteSelector', exact: canary, start: 11, end: 30, digest,
        flag: true, locator: { quote: nestedCanary, position: 7, label: nestedCanary } })]);
      await legacyClient.query('COMMIT');
    } catch (error) {
      await legacyClient.query('ROLLBACK');
      throw error;
    } finally { legacyClient.release(); }
    expect((await pool.query<{ open: string[] }>(
      `SELECT array_agg(revision_id::text ORDER BY revision_id) AS open
       FROM verification.open_evidence_source_revisions($1::uuid[])`, [[cited]])).rows[0]?.open?.sort())
      .toEqual([cited]);

    const challenge = await store.submitChallenge(principal, randomUUID(), claim, {
      claimRevision, adoptedRevision: null, context: 'urn:rezics:context:evidence-source',
      reason: authoredNote, actingSubject: native(), counterevidence: [
        { stance: 'contradicts', contentRevision: cited, selector: { quote: canary, position: 3 },
          availability: 'available' }] });
    const challengeRow = (await pool.query<{ reason: string; counterevidence: string }>(
      `SELECT reason, counterevidence::text FROM verification.challenge WHERE id = $1`,
      [challenge.challenge.challenge.split('/').at(-1)])).rows[0]!;

    await expect(pool.query(`UPDATE verification.evidence_item SET stance = 'uncertain' WHERE revision_id = $1`,
      [evidenceId])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM verification.evidence_item WHERE revision_id = $1', [evidenceId]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`UPDATE verification.evidence_item SET selector = selector - 'exact'
      WHERE revision_id = $1 AND ordinal = 1`, [evidenceId])).rejects.toMatchObject({ code: '23514' });

    const rolling = await pool.connect();
    try {
      await rolling.query('BEGIN');
      await rolling.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1`, [unrelated]);
      await rolling.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 4)`, [unrelated, randomUUID()]);
      await rolling.query('ROLLBACK');
    } finally { rolling.release(); }
    expect((await pool.query(`SELECT availability FROM content.revision WHERE id = $1`, [unrelated])).rows[0]?.availability)
      .toBe('available');

    const blocker = await pool.connect();
    const blockedErasure = randomUUID();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT revision_id FROM verification.evidence_item WHERE revision_id = $1
        ORDER BY ordinal FOR UPDATE`, [evidenceId]);
      await expect(erase(pool, cited, blockedErasure, '1')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await pool.query(`SELECT availability FROM content.revision WHERE id = $1`, [cited])).rows[0]?.availability)
      .toBe('available');
    expect((await pool.query(`SELECT selector::text AS selector FROM verification.evidence_item
      WHERE revision_id = $1 AND ordinal = 1`, [evidenceId])).rows[0]?.selector).toContain(canary);

    const share = await pool.connect();
    const racedRevision = await revision(pool, canary);
    const raceErasure = randomUUID();
    try {
      await share.query('BEGIN');
      await share.query('SELECT id FROM content.revision WHERE id = $1 FOR SHARE', [racedRevision]);
      const erasing = erase(pool, racedRevision, raceErasure, '2');
      for (let attempt = 0; ; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%ORDER BY id FOR UPDATE%'`);
        if (waiting.rowCount) break;
        if (attempt === 200) throw new Error('erasure did not wait for the revision share lock');
        await Bun.sleep(10);
      }
      const raced = await store.recordEvidence(principal, randomUUID(), native(), {
        claimRevision, expectedHead: null, items: [{ stance: 'supports', contentRevision: racedRevision,
          selector: { exact: canary, start: 1 }, availability: 'available' }] });
      await share.query('COMMIT');
      expect(await erasing).toBe(1);
      const racedId = raced.evidence.revision.split('/').at(-1)!;
      expect((await pool.query(`SELECT selector->>'exact' AS exact FROM verification.evidence_item
        WHERE revision_id = $1`, [racedId])).rows[0]?.exact).toBeNull();
      expect(JSON.stringify(await store.readEvidence(racedId))).not.toContain(canary);
    } finally {
      await share.query('ROLLBACK').catch(() => undefined);
      share.release();
    }

    const closedRevision = await revision(pool, canary);
    const winner = await pool.connect();
    let creating: Promise<unknown> | undefined;
    try {
      await winner.query('BEGIN');
      await winner.query('SELECT id FROM content.revision WHERE id = $1 FOR UPDATE', [closedRevision]);
      creating = store.recordEvidence(principal, randomUUID(), native(), {
        claimRevision, expectedHead: null, items: [{ stance: 'supports', contentRevision: closedRevision,
          selector: { exact: canary }, availability: 'available' }] });
      for (let attempt = 0; ; attempt++) {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FOR SHARE OF r%'`);
        if (waiting.rowCount) break;
        if (attempt === 200) throw new Error('evidence insert did not wait for the erasure lock');
        await Bun.sleep(10);
      }
      const closedErasure = randomUUID();
      await winner.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1`, [closedRevision]);
      await winner.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, 5)`, [closedRevision, closedErasure]);
      await winner.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 5)`,
        [[closedRevision], closedErasure]);
      await winner.query('COMMIT');
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
    await expect(creating).rejects.toBeInstanceOf(VerificationInvalid);
    expect((await pool.query(`SELECT count(*)::int AS n FROM verification.evidence_item i
      JOIN verification.evidence_set_revision r ON r.id = i.revision_id
      WHERE i.content_revision_id = $1 AND i.selector::text LIKE $2`,
    [closedRevision, `%${canary}%`])).rows[0]?.n).toBe(0);

    const kept = await store.recordEvidence(principal, randomUUID(), native(), {
      claimRevision, expectedHead: null, items: [{ stance: 'supports', contentRevision: unrelated,
        selector: { exact: otherCanary, start: 2 }, availability: 'available' }] });
    const before = join(source.state, 'before.sql');
    execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', 'postgres', '--no-owner', '--no-privileges', '-f', before]);
    const backup = readFileSync(before, 'utf8');
    expect(backup).toContain(canary);
    expect(backup).toContain(receiptBefore);
    const restoredName = `evidence_src_${randomUUID().replaceAll('-', '')}`;
    await pool.query(`CREATE DATABASE ${restoredName}`);
    execFileSync('psql', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', restoredName, '-v', 'ON_ERROR_STOP=1', '-f', before], { cwd: source.state, stdio: 'pipe' });
    const restored = new Pool({ host: '127.0.0.1', port: source.port, user: source.user,
      database: restoredName, max: 2 });
    try {
      const replay = randomUUID();
      const client = await restored.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
          WHERE id = $1 AND availability = 'available'`, [cited]);
        await client.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
          VALUES ($1, $2, 9)`, [cited, replay]);
        await client.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 9)`, [[cited], replay]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally { client.release(); }
      const replayed = await new VerificationStore(restored).readEvidence(evidenceId);
      expect(JSON.stringify(replayed)).not.toContain(canary);
      expect(replayed?.manifestDigest).toBe(manifestBefore);
      expect((await restored.query<{ request_digest: string }>(
        `SELECT request_digest FROM verification.receipt WHERE result_id = $1`,
        [evidenceId])).rows[0]?.request_digest).toBe(receiptBefore);
    } finally { await restored.end(); }
    const erasureId = randomUUID();
    expect(await erase(pool, cited, erasureId, '7')).toBeGreaterThan(0);
    await expect(pool.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 7)`,
      [[cited], randomUUID()])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, 8)`,
      [[cited], erasureId])).rejects.toMatchObject({ code: '23514' });
    expect(await erase(pool, cited, erasureId, '7')).toBe(0);

    const stored = (await pool.query<{ ordinal: number; stance: string; selector: Record<string, unknown>;
      content_revision_id: string | null }>(`SELECT ordinal, stance, selector, content_revision_id::text
      FROM verification.evidence_item WHERE revision_id = $1 ORDER BY ordinal`, [evidenceId])).rows;
    expect(stored.map(row => [row.ordinal, row.stance, row.content_revision_id])).toEqual([
      [0, 'supports', null], [1, 'supports', cited], [2, 'contradicts', cited], [3, 'uncertain', null],
    ]);
    expect(stored[0]?.selector).toEqual({ field: 'releaseDate' });
    expect(stored[1]?.selector).toEqual({ start: 4, end: 20, range: { start: 4, end: 20 }, digest, sourceTerminal: true });
    expect(stored[2]?.selector).toMatchObject({ start: 4, end: 20, digest, sourceTerminal: true });
    expect(JSON.stringify(stored[1]?.selector)).not.toContain(canary);
    expect(JSON.stringify(stored[2]?.selector)).not.toContain(canary);
    expect(stored[3]?.selector).toEqual({ label: nestedCanary });
    const legacy = (await pool.query<{ selector: Record<string, unknown>; manifest_digest: string }>(
      `SELECT i.selector, r.manifest_digest FROM verification.evidence_item i
       JOIN verification.evidence_set_revision r ON r.id = i.revision_id WHERE i.revision_id = $1`,
      [legacyId])).rows[0]!;
    expect(legacy.selector).toEqual({ start: 11, end: 30, digest, flag: true, locator: { position: 7 },
      sourceTerminal: true });
    expect(legacy.manifest_digest).toBe(legacyDigest);
    expect((await pool.query(`SELECT manifest_digest FROM verification.evidence_set_revision WHERE id = $1`,
      [evidenceId])).rows[0]?.manifest_digest).toBe(manifestBefore);
    expect((await pool.query(`SELECT request_digest FROM verification.receipt WHERE result_id = $1`,
      [evidenceId])).rows[0]?.request_digest).toBe(receiptBefore);
    expect((await pool.query(`SELECT reason FROM verification.challenge WHERE id = $1`,
      [challenge.challenge.challenge.split('/').at(-1)])).rows[0]?.reason).toBe(authoredNote);
    expect((await pool.query(`SELECT selector->>'quote' AS quote FROM verification.evidence_item
      WHERE revision_id = $1`, [challengeRow.counterevidence])).rows[0]?.quote).toBeNull();
    const read = await store.readEvidence(evidenceId);
    expect(JSON.stringify(read)).not.toContain(canary);
    expect(read?.items[1]?.selector).toEqual({ start: 4, end: 20, range: { start: 4, end: 20 }, digest });
    expect(read?.items[0]?.selector).toEqual({ field: 'releaseDate' });
    expect(read?.manifestDigest).toBe(manifestBefore);
    const retried = await store.recordEvidence(principal, evidenceKey, claim, evidenceInput);
    expect(retried.replayed).toBe(true);
    expect(JSON.stringify(retried)).not.toContain(canary);
    expect(retried.evidence.manifestDigest).toBe(manifestBefore);

    await expect(store.recordEvidence(principal, randomUUID(), native(), { claimRevision, expectedHead: null,
      items: [{ stance: 'supports', contentRevision: cited, selector: { exact: canary },
        availability: 'available' }] })).rejects.toBeInstanceOf(VerificationInvalid);
    const coordinates = await store.recordEvidence(principal, randomUUID(), native(), {
      claimRevision, expectedHead: null, items: [{ stance: 'uncertain', contentRevision: cited,
        selector: { start: 4, end: 20, digest }, availability: 'erased' }] });
    expect(coordinates.evidence.items[0]?.selector).toEqual({ start: 4, end: 20, digest });
    expect(JSON.stringify(await store.readEvidence(kept.evidence.revision.split('/').at(-1)!))).toContain(otherCanary);
    expect((await pool.query<{ open: string[] | null }>(
      `SELECT array_agg(revision_id::text) AS open FROM verification.open_evidence_source_revisions($1::uuid[])`,
      [[cited]])).rows[0]?.open).toBeNull();

    await pool.query('BEGIN');
    await pool.query(`SET LOCAL session_replication_role = replica`);
    await pool.query(`UPDATE verification.evidence_item SET selector = $2::jsonb
      WHERE revision_id = $1 AND ordinal = 1`, [evidenceId, JSON.stringify(selector)]);
    await pool.query('COMMIT');
    expect((await pool.query(`SELECT selector::text AS selector FROM verification.evidence_item
      WHERE revision_id = $1 AND ordinal = 1`, [evidenceId])).rows[0]?.selector).toContain(canary);
    expect(JSON.stringify(await store.readEvidence(evidenceId))).not.toContain(canary);
    expect(await erase(pool, cited, erasureId, '7')).toBe(1);
    expect((await pool.query(`SELECT selector::text AS selector FROM verification.evidence_item
      WHERE revision_id = $1 AND ordinal = 1`, [evidenceId])).rows[0]?.selector).not.toContain(canary);

    const dump = join(source.state, 'after.sql');
    execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', String(source.port), '-U', source.user,
      '-d', 'postgres', '--no-owner', '--no-privileges', '-f', dump]);
    expect(readFileSync(dump, 'utf8')).not.toContain(canary);
    expect(readFileSync(dump, 'utf8')).toContain(authoredNote);
    expect(readFileSync(dump, 'utf8')).toContain(otherCanary);
  } finally { await source.stop(); }
}, 90_000);
