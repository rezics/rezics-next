import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { appendContentEvent } from '../../content/src/event-sequencer.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ContentErasureStale } from '../src/modules/erasure/content.ts';
import { GraphErasureUnavailable } from '../src/modules/erasure/graph.ts';
import { journalErasure, markErasureBlocked, markErasureSuppressed, readErasure }
  from '../src/modules/erasure/journal.ts';
import { completePendingContentErasures, ErasureService, OPEN_SOURCE_PROBE,
  remediateErasedContentEntry, remediateErasedContentSources, requestContentErasure,
  SOURCE_REMEDIATION_WINDOW, type SourceRemediationEntry } from '../src/modules/erasure/request.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

// Component evidence: real PostgreSQL for the relay journal, Content and the Access
// preservation tables; the native graph and the Account/Access admission are stubs.
// The positive cases assert the cleared end state unconditionally: they need the composed
// Content caller (quote union) and fail without it, which is the correct unwired result.
const root = resolve(import.meta.dir, '../../..');
const quote = 'OLD-QUOTE-ζ-source';
const authored = 'authored annotation stays';
const manifestDigest = 'cd'.repeat(32);

let state = '';
let cluster: PostgresCluster | undefined;
let admin: Pool;
let nativeSuppressed = new Set<string>();
const lineage = { dataEpoch: randomUUID(), routingEpoch: randomUUID() };

class StubGraph extends FusekiClient {
  constructor() { super('http://erasure-live-remediation.invalid'); }
  override async query(sparql: string) {
    const targets = [...sparql.matchAll(/urn:rezics:content:revision:([0-9a-f-]{36})/g)].map(match => match[1]!);
    const known = targets.length > 0 && targets.every(id => nativeSuppressed.has(id));
    return { results: { bindings: known ? [...new Set(targets)].map(id => ({
      target: { type: 'uri', value: `urn:rezics:content:revision:${id}` },
      sequence: { type: 'literal', value: '5' },
      receiptEpoch: { type: 'literal', value: lineage.dataEpoch },
      currentSequence: { type: 'literal', value: '9' } })) : [] } } as never;
  }
}
const graph = { fuseki: new StubGraph(), lineage } as unknown as WorkActivationEnvironment;

interface Env { pool: Pool; service: ErasureService; queries: string[]; upgrade(): Promise<void> }

