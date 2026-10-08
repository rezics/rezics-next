import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { appendContentEvent } from '../../content/src/event-sequencer.ts';
import { migrateContent } from '../../content/src/migrate.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { journalErasure, markErasureBlocked, markErasureSuppressed }
  from '../src/modules/erasure/journal.ts';
import { completePendingContentErasures, ErasureService, OPEN_SOURCE_PROBE } from '../src/modules/erasure/request.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

// Component evidence: real PostgreSQL for the relay journal, Content and the Access
// preservation tables; the native graph and the Account/Access admission are stubs.
// The positive cases assert the cleared end state unconditionally: they need the composed
// Content caller (quote union) and fail without it, which is the correct unwired result.
const root = resolve(import.meta.dir, '../../..');
const quote = 'OLD-QUOTE-ζ-source';
const authored = 'authored annotation stays';
const manifestDigest = 'cd'.repeat(32);

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
let cluster: { host: string; port: number; user: string };
let admin: Pool;
let stopCluster: () => Promise<void>;
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
  const pool = new Pool({ ...cluster, database: name, max: 6 });
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
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  const user = process.env.USER ?? execFileSync('whoami', { encoding: 'utf8' }).trim();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  cluster = { host: '127.0.0.1', port, user };
  admin = new Pool({ ...cluster, database: 'postgres', max: 2 });
  stopCluster = async () => {
    await env?.pool.end();
    await old?.pool.end();
    await admin.end();
    try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
    finally { rmSync(state, { recursive: true, force: true }); }
  };
  env = await database('remediation_main', false);
  old = await database('remediation_legacy', true);
}, 120_000);

afterAll(async () => { await stopCluster?.(); });

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

import { Elysia } from 'elysia';
import { OwnerOperations, OwnerOperationBusy, OwnerOperationConflict, OwnerOperationInvalid,
  OwnerOperationMissing, OwnerOperationUnavailable } from '../src/modules/owner/operations.ts';
import { verifyErasure } from '../src/modules/erasure/reconcile.ts';
import { ownerRoutes } from '../src/routes/owners.ts';

const finishInventory = (target: Env) => completePendingContentErasures(target.service, graph, {
  register: async () => undefined, claim: async () => undefined, recordGraphOutcome: async () => undefined,
  activePrincipalId: async () => randomUUID() } as never);

/** Owner relay, erasure journal, Content and Access are four separate pools, each with one connection. */
function ownerOperations() {
  const pools = ['owner', 'journal', 'content', 'access'].map(() =>
    new Pool({ ...cluster, database: 'remediation_main', max: 1 }));
  const [owner, journal, content, access] = pools as [Pool, Pool, Pool, Pool];
  const service = new ErasureService(journal, content, access);
  return { ops: new OwnerOperations(owner, graph, undefined, undefined, undefined, service),
    owner, service, close: () => Promise.all(pools.map(pool => pool.end())) };
}
const within = <T>(work: Promise<T>) => Promise.race([work, new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error('owner operation did not finish: pool deadlock')), 20_000))]);
const recorded = async (key: string) => (await env.pool.query(
  'SELECT 1 FROM relay.owner_reconciliation WHERE operation_id = $1', [`owner:erasure:${key}`])).rowCount;

test('with separate max-1 owner pools the per-erasure operation remediates, records existing findings and replays by key', async () => {
  const fixture = await oldErasure(env);
  await finishInventory(env);
  const before = await snapshot(fixture);
  const { ops, close } = ownerOperations();
  try {
    const first = await within(ops.reconcileErasure({ erasureId: fixture.erasureId }, 'k-first'));
    expect(first).toMatchObject({ kind: 'erasure', erasure: fixture.erasureId, disposition: 'erased', replayed: false });
    expect(['held', 'reconciled']).toContain(first.state);
    await expectCleared(fixture, before);
    expect(await within(ops.reconcileErasure({ erasureId: fixture.erasureId }, 'k-first')))
      .toEqual({ ...first, replayed: true });
    expect((await env.pool.query<{ kind: string; erasure_id: string }>(
      'SELECT kind, erasure_id::text FROM relay.owner_reconciliation WHERE operation_id = $1',
      ['owner:erasure:k-first'])).rows).toEqual([{ kind: 'erasure', erasure_id: fixture.erasureId }]);
    await expect(within(ops.reconcileErasure({ erasureId: randomUUID() }, 'k-first'))).rejects
      .toBeInstanceOf(OwnerOperationConflict);
    await expect(within(ops.reconcileErasure({ erasureId: randomUUID() }, 'k-missing'))).rejects
      .toBeInstanceOf(OwnerOperationMissing);
    const clean = await oldErasure(env, { quotes: false });
    await finishInventory(env);
    expect(await within(ops.reconcileErasure({ erasureId: clean.erasureId }, 'k-clean')))
      .toMatchObject({ disposition: 'erased', replayed: false });
  } finally { await close(); }
}, 120_000);

