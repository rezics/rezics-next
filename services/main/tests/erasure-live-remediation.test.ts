import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { appendContentEvent } from '../../content/src/event-sequencer.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import * as contentErasure from '../src/modules/erasure/content.ts';
import { journalErasure, markErasureSuppressed, markErasureBlocked, readErasure }
  from '../src/modules/erasure/journal.ts';
import { completePendingContentErasures, ErasureService, remediateErasedContentSources,
  requestContentErasure, SOURCE_REMEDIATION_WINDOW } from '../src/modules/erasure/request.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

// Component evidence: real PostgreSQL for the relay journal, Content and the Access
// preservation tables; the native graph and the Account/Access admission are stubs.
// Clearing a stored source needs the composed Content caller (open-source union).
// Without it the same call must report `failed`, never `cleared`.
const unionWired = 'openSourceRevisions' in contentErasure;
const root = resolve(import.meta.dir, '../../..');
const quote = 'OLD-QUOTE-ζ-source';
const authored = 'authored annotation stays';

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

let state = '';
let pool: Pool;
let stopCluster: () => Promise<void>;
const queries: string[] = [];
let nativeSuppressed = new Set<string>();

class StubGraph extends FusekiClient {
  constructor() { super('http://erasure-live-remediation.invalid'); }
  override async query(sparql: string) {
    const targets = [...sparql.matchAll(/urn:rezics:content:revision:([0-9a-f-]{36})/g)].map(match => match[1]!);
    const known = targets.length > 0 && targets.every(id => nativeSuppressed.has(id));
    return { results: { bindings: known ? [...new Set(targets)].map(id => ({
      target: { type: 'uri', value: `urn:rezics:content:revision:${id}` },
      sequence: { type: 'literal', value: '5' },
      receiptEpoch: { type: 'literal', value: graph.lineage.dataEpoch },
      currentSequence: { type: 'literal', value: '9' } })) : [] } } as never;
  }
}
const graph = { fuseki: undefined as unknown as FusekiClient,
  lineage: { dataEpoch: randomUUID(), routingEpoch: randomUUID() } } as WorkActivationEnvironment;
let service: ErasureService;