/** `legacy` installs Content without migrations 1708 and 1709, as a database that predates source clearing. */
async function database(name: string, legacy: boolean): Promise<Env> {
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ ...cluster!.connection, database: name, max: 6 });
  const queries: string[] = [];
  let content = join(root, 'services/content/migrations');
  if (legacy) {
    content = join(state, `${name}-pre`);
    mkdirSync(content, { recursive: true });
    for (const file of readdirSync(join(root, 'services/content/migrations'))) {
      if (!/^(1708|1709)_/.test(file)) copyFileSync(join(root, 'services/content/migrations', file), join(content, file));
    }
  }
  await migrateContent(pool, content);
  const relayDirectory = join(root, 'services/main/migrations/relay');
  for (const file of schemaFiles(root, 'relay')) await pool.query(readFileSync(join(relayDirectory, file), 'utf8'));
  await pool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
      reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
  const recording = new Proxy(pool, { get(target, property, receiver) {
    if (property === 'query') return (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return target.query(sql, values);
    };
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  return { pool, service: new ErasureService(recording, pool, pool), queries,
    upgrade: async () => { await migrateContent(pool); } };
}

let env: Env;
let old: Env;

beforeAll(async () => {
  state = join(root, '.temp', `erasure-live-remediation-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  cluster = await startPostgresCluster();
  admin = new Pool({ ...cluster.connection, max: 2 });
  env = await database('remediation_main', false);
  old = await database('remediation_legacy', true);
}, 120_000);

afterAll(async () => {
  await env?.pool.end();
  await old?.pool.end();
  await admin?.end();
  try { cluster?.remove(); }
  finally { if (state) rmSync(state, { recursive: true, force: true }); }
});

interface Fixture {
  erasureId: string; epoch: string; admission: string; resource: string; revisions: string[];
  evidence: string; receiptDigest: string; env: Env;
}
interface Options {
  revisions?: number; quotes?: boolean; stage?: 'requested' | 'blocked'; kind?: 'revision' | 'resource';
  targetKind?: 'content_revision' | 'object'; tombstone?: boolean; mismatchedOperation?: boolean;
  clean?: number;
}

/** An erasure that completed before source clearing existed: tombstone and erased bytes only. */
async function oldErasure(target: Env, options: Options = {}): Promise<Fixture> {
  const { pool, service } = target;
  const count = options.revisions ?? 1;
  const resource = `https://rezics.com/id/${randomUUID()}`;
  const variant = `urn:rezics:variant:${randomUUID()}`;
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, resource]);
  const ids = Array.from({ length: count }, () => randomUUID());
  await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
    byte_digest, byte_length, serialized_bytes, body)
    SELECT id, $2, 'op-' || id, 'rezics-content-json-v1', 'fixture', '{}', $3, 2, '\\x7b7d'::bytea, '{}'::jsonb
    FROM unnest($1::uuid[]) AS id`, [ids, variant, createHash('sha256').update('{}').digest('hex')]);
  const admission = randomUUID();
  const journaled = await journalErasure(service.relay, {
    operationId: options.mismatchedOperation ? `erasure:${randomUUID()}` : `erasure:${admission}`,
    requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    kind: options.kind ?? 'revision', principalId: randomUUID(), admissionId: admission,
    authorityEpoch: '1', targets: ids.map(ref => ({ kind: options.targetKind ?? 'content_revision', ref })) });
  if (options.stage === 'blocked') await markErasureBlocked(service.relay, journaled.erasureId, 'deferred');
  else if (options.stage !== 'requested') await markErasureSuppressed(service.relay, journaled.erasureId);
  let evidence = '';
  if (options.quotes !== false) {
    const revisionId = ids[0]!;
    const operation = `content-comment:${randomUUID()}`;
    const commentId = randomUUID();
    const principal = randomUUID();
    const claim = `https://rezics.com/id/${randomUUID()}`;
    evidence = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await appendContentEvent(client, { operationId: operation, requestDigest: 'ab'.repeat(32),
        action: 'comment.create', outcome: 'succeeded', variantId: variant, revisionId,
        eventType: 'content.comment.created', recipe: 'content-body-v1', payload: { comment: commentId, revisionId } });
      await client.query(`INSERT INTO content.comment (id, operation_id, request_digest, revision_id,
        resource_id, variant_id, author, exact, prefix, suffix, body)
        VALUES ($1, $2, $3, $4, $5, $6, 'urn:rezics:work:a', $7, 'pre', 'suf', $8)`,
      [commentId, operation, 'ab'.repeat(32), revisionId, resource, variant, quote, authored]);
      const receipt = randomUUID();
      await client.query(`INSERT INTO verification.receipt (id, principal_id, action, idempotency_key,
        request_digest, outcome, result_id) VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`,
      [receipt, principal, `k-${evidence}`, manifestDigest, evidence]);
      await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
        predecessor, item_count, manifest_digest, operation_id, principal_id)
        VALUES ($1, $2, $2, 'challenge', NULL, 1, $3, $4, $5)`, [evidence, claim, manifestDigest, receipt, principal]);
      await client.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance,
        content_revision_id, selector, availability) VALUES ($1, 0, 'supports', $2, $3::jsonb, 'available')`,
      [evidence, revisionId, JSON.stringify({ kind: 'TextQuoteSelector', exact: quote, start: 3, end: 9 })]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  if (options.tombstone !== false) {
    await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      SELECT id, $2, $3 FROM unnest($1::uuid[]) AS id`, [ids, journaled.erasureId, journaled.erasureEpoch]);
  }
  nativeSuppressed = new Set([...nativeSuppressed, ...ids]);
  return { erasureId: journaled.erasureId, epoch: journaled.erasureEpoch, admission, resource, revisions: ids,
    evidence, receiptDigest: manifestDigest, env: target };
}

async function snapshot(fixture: Fixture) {
  const { pool } = fixture.env;
  return JSON.stringify({
    // The committed intent. Workflow progress (stage, destruction) may advance on a replay.
    journal: (await pool.query(`SELECT id, erasure_epoch, operation_id, request_digest, kind, authority,
      principal_id, admission_id, authority_epoch, suppression_status, suppressed_at
      FROM relay.erasure WHERE id = $1`, [fixture.erasureId])).rows[0],
    targets: (await pool.query('SELECT * FROM relay.erasure_target WHERE erasure_id = $1 ORDER BY ordinal',
      [fixture.erasureId])).rows,
    tombstones: (await pool.query(`SELECT revision_id, erasure_id, erasure_epoch FROM content.revision_erasure
      WHERE erasure_id = $1 ORDER BY revision_id`, [fixture.erasureId])).rows,
    revisions: (await pool.query(`SELECT id, availability, serialized_bytes IS NULL AS bytes_gone, body IS NULL AS body_gone
      FROM content.revision WHERE id = ANY($1::uuid[]) ORDER BY id`, [fixture.revisions])).rows,
  });
}

async function sources(fixture: Fixture) {
  const { pool } = fixture.env;
  const comment = (await pool.query<{ exact: string | null; prefix: string | null; suffix: string | null; body: string }>(
    'SELECT exact, prefix, suffix, body FROM content.comment WHERE revision_id = $1', [fixture.revisions[0]])).rows[0];
  const item = (await pool.query<{ selector: Record<string, unknown> }>(
    'SELECT selector FROM verification.evidence_item WHERE revision_id = $1', [fixture.evidence])).rows[0];
  const open = (await pool.query<{ revision_id: string }>(OPEN_SOURCE_PROBE, [fixture.revisions])).rows;
  return { comment, selector: item?.selector, open: open.map(row => row.revision_id) };
}

/** The cleared end state: no source, identity and authored note kept, digests and journal untouched. */
async function expectCleared(fixture: Fixture, before: string) {
  const end = await sources(fixture);
  expect(end.comment).toEqual({ exact: null, prefix: null, suffix: null, body: authored });
  expect(end.selector).toEqual({ start: 3, end: 9 });
  expect(JSON.stringify(end)).not.toContain(quote);
  expect(end.open).toEqual([]);
  expect(await snapshot(fixture)).toBe(before);
  const { pool } = fixture.env;
  expect((await pool.query(`SELECT manifest_digest FROM verification.evidence_set_revision WHERE id = $1`,
    [fixture.evidence])).rows[0]?.manifest_digest).toBe(fixture.receiptDigest);
  expect((await pool.query(`SELECT request_digest FROM verification.receipt WHERE result_id = $1`,
    [fixture.evidence])).rows[0]?.request_digest).toBe(fixture.receiptDigest);
}
async function expectStillOpen(fixture: Fixture, before: string) {
  const end = await sources(fixture);
  expect(end.comment).toEqual({ exact: quote, prefix: 'pre', suffix: 'suf', body: authored });
  expect(end.selector).toMatchObject({ exact: quote });
  expect(end.open).toEqual([fixture.revisions[0]]);
  expect(await snapshot(fixture)).toBe(before);
}

const run = (fixture: Fixture, limit = 1) => remediateErasedContentSources(fixture.env.service, graph,
  { after: String(BigInt(fixture.epoch) - 1n), limit });
const entryOf = (window: { entries: SourceRemediationEntry[] }, fixture: Fixture) =>
  window.entries.find(entry => entry.erasureId === fixture.erasureId)!;

test('real rows that predate migrations 1708 and 1709 are migrated, then cleared under their own journal id and epoch', async () => {
  const fixture = await oldErasure(old);
  // Before the upgrade the database has neither the source-clearing columns nor the probes.
  expect((await old.pool.query(`SELECT to_regprocedure('verification.erase_evidence_sources(uuid[],uuid,bigint)') AS f`))
    .rows[0]?.f).toBeNull();
  await old.upgrade();
  const before = await snapshot(fixture);
  await expectStillOpen(fixture, before);
  const window = await run(fixture);
  expect(entryOf(window, fixture)).toEqual({ erasureId: fixture.erasureId, erasureEpoch: fixture.epoch,
    outcome: 'cleared', cleared: fixture.revisions });
  expect(window.unresolved).toEqual([]);
  await expectCleared(fixture, before);
  expect(entryOf(await run(fixture), fixture).outcome).toBe('clean');
  await expectCleared(fixture, before);
}, 60_000);

test('the open-source probe is indexed: many clean rows are never visited', async () => {
  const principal = randomUUID();
  const claim = `https://rezics.com/id/${randomUUID()}`;
  const set = async (contentRevision: string, count: number, source: boolean) => {
    const client = await env.pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID(); const receipt = randomUUID();
      await client.query(`INSERT INTO verification.receipt (id, principal_id, action, idempotency_key,
        request_digest, outcome, result_id) VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`,
      [receipt, principal, `k-${id}`, manifestDigest, id]);
      await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
        predecessor, item_count, manifest_digest, operation_id, principal_id)
        VALUES ($1, $2, $2, 'challenge', NULL, $3, $4, $5, $6)`, [id, claim, count, manifestDigest, receipt, principal]);
      await client.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance, content_revision_id,
        selector, availability) SELECT $1, g, 'supports', $2,
          CASE WHEN $3 THEN jsonb_build_object('exact', 'bulk', 'start', g) ELSE jsonb_build_object('start', g) END,
          'available' FROM generate_series(0, $4::int - 1) AS g`, [id, contentRevision, source, count]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  };
  // An erased revision whose evidence is only coordinates and whose comments are already cleared.
  const quiet = await oldErasure(env, { quotes: false });
  const quietRevision = quiet.revisions[0]!;
  const quietVariant = (await env.pool.query<{ variant_id: string }>(
    'SELECT variant_id FROM content.revision WHERE id = $1', [quietRevision])).rows[0]!.variant_id;
  for (let sets = 0; sets < 60; sets++) await set(quietRevision, 32, false);
  await env.pool.query(`INSERT INTO content.receipt (operation_id, request_digest, action, outcome, variant_id, revision_id)
    SELECT 'quiet-' || g, repeat('ab', 32), 'comment.create', 'succeeded', $1, $2 FROM generate_series(1, 200) g`,
  [quietVariant, quietRevision]);
  await env.pool.query(`INSERT INTO content.comment (id, operation_id, request_digest, revision_id, resource_id,
    variant_id, author, exact, prefix, suffix, body)
    SELECT gen_random_uuid(), operation_id, request_digest, revision_id, $3, variant_id, 'urn:rezics:work:a',
      NULL, NULL, NULL, $4 FROM content.receipt WHERE operation_id LIKE 'quiet-%' AND revision_id = $1
        AND variant_id = $2`, [quietRevision, quietVariant, quiet.resource, authored]);
  // A revision whose source rows were written while it was open, then cleared to terminal.
  const closing = await oldErasure(env, { quotes: false, tombstone: false });
  const closingRevision = closing.revisions[0]!;
  for (let sets = 0; sets < 30; sets++) await set(closingRevision, 32, true);
  await env.pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [closingRevision]);
  await env.pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch) VALUES ($1, $2, $3)`,
    [closingRevision, closing.erasureId, closing.epoch]);
  expect((await env.pool.query<{ cleared: number }>(
    'SELECT verification.erase_evidence_sources($1::uuid[], $2::uuid, $3::bigint) AS cleared',
    [[closingRevision], closing.erasureId, closing.epoch])).rows[0]?.cleared).toBe(960);
  await env.pool.query('ANALYZE verification.evidence_item');
  await env.pool.query('ANALYZE content.comment');
  const client = await env.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = (await client.query<Record<string, string>>(`EXPLAIN (ANALYZE, FORMAT TEXT) ${OPEN_SOURCE_PROBE}`,
      [[quietRevision, closingRevision]])).rows.map(row => row['QUERY PLAN']).join('\n');
    await client.query('ROLLBACK');
    expect(plan).toContain('evidence_item_open_source');
    expect(plan).toContain('evidence_item_terminal_source');
    expect(plan).toContain('comment_open_source_idx');
    // Each relation is reached only through its partial index; the only filter is the outer id list.
    expect(plan).not.toMatch(/Seq Scan|Bitmap Heap Scan|Index Scan using/);
    expect(plan.match(/Index Only Scan using/g)).toHaveLength(3);
    expect(plan.match(/Rows Removed by Filter/g)).toHaveLength(1);
    expect(plan).toMatch(/Function Scan on unnest wanted[\s\S]*?Rows Removed by Filter: 2/);
  } finally { client.release(); }
  expect(entryOf(await run(quiet), quiet).outcome).toBe('clean');
  expect(entryOf(await run(closing), closing).outcome).toBe('clean');
}, 120_000);

test('a raw window of at most 100 journal rows plus one look-ahead is consumed in epoch order with every outcome reported', async () => {
  const start = (await env.pool.query<{ epoch: string }>('SELECT coalesce(max(erasure_epoch), 0)::text AS epoch FROM relay.erasure'))
    .rows[0]!.epoch;
  const clean = await oldErasure(env, { quotes: false });
  const foreign = await oldErasure(env, { kind: 'resource', targetKind: 'object', quotes: false, tombstone: false });
  const blocked = await oldErasure(env, { stage: 'blocked', quotes: false, tombstone: false });
  const pending = await oldErasure(env, { stage: 'requested', quotes: false, tombstone: false });
  const malformed = await oldErasure(env, { targetKind: 'object', quotes: false, tombstone: false });
  const unrelated = await oldErasure(env, { mismatchedOperation: true, quotes: false });
  env.queries.length = 0;
  const first = await remediateErasedContentSources(env.service, graph, { after: start, limit: 3 });
  expect(first.inspected).toBe(3);
  expect(first.entries.map(entry => [entry.erasureId, entry.outcome])).toEqual([
    [clean.erasureId, 'clean'], [foreign.erasureId, 'foreign'], [blocked.erasureId, 'blocked']]);
  expect(first.next).toBe(blocked.epoch);
  const listing = env.queries.filter(sql => sql.includes('WHERE erasure_epoch > $1'));
  expect(listing).toHaveLength(1);
  expect(listing[0]).not.toMatch(/count\(|SKIP LOCKED|FILTER|OFFSET/i);
  const second = await remediateErasedContentSources(env.service, graph, { after: first.next!, limit: 100 });
  expect(second.entries.map(entry => [entry.erasureId, entry.outcome])).toEqual([
    [pending.erasureId, 'pending'], [malformed.erasureId, 'malformed'], [unrelated.erasureId, 'malformed']]);
  expect(second.next).toBeNull();
  expect(second.unresolved).toEqual([malformed.erasureId, unrelated.erasureId]);
  const exact = await remediateErasedContentSources(env.service, graph, { after: start, limit: 6 });
  expect(exact.inspected).toBe(6);
  expect(exact.next).toBeNull();
  const clamped = await remediateErasedContentSources(env.service, graph, { after: start, limit: 100_000 });
  expect(clamped.inspected).toBeLessThanOrEqual(SOURCE_REMEDIATION_WINDOW);
  await expect(remediateErasedContentSources(env.service, graph, { after: '01' })).rejects.toThrow('cursor');
  await expect(remediateErasedContentSources(env.service, graph, { after: '-1' })).rejects.toThrow('cursor');
}, 60_000);

test('a current preservation hold changes nothing, a released hold lets the same entry clear', async () => {
  const fixture = await oldErasure(env);
  const holdId = randomUUID();
  await env.pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
    VALUES ($1, $2, 'legal hold')`, [holdId, fixture.resource]);
  const before = await snapshot(fixture);
  const held = await run(fixture);
  expect(entryOf(held, fixture).outcome).toBe('held');
  expect(held.unresolved).toEqual([fixture.erasureId]);
  await expectStillOpen(fixture, before);
  expect((await env.pool.query(`SELECT reason FROM access.governance_erasure_postponement WHERE hold_id = $1`,
    [holdId])).rows[0]?.reason).toBe('legal hold');
  await env.pool.query('UPDATE access.governance_preservation_hold SET released_at = now() WHERE id = $1', [holdId]);
  expect(entryOf(await run(fixture), fixture).outcome).toBe('cleared');
  await expectCleared(fixture, before);
}, 60_000);