test('every non-cleared, non-clean remediation is refused with a typed error, records nothing and can retry under the same key', async () => {
  const { ops, close } = ownerOperations();
  try {
    const wrongEpoch = await oldErasure(env, { quotes: false, tombstone: false });
    await env.pool.query(`UPDATE content.revision SET availability = 'erased', serialized_bytes = NULL, body = NULL
      WHERE id = $1`, [wrongEpoch.revisions[0]]);
    await env.pool.query(`INSERT INTO content.revision_erasure (revision_id, erasure_id, erasure_epoch)
      VALUES ($1, $2, $3)`, [wrongEpoch.revisions[0], wrongEpoch.erasureId, String(BigInt(wrongEpoch.epoch) + 1000n)]);
    const held = await oldErasure(env);
    await env.pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
      VALUES ($1, $2, 'legal hold')`, [randomUUID(), held.resource]);
    const native = await oldErasure(env);
    nativeSuppressed.delete(native.revisions[0]!);
    const wide = await oldErasure(env, { revisions: 65 });
    const malformed = await oldErasure(env, { mismatchedOperation: true, quotes: false });
    const unapplied = await oldErasure(env, { tombstone: false });
    await finishInventory(env);
    const cases: [string, Fixture, unknown][] = [
      ['wrong-epoch', wrongEpoch, OwnerOperationInvalid], ['held', held, OwnerOperationBusy],
      ['native', native, OwnerOperationUnavailable], ['graph-limit', wide, OwnerOperationUnavailable],
      ['malformed', malformed, OwnerOperationInvalid], ['unapplied', unapplied, OwnerOperationInvalid]];
    for (const [key, fixture, error] of cases) {
      const before = await snapshot(fixture);
      await expect(within(ops.reconcileErasure({ erasureId: fixture.erasureId }, key))).rejects
        .toBeInstanceOf(error as never);
      expect(await recorded(key)).toBe(0);
      expect(await snapshot(fixture)).toBe(before);
    }
    expect((await sources(held)).comment?.exact).toBe(quote);
    // A wrong-epoch entry without any quote is stale at remediation, so the verifier is never reached.
    await expect(within(ops.reconcileErasure({ erasureId: wrongEpoch.erasureId }, 'wrong-epoch'))).rejects
      .toThrow('stale');
    // Even called directly, the verifier no longer accepts it: the tombstone's epoch is checked.
    const direct = await verifyErasure(env.service.relay, { content: env.pool }, wrongEpoch.erasureId, 'direct-wrong-epoch');
    expect(direct.state).toBe('held');
    expect(await env.pool.query(`SELECT disposition FROM relay.owner_reconciliation_item i
      JOIN relay.owner_reconciliation r ON r.id = i.reconciliation_id
      WHERE r.operation_id = 'direct-wrong-epoch' AND i.item_kind = 'revision'`).then(result => result.rows))
      .toEqual([{ disposition: 'conflict' }]);
  } finally { await close(); }
}, 180_000);

test('the owners route keeps its authority, idempotency key and recorded result for kind erasure and maps refusals', async () => {
  const fixture = await oldErasure(env);
  const held = await oldErasure(env);
  await finishInventory(env);
  await env.pool.query(`INSERT INTO access.governance_preservation_hold (id, target_resource, reason)
    VALUES ($1, $2, 'legal hold')`, [randomUUID(), held.resource]);
  const { ops, close } = ownerOperations();
  try {
    let active: string | null = randomUUID();
    const work = { account: { verify: async () => ({}) }, access: { activePrincipalId: async () => active },
      ownerOperations: ops } as never;
    const app = new Elysia().use(ownerRoutes(work));
    const post = (body: unknown, key: string | null = 'route-key') => within(app.handle(new Request(
      'http://owners.invalid/v1/owners/reconciliations', { method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: JSON.stringify(body) })));
    const body = { profile: 'owner-reconciliation-v1', kind: 'erasure', erasureId: fixture.erasureId };
    expect((await post(body, null)).status).toBe(400);
    const created = await post(body);
    expect(created.status).toBe(201);
    const json = await created.json() as { id: string };
    expect(json).toMatchObject({ kind: 'erasure', erasure: fixture.erasureId, disposition: 'erased', replayed: false });
    const replay = await post(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: json.id, replayed: true });
    expect((await post({ ...body, extra: 1 })).status).toBe(422);
    expect((await post({ ...body, erasureId: 'not-a-uuid' })).status).toBe(422);
    expect((await post({ ...body, erasureId: held.erasureId }, 'route-held')).status).toBe(409);
    active = null;
    expect((await post(body, 'other-key')).status).toBe(403);
  } finally { await close(); }
}, 120_000);