beforeAll(async () => {
  state = join(root, '.temp', `erasure-live-remediation-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  const user = process.env.USER ?? execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  pool = new Pool({ host: '127.0.0.1', port, user, database: 'postgres', max: 8 });
  stopCluster = async () => {
    await pool.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  };
  await migrateContent(pool);
  const relayDirectory = join(root, 'services/main/migrations/relay');
  for (const file of schemaFiles(root, 'relay')) await pool.query(readFileSync(join(relayDirectory, file), 'utf8'));
  await pool.query(`CREATE SCHEMA access;
    CREATE TABLE access.governance_preservation_hold (
      id uuid PRIMARY KEY, target_resource text NOT NULL, reason text NOT NULL, released_at timestamptz);
    CREATE TABLE access.governance_erasure_postponement (
      hold_id uuid NOT NULL, operation_id text NOT NULL, material_ref text NOT NULL,
      reason text NOT NULL, PRIMARY KEY (hold_id, operation_id, material_ref))`);
  (graph as { fuseki: FusekiClient }).fuseki = new StubGraph();
  const recording = new Proxy(pool, { get(target, property, receiver) {
    if (property === 'query') return (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return target.query(sql, values);
    };
    const value = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as Pool;
  service = new ErasureService(recording, pool, pool);
}, 120_000);

afterAll(async () => { await stopCluster?.(); });

interface Fixture {
  erasureId: string; epoch: string; resource: string; revisions: string[];
  comments: string[]; evidence: string;
}

/** An erasure that completed before source clearing existed: tombstone and erased bytes only. */
async function oldErasure(options: { revisions?: number; quotes?: boolean; stage?: 'fenced' | 'requested' | 'blocked';
  kind?: 'revision' | 'resource'; targetKind?: 'content_revision' | 'object'; tombstone?: boolean;
  suppress?: boolean } = {}): Promise<Fixture> {
  const count = options.revisions ?? 1;
  const resource = `https://rezics.com/id/${randomUUID()}`;
  const variant = `urn:rezics:variant:${randomUUID()}`;
  await pool.query(`INSERT INTO content.variant (id, resource_id, language_kind, direction)
    VALUES ($1, $2, 'zxx', 'none')`, [variant, resource]);
  const revisions: string[] = [];
  for (let at = 0; at < count; at++) {
    const id = randomUUID();
    const bytes = Buffer.from(JSON.stringify({ body: `text ${at}` }));
    await pool.query(`INSERT INTO content.revision (id, variant_id, operation_id, format, model, provenance,
      byte_digest, byte_length, serialized_bytes, body)
      VALUES ($1, $2, $3, 'rezics-content-json-v1', 'fixture', '{}', $4, $5, $6, $7::jsonb)`,
    [id, variant, `op-${id}`, createHash('sha256').update(bytes).digest('hex'), bytes.length, bytes,
      JSON.stringify({ body: `text ${at}` })]);
    revisions.push(id);
  }
  const targetKind = options.targetKind ?? 'content_revision';
  const journaled = await journalErasure(service.relay, { operationId: `erasure:${randomUUID()}`,
    requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
    kind: options.kind ?? 'revision', principalId: randomUUID(), admissionId: randomUUID(),
    authorityEpoch: '1', targets: revisions.map(ref => ({ kind: targetKind, ref })) });
  if (options.stage === 'blocked') await markErasureBlocked(service.relay, journaled.erasureId, 'deferred');
  else if (options.suppress !== false && options.stage !== 'requested') {
    await markErasureSuppressed(service.relay, journaled.erasureId);
  }
  const comments: string[] = [];
  const principal = randomUUID();
  const claim = `https://rezics.com/id/${randomUUID()}`;
  let evidence = '';
  if (options.quotes !== false) {
    for (const revisionId of revisions.slice(0, 1)) {
      const operation = `content-comment:${randomUUID()}`;
      const commentId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendContentEvent(client, { operationId: operation, requestDigest: 'ab'.repeat(32),
          action: 'comment.create', outcome: 'succeeded', variantId: variant, revisionId,
          eventType: 'content.comment.created', recipe: 'content-body-v1',
          payload: { comment: commentId, revisionId } });
        await client.query(`INSERT INTO content.comment (id, operation_id, request_digest, revision_id,
          resource_id, variant_id, author, exact, prefix, suffix, body)
          VALUES ($1, $2, $3, $4, $5, $6, 'urn:rezics:work:a', $7, 'pre', 'suf', $8)`,
        [commentId, operation, 'ab'.repeat(32), revisionId, resource, variant, quote, authored]);
        evidence = randomUUID();
        const receipt = randomUUID();
        await client.query(`INSERT INTO verification.receipt (id, principal_id, action, idempotency_key,
          request_digest, outcome, result_id) VALUES ($1, $2, 'evidence.record', $3, $4, 'succeeded', $5)`,
        [receipt, principal, `k-${evidence}`, 'cd'.repeat(32), evidence]);
        await client.query(`INSERT INTO verification.evidence_set_revision (id, claim, claim_revision, purpose,
          predecessor, item_count, manifest_digest, operation_id, principal_id)
          VALUES ($1, $2, $2, 'challenge', NULL, 1, $3, $4, $5)`,
        [evidence, claim, 'cd'.repeat(32), receipt, principal]);
        await client.query(`INSERT INTO verification.evidence_item (revision_id, ordinal, stance,
          content_revision_id, selector, availability) VALUES ($1, 0, 'supports', $2, $3::jsonb, 'available')`,
        [evidence, revisionId, JSON.stringify({ kind: 'TextQuoteSelector', exact: quote, start: 3, end: 9 })]);
        await client.query('COMMIT');
        comments.push(commentId);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  }
  if (options.tombstone !== false) {
    for (const id of revisions) {
      await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
        WHERE id = $1`, [id]);
      await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
        VALUES ($1, $2, $3)`, [id, journaled.erasureId, journaled.erasureEpoch]);
    }
  }
  nativeSuppressed = new Set([...nativeSuppressed, ...revisions]);
  return { erasureId: journaled.erasureId, epoch: journaled.erasureEpoch, resource, revisions, comments, evidence };
}

async function stored(fixture: Fixture) {
  const comment = (await pool.query<{ exact: string | null; body: string }>(
    'SELECT exact, body FROM content.comment WHERE revision_id = $1', [fixture.revisions[0]])).rows[0];
  const item = (await pool.query<{ selector: Record<string, unknown> }>(
    'SELECT selector FROM verification.evidence_item WHERE revision_id = $1', [fixture.evidence])).rows[0];
  return { comment, selector: item?.selector };
}

async function journalRow(erasureId: string) {
  return JSON.stringify((await pool.query('SELECT * FROM relay.erasure WHERE id = $1', [erasureId])).rows[0]);
}
async function tombstones(fixture: Fixture) {
  return JSON.stringify((await pool.query(`SELECT revision_id, erasure_id, erasure_epoch
    FROM content.revision_erasure WHERE erasure_id = $1 ORDER BY revision_id`, [fixture.erasureId])).rows);
}
const only = (window: Awaited<ReturnType<typeof remediateErasedContentSources>>, fixture: Fixture) =>
  window.entries.find(entry => entry.erasureId === fixture.erasureId)!;
const after = (fixture: Fixture) => String(BigInt(fixture.epoch) - 1n);

test('an old erased quote is cleared under its own journal id and epoch, once, and nothing else changes', async () => {
  const fixture = await oldErasure();
  expect((await stored(fixture)).comment?.exact).toBe(quote);
  const journalBefore = await journalRow(fixture.erasureId);
  const tombstoneBefore = await tombstones(fixture);
  const window = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  const entry = only(window, fixture);
  const after1 = await stored(fixture);
  if (unionWired) {
    expect(entry.outcome).toBe('cleared');
    expect(entry.cleared).toEqual(fixture.revisions);
    expect(after1.comment?.exact).toBeNull();
    expect(after1.selector).toEqual({ start: 3, end: 9 });
    expect(window.unresolved).toEqual([]);
    const again = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
    expect(only(again, fixture).outcome).toBe('clean');
  } else {
    // The caller that clears sources is not composed: a failed clear is reported, never counted.
    expect(entry.outcome).toBe('failed');
    expect(window.unresolved).toEqual([fixture.erasureId]);
    expect(after1.comment?.exact).toBe(quote);
  }
  expect(after1.comment?.body).toBe(authored);
  expect(await journalRow(fixture.erasureId)).toBe(journalBefore);
  expect(await tombstones(fixture)).toBe(tombstoneBefore);
  expect((await readErasure(service.relay, fixture.erasureId)).erasureEpoch).toBe(fixture.epoch);
});

test('a clean entry is inspected without a write and a repeat of the window is idempotent', async () => {
  const fixture = await oldErasure({ quotes: false });
  const journalBefore = await journalRow(fixture.erasureId);
  const first = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  const second = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  expect(only(first, fixture).outcome).toBe('clean');
  expect(second).toEqual(first);
  expect(await journalRow(fixture.erasureId)).toBe(journalBefore);
});

test('a raw window of at most 100 journal rows plus one look-ahead is consumed in epoch order with every outcome reported', async () => {
  const start = (await pool.query<{ epoch: string }>('SELECT coalesce(max(erasure_epoch), 0)::text AS epoch FROM relay.erasure'))
    .rows[0]!.epoch;
  const clean = await oldErasure({ quotes: false });
  const foreign = await oldErasure({ kind: 'resource', targetKind: 'object', quotes: false, tombstone: false });
  const blocked = await oldErasure({ stage: 'blocked', quotes: false, tombstone: false });
  const pending = await oldErasure({ stage: 'requested', quotes: false, tombstone: false });
  const malformed = await oldErasure({ targetKind: 'object', quotes: false, tombstone: false });
  queries.length = 0;
  const first = await remediateErasedContentSources(service, graph, { after: start, limit: 3 });
  expect(first.inspected).toBe(3);
  expect(first.entries.map(entry => [entry.erasureId, entry.outcome])).toEqual([
    [clean.erasureId, 'clean'], [foreign.erasureId, 'foreign'], [blocked.erasureId, 'blocked']]);
  expect(first.next).toBe(blocked.epoch);
  const listing = queries.filter(sql => sql.includes('WHERE erasure_epoch > $1'));
  expect(listing).toHaveLength(1);
  expect(listing[0]).not.toMatch(/count\(|SKIP LOCKED|FILTER|OFFSET/i);
  const second = await remediateErasedContentSources(service, graph, { after: first.next!, limit: 100 });
  expect(second.entries.map(entry => [entry.erasureId, entry.outcome])).toEqual([
    [pending.erasureId, 'pending'], [malformed.erasureId, 'malformed']]);
  expect(second.next).toBeNull();
  expect(second.unresolved).toEqual([malformed.erasureId]);
  const exact = await remediateErasedContentSources(service, graph, { after: start, limit: 5 });
  expect(exact.inspected).toBe(5);
  expect(exact.next).toBeNull();
  const clamped = await remediateErasedContentSources(service, graph, { after: start, limit: 100_000 });
  expect(clamped.inspected).toBeLessThanOrEqual(SOURCE_REMEDIATION_WINDOW);
  await expect(remediateErasedContentSources(service, graph, { after: '01' })).rejects.toThrow('cursor');
  await expect(remediateErasedContentSources(service, graph, { after: '-1' })).rejects.toThrow('cursor');
});

test('a current preservation hold changes nothing and a released hold lets the same entry clear', async () => {
  const fixture = await oldErasure();
  const holdId = randomUUID();
  await pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
    VALUES ($1, $2, 'legal hold')`, [holdId, fixture.resource]);
  const journalBefore = await journalRow(fixture.erasureId);
  const held = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  expect(only(held, fixture).outcome).toBe('held');
  expect(held.unresolved).toEqual([fixture.erasureId]);
  expect((await stored(fixture)).comment?.exact).toBe(quote);
  expect(await journalRow(fixture.erasureId)).toBe(journalBefore);
  expect((await pool.query(`SELECT reason FROM access.governance_erasure_postponement WHERE hold_id = $1`,
    [holdId])).rows[0]?.reason).toBe('legal hold');
  await pool.query('UPDATE access.governance_preservation_hold SET released_at = now() WHERE id = $1', [holdId]);
  const released = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  expect(only(released, fixture).outcome).toBe(unionWired ? 'cleared' : 'failed');
});

test('a wrong tombstone, an unerased target or a missing native proof fails before any change, and nothing is erased for the first time', async () => {
  const wrongId = await oldErasure({ tombstone: false });
  await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [wrongId.revisions[0]]);
  await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [wrongId.revisions[0], randomUUID(), wrongId.epoch]);
  const wrongEpoch = await oldErasure({ tombstone: false });
  await pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
    WHERE id = $1`, [wrongEpoch.revisions[0]]);
  await pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
    VALUES ($1, $2, $3)`, [wrongEpoch.revisions[0], wrongEpoch.erasureId, String(BigInt(wrongEpoch.epoch) + 1000n)]);
  const unapplied = await oldErasure({ tombstone: false });
  const nativeGone = await oldErasure();
  nativeSuppressed.delete(nativeGone.revisions[0]!);
  const window = await remediateErasedContentSources(service, graph, { after: after(wrongId), limit: 100 });
  const outcome = (fixture: Fixture) => only(window, fixture).outcome;
  expect(outcome(wrongId)).toBe('stale');
  expect(outcome(wrongEpoch)).toBe('stale');
  expect(outcome(unapplied)).toBe('unapplied');
  expect(outcome(nativeGone)).toBe('native');
  for (const fixture of [wrongId, wrongEpoch, unapplied, nativeGone]) {
    expect((await stored(fixture)).comment?.exact).toBe(quote);
  }
  expect((await pool.query(`SELECT availability FROM content.revision WHERE id = $1`,
    [unapplied.revisions[0]])).rows[0]?.availability).toBe('available');
  expect((await pool.query('SELECT 1 FROM content.revision_erasure WHERE revision_id = $1',
    [unapplied.revisions[0]])).rowCount).toBe(0);
  expect(window.unresolved).toEqual(expect.arrayContaining([wrongId.erasureId, wrongEpoch.erasureId, unapplied.erasureId,
    nativeGone.erasureId]));
});

test('65 targets are reported as the graph limit, 256 are journaled, and a 257th target is refused by the journal', async () => {
  const wide = await oldErasure({ revisions: 65 });
  const window = await remediateErasedContentSources(service, graph, { after: after(wide), limit: 1 });
  expect(only(window, wide).outcome).toBe('graph-limit');
  expect((await stored(wide)).comment?.exact).toBe(quote);
  const widest = await oldErasure({ revisions: 256, quotes: false });
  expect((await readErasure(service.relay, widest.erasureId)).targets).toHaveLength(256);
  const clean = await remediateErasedContentSources(service, graph, { after: after(widest), limit: 1 });
  expect(only(clean, widest).outcome).toBe('clean');
  await expect(pool.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
    VALUES ($1, 257, 'content', 'content_revision', $2)`, [widest.erasureId, randomUUID()]))
    .rejects.toMatchObject({ code: '23514' });
}, 60_000);