test('a wrong tombstone, an unerased target or a missing native proof fails before any change, and nothing is erased for the first time', async () => {
  const wrongId = await oldErasure(env, { tombstone: false });
  await env.pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [wrongId.revisions[0]]);
  await env.pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [wrongId.revisions[0], randomUUID(), wrongId.epoch]);
  const wrongEpoch = await oldErasure(env, { tombstone: false });
  await env.pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [wrongEpoch.revisions[0]]);
  await env.pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [wrongEpoch.revisions[0], wrongEpoch.erasureId, String(BigInt(wrongEpoch.epoch) + 1000n)]);
  // The same epoch fault on an entry that stores no quote: stale at remediation all the same.
  const wrongEpochClean = await oldErasure(env, { quotes: false, tombstone: false });
  await env.pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [wrongEpochClean.revisions[0]]);
  await env.pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [wrongEpochClean.revisions[0], wrongEpochClean.erasureId,
    String(BigInt(wrongEpochClean.epoch) + 1000n)]);
  const unapplied = await oldErasure(env, { tombstone: false });
  const nativeGone = await oldErasure(env);
  nativeSuppressed.delete(nativeGone.revisions[0]!);
  const befores = new Map<Fixture, string>();
  for (const fixture of [wrongId, wrongEpoch, unapplied, nativeGone]) befores.set(fixture, await snapshot(fixture));
  const window = await remediateErasedContentSources(env.service, graph,
    { after: String(BigInt(wrongId.epoch) - 1n), limit: 100 });
  expect(entryOf(window, wrongId).outcome).toBe('stale');
  expect(entryOf(window, wrongEpoch).outcome).toBe('stale');
  expect(entryOf(window, wrongEpochClean).outcome).toBe('stale');
  expect(entryOf(window, unapplied).outcome).toBe('unapplied');
  expect(entryOf(window, nativeGone).outcome).toBe('native');
  for (const [fixture, before] of befores) {
    const end = await sources(fixture);
    expect(end.comment?.exact).toBe(quote);
    expect(await snapshot(fixture)).toBe(before);
  }
  expect((await env.pool.query(`SELECT availability FROM content.revision WHERE id = $1`,
    [unapplied.revisions[0]])).rows[0]?.availability).toBe('available');
  expect(window.unresolved).toEqual(expect.arrayContaining([wrongId.erasureId, wrongEpoch.erasureId,
    unapplied.erasureId, nativeGone.erasureId]));
}, 60_000);