test('a failed clear rolls back as one transaction, is reported unresolved, and the retry completes it', async () => {
  const fixture = await oldErasure();
  await pool.query(`CREATE FUNCTION public.refuse_evidence_clear() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected evidence failure'; END $$`);
  await pool.query(`CREATE TRIGGER refuse_evidence_clear BEFORE UPDATE ON verification.evidence_item
    FOR EACH ROW EXECUTE FUNCTION public.refuse_evidence_clear()`);
  try {
    const failed = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
    expect(only(failed, fixture).outcome).toBe('failed');
    expect(failed.unresolved).toEqual([fixture.erasureId]);
    expect((await stored(fixture)).comment?.exact).toBe(quote);
  } finally {
    await pool.query('DROP TRIGGER refuse_evidence_clear ON verification.evidence_item');
    await pool.query('DROP FUNCTION public.refuse_evidence_clear()');
  }
  const retried = await remediateErasedContentSources(service, graph, { after: after(fixture), limit: 1 });
  expect(only(retried, fixture).outcome).toBe(unionWired ? 'cleared' : 'failed');
});

test('the same-key replay reaches an old entry, and the pending reconciler keeps its result and leaves old quotes alone', async () => {
  const fixture = await oldErasure();
  const operation = (await pool.query<{ operation_id: string }>(
    'SELECT operation_id FROM relay.erasure WHERE id = $1', [fixture.erasureId])).rows[0]!.operation_id;
  const admission = operation.slice('erasure:'.length);
  const access = {
    register: async () => ({ id: admission, state: 'sealed', principalId: randomUUID(), replayed: true,
      authorityEpoch: '1', requestDigest: 'x', scope: `erasure:${fixture.resource}` }),
    claim: async () => undefined, recordGraphOutcome: async () => undefined,
    activePrincipalId: async () => randomUUID() };
  const account = { verify: async () => ({}) };
  // Pending reconciler: a fenced entry is finished exactly as before and its old quote is untouched.
  const pending = await completePendingContentErasures(service, graph, access as never);
  expect(pending.failed).not.toContain(fixture.erasureId);
  expect(typeof pending.completed).toBe('number');
  expect((await stored(fixture)).comment?.exact).toBe(quote);
  const replay = () => requestContentErasure(service, graph, account as never, access as never,
    new Request('http://erasure.invalid'), { actingSubject: fixture.resource, resourceId: fixture.resource,
      revisionIds: fixture.revisions, idempotencyKey: 'replay' });
  if (unionWired) {
    const replayed = await replay();
    expect(replayed.replayed).toBe(true);
    expect(replayed.report.erasureId).toBe(fixture.erasureId);
    expect((await stored(fixture)).comment?.exact).toBeNull();
  } else {
    // Without the composed caller the replay cannot clear and says so instead of succeeding.
    await expect(replay()).rejects.toThrow('sources remain');
    expect((await stored(fixture)).comment?.exact).toBe(quote);
  }
});