test('65 targets are reported as the graph limit, 256 are journaled and probed, and a 257th target is refused by the journal', async () => {
  const wide = await oldErasure(env, { revisions: 65 });
  const before = await snapshot(wide);
  expect(entryOf(await run(wide), wide).outcome).toBe('graph-limit');
  await expectStillOpen(wide, before);
  const widest = await oldErasure(env, { revisions: 256, quotes: false });
  expect((await readErasure(env.service.relay, widest.erasureId)).targets).toHaveLength(256);
  expect(entryOf(await run(widest), widest).outcome).toBe('clean');
  await expect(env.pool.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 257, 'content', 'content_revision', $2)`, [widest.erasureId, randomUUID()]))
    .rejects.toMatchObject({ code: '23514' });
}, 120_000);

test('a failed clear rolls back as one transaction, is reported unresolved, and the retry completes it', async () => {
  const fixture = await oldErasure(env);
  const before = await snapshot(fixture);
  await env.pool.query(`CREATE FUNCTION public.refuse_evidence_clear() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected evidence failure'; END $$`);
  await env.pool.query(`CREATE TRIGGER refuse_evidence_clear BEFORE UPDATE ON verification.evidence_item
    FOR EACH ROW EXECUTE FUNCTION public.refuse_evidence_clear()`);
  try {
    const failed = await run(fixture);
    expect(entryOf(failed, fixture).outcome).toBe('failed');
    expect(failed.unresolved).toEqual([fixture.erasureId]);
    await expectStillOpen(fixture, before);
  } finally {
    await env.pool.query('DROP TRIGGER refuse_evidence_clear ON verification.evidence_item');
    await env.pool.query('DROP FUNCTION public.refuse_evidence_clear()');
  }
  expect(entryOf(await run(fixture), fixture).outcome).toBe('cleared');
  await expectCleared(fixture, before);
}, 60_000);

test('the 5 second deadline is shared by every operation of one apply, and exceeding it rolls everything back', async () => {
  const fixture = await oldErasure(env);
  const before = await snapshot(fixture);
  await env.pool.query(`CREATE FUNCTION public.slow_clear() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$`);
  await env.pool.query(`CREATE TRIGGER slow_comment BEFORE UPDATE ON content.comment
    FOR EACH ROW EXECUTE FUNCTION public.slow_clear()`);
  await env.pool.query(`CREATE TRIGGER slow_evidence BEFORE UPDATE ON verification.evidence_item
    FOR EACH ROW EXECUTE FUNCTION public.slow_clear()`);
  try {
    // 3 s for the comment clear plus 3 s for the evidence clear: each alone fits 5 s, together they do not.
    const started = Date.now();
    const slow = await run(fixture);
    expect(Date.now() - started).toBeLessThan(5_900);
    expect(entryOf(slow, fixture).outcome).toBe('failed');
    await expectStillOpen(fixture, before);
  } finally {
    await env.pool.query('DROP TRIGGER slow_comment ON content.comment');
    await env.pool.query('DROP TRIGGER slow_evidence ON verification.evidence_item');
    await env.pool.query('DROP FUNCTION public.slow_clear()');
  }
  expect(entryOf(await run(fixture), fixture).outcome).toBe('cleared');
  await expectCleared(fixture, before);
}, 60_000);

function replayOf(fixture: Fixture) {
  const access = {
    register: async () => ({ id: fixture.admission, state: 'sealed', principalId: randomUUID(), replayed: true,
      authorityEpoch: '1', requestDigest: 'x', scope: `erasure:${fixture.resource}` }),
    claim: async () => undefined, recordGraphOutcome: async () => undefined,
    activePrincipalId: async () => randomUUID() };
  const account = { verify: async () => ({}) };
  return {
    access,
    call: () => requestContentErasure(fixture.env.service, graph, account as never, access as never,
      new Request('http://erasure.invalid'), { actingSubject: fixture.resource, resourceId: fixture.resource,
        revisionIds: fixture.revisions, idempotencyKey: 'replay' }),
  };
}

test('the same-key replay clears an old entry and never reports success while a source remains', async () => {
  const cleared = await oldErasure(env);
  const clearedBefore = await snapshot(cleared);
  const replayed = await replayOf(cleared).call();
  expect(replayed.replayed).toBe(true);
  expect(replayed.report.erasureId).toBe(cleared.erasureId);
  await expectCleared(cleared, clearedBefore);

  const held = await oldErasure(env);
  const holdId = randomUUID();
  await env.pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
    VALUES ($1, $2, 'legal hold')`, [holdId, held.resource]);
  const native = await oldErasure(env);
  nativeSuppressed.delete(native.revisions[0]!);
  const wide = await oldErasure(env, { revisions: 65 });
  const malformed = await oldErasure(env, { mismatchedOperation: true });
  const unapplied = await oldErasure(env, { tombstone: false });
  const cases: [Fixture, unknown][] = [
    [held, ContentErasureStale], [native, GraphErasureUnavailable], [wide, GraphErasureUnavailable],
    [unapplied, ContentErasureStale]];
  for (const [fixture, error] of cases) {
    const before = await snapshot(fixture);
    await expect(replayOf(fixture).call()).rejects.toBeInstanceOf(error as never);
    await expectStillOpen(fixture, before);
  }
  // A broken retained intent relation cannot even be replayed under its own key.
  const malformedBefore = await snapshot(malformed);
  await expect(replayOf(malformed).call()).rejects.toThrow();
  expect((await sources(malformed)).comment?.exact).toBe(quote);
  expect(await snapshot(malformed)).toBe(malformedBefore);
}, 120_000);

test('the pending reconciler keeps its result and leaves old quotes alone', async () => {
  const fixture = await oldErasure(env);
  const before = await snapshot(fixture);
  const { access } = replayOf(fixture);
  const pending = await completePendingContentErasures(env.service, graph, access as never);
  expect(pending.failed).not.toContain(fixture.erasureId);
  expect(typeof pending.completed).toBe('number');
  await expectStillOpen(fixture, before);
}, 60_000);

test('an owner holding the only relay connection remediates through it, never checking out a second', async () => {
  const fixture = await oldErasure(env);
  const before = await snapshot(fixture);
  const single = new Pool({ ...cluster!.connection, database: 'remediation_main', max: 1 });
  const client = await single.connect();
  try {
    const owned = new ErasureService(single, env.pool, env.pool);
    const entry = await Promise.race([remediateErasedContentEntry(owned, graph, fixture.erasureId, client),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('journal read waited for the pool')), 15_000))]);
    expect(entry.outcome).toBe('cleared');
    await expectCleared(fixture, before);
    // The helper leaves the borrowed client usable and in the caller's hands.
    expect((await client.query('SELECT 1 AS ok')).rows[0]?.ok).toBe(1);
  } finally {
    client.release();
    await single.end();
  }
}, 60_000);

test('a single entry is remediated on demand by id', async () => {
  const fixture = await oldErasure(env);
  const before = await snapshot(fixture);
  const entry = await remediateErasedContentEntry(env.service, graph, fixture.erasureId);
  expect(entry).toEqual({ erasureId: fixture.erasureId, erasureEpoch: fixture.epoch, outcome: 'cleared',
    cleared: fixture.revisions });
  await expectCleared(fixture, before);
  await expect(remediateErasedContentEntry(env.service, graph, randomUUID())).rejects.toThrow('unavailable');
}, 60_000);
