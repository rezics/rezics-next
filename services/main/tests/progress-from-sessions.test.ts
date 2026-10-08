import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateContent } from '../../content/src/migrate.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { ReaderLibraryStatusStore } from '../src/modules/library/status.ts';
import { configureProgressCompletion, ProgressCompletionProjector, progressCompletion,
  type CompletionPlan, type CompletionPlanner } from '../src/modules/progress/completion.ts';
import { InvalidStructureProgress, StructureProgressStore } from '../src/modules/progress/store.ts';
import type { SessionSelection } from '../src/modules/session/contract.ts';
import { ConsumptionSessionStore, sessionCompletionSource } from '../src/modules/session/store.ts';

const root = resolve(import.meta.dir, '../../..');
const id = () => `https://rezics.com/id/${randomUUID()}`;
const principal = (): VerifiedPrincipal => ({ issuer: 'https://progress-from-sessions.test', subject: randomUUID() });
const order = (index: number) => `a\u0002${index.toString(36).padStart(4, '0')}`;

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

let state: string, data: string, pool: Pool;
beforeAll(async () => {
  state = join(root, '.temp', `progress-from-sessions-${randomUUID()}`);
  data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions', '--no-sync'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${socket}`, '-w', 'start'], { cwd: state });
  pool = new Pool({ host: '127.0.0.1', port, user: process.env.USER, database: 'postgres', max: 16 });
  await migrateContent(pool);
}, 120_000);
afterAll(async () => {
  await pool.end();
  try { execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state }); }
  finally { rmSync(state, { recursive: true, force: true }); }
});

/** One series of `chapters` placements under a stub of the graph. */
function series(chapters: number, options: { hidden?: Set<number>; seriesStructure?: boolean } = {}) {
  const structure = id(), revision = id(), work = id(), parent = id(), parentRevision = id();
  const occurrences = Array.from({ length: chapters }, id);
  const calls = { occurrence: 0, lastOf: 0 };
  const plan = (index: number): CompletionPlan => ({ structure, occurrence: occurrences[index]!,
    order: { revision, key: order(index), eligible: true },
    anchoring: options.seriesStructure ? { overflow: false, anchors: [{ structure: parent, through: structure,
      order: { revision: parentRevision, key: `a\u00020001\u0001${order(index)}`, eligible: true } }] }
      : { overflow: false, anchors: [] } });
  const planner: CompletionPlanner = {
    occurrence: async occurrence => {
      calls.occurrence++;
      const index = occurrences.indexOf(occurrence);
      return index < 0 || options.hidden?.has(index) ? null : plan(index);
    },
    lastOf: async target => { calls.lastOf++; return target === work ? plan(chapters - 1) : null; },
  };
  return { structure, revision, work, parent, parentRevision, occurrences, plan, planner, calls };
}

function stores(world: ReturnType<typeof series>) {
  const progress = new StructureProgressStore(pool);
  const library = new ReaderLibraryStatusStore(pool);
  const sessions = new ConsumptionSessionStore(pool, library);
  configureProgressCompletion(pool, new ProgressCompletionProjector(progress, pool, world.planner));
  return { progress, library, sessions };
}

const resume = async (progress: StructureProgressStore, world: ReturnType<typeof series>, reader: VerifiedPrincipal,
  structure = world.structure, revision = world.revision) =>
  (await progress.resumeCandidates(reader, structure, revision)).items.map(item => world.occurrences.indexOf(item.occurrence));

/** The Session pins one occurrence, but names a Work that has no composition,
 * so only the occurrence itself can move the reader's record. */
function sessionOn(world: ReturnType<typeof series>, occurrence: string, work: string | null): SessionSelection {
  return { target: { resource: occurrence, base: 'occurrence', work, revision: id(), types: [], disclosure: 'public' },
    language: null, format: null, progress: 'structure' };
}

let keys = 0;
const key = (label: string) => `${label}-${++keys}-${randomUUID()}`;
const finish = (sessions: ConsumptionSessionStore, reader: VerifiedPrincipal, agent: string, world: ReturnType<typeof series>,
  index: number, idempotencyKey = key('finish'), work = id()) =>
  sessions.write({ principal: reader, agent, target: world.occurrences[index]!, changes: { state: 'finished' },
    expectedVersion: 0, idempotencyKey }, async () => [sessionOn(world, world.occurrences[index]!, work)]);

async function complete(progress: StructureProgressStore, world: ReturnType<typeof series>, reader: VerifiedPrincipal,
  index: number, completed = true) {
  const current = await progress.read(reader, world.structure, world.occurrences[index]!);
  return progress.write({ principal: reader, structure: world.structure, occurrence: world.occurrences[index]!,
    order: world.plan(index).order, anchoring: world.plan(index).anchoring, completed, position: null,
    expectedVersion: current.version, idempotencyKey: key('direct') });
}

/** A Session cannot leave `finished` (a trigger refuses it), so the reopen is
 * written past that guard: it is the state a future reopen would leave behind,
 * reconciled by the same owner. */
async function setSessionState(session: string, value: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE reader.consumption_session DISABLE TRIGGER consumption_session_identity');
    await client.query(`UPDATE reader.consumption_session SET state = jsonb_set(jsonb_set(state, '{state}', $2::jsonb), '{completedAt}', $3::jsonb)
      WHERE id = $1`, [session, JSON.stringify(value), JSON.stringify(value === 'finished' ? '2026-10-08T00:00:00.000Z' : null)]);
    await client.query('ALTER TABLE reader.consumption_session ENABLE TRIGGER consumption_session_identity');
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function reopen(reader: VerifiedPrincipal, agent: string, session: string) {
  await setSessionState(session, 'active');
  await progressCompletion(pool)!.reconcile(sessionCompletionSource({ principal: reader, agent }, session));
}

test('a finished Session moves the resume position, and reopening it moves it back', async () => {
  const world = series(10), { progress, sessions } = stores(world);
  const reader = principal(), agent = id();
  // Clearing first: the finish is the only thing that says chapter 3 was read.
  await complete(progress, world, reader, 3);
  await complete(progress, world, reader, 3, false);
  expect(await resume(progress, world, reader)).toEqual([]);
  const first = await finish(sessions, reader, agent, world, 3);
  expect(await resume(progress, world, reader)).toEqual([3]);
  await finish(sessions, reader, agent, world, 6);
  expect(await resume(progress, world, reader)).toEqual([6, 3]);

  await reopen(reader, agent, first.id);
  expect(await resume(progress, world, reader)).toEqual([6]);
  const second = (await sessions.page({ principal: reader, agent }, { target: world.occurrences[6]! })).items[0]!;
  await reopen(reader, agent, second.id);
  expect(await resume(progress, world, reader)).toEqual([]);
  // Reopening again, or reconciling a Session that never held, changes nothing.
  const versions = await pool.query('SELECT sum(version) AS total FROM structure.progress WHERE principal_subject = $1', [reader.subject]);
  await reopen(reader, agent, first.id);
  expect((await pool.query('SELECT sum(version) AS total FROM structure.progress WHERE principal_subject = $1',
    [reader.subject])).rows).toEqual(versions.rows);
});

test('a Library read finishes the Work and moving it back undoes only that', async () => {
  const world = series(10), { progress, library } = stores(world);
  const reader = principal(), agent = id();
  const read = await library.write({ agent, work: world.work, status: 'read', expectedVersion: 0, idempotencyKey: key('read'), principal: reader });
  expect(await resume(progress, world, reader)).toEqual([9]);
  const reading = await library.write({ agent, work: world.work, status: 'reading', expectedVersion: read.version,
    idempotencyKey: key('reading'), principal: reader });
  expect(await resume(progress, world, reader)).toEqual([]);
  // The completion of the same placement that the reader recorded stays.
  await complete(progress, world, reader, 9);
  const again = await library.write({ agent, work: world.work, status: 'read', expectedVersion: reading.version, idempotencyKey: key('read'), principal: reader });
  await library.write({ agent, work: world.work, status: null, expectedVersion: again.version, idempotencyKey: key('clear'), principal: reader });
  expect(await resume(progress, world, reader)).toEqual([9]);
  // A write that carries no verified reader cannot project.
  const other = principal();
  await library.write({ agent: id(), work: world.work, status: 'read', expectedVersion: 0, idempotencyKey: key('anonymous') });
  expect(await resume(progress, world, other)).toEqual([]);
});

test('a direct completion recorded before or after a hold stays when the source lets go', async () => {
  const world = series(10), { progress, sessions } = stores(world);
  const reader = principal(), agent = id();
  await complete(progress, world, reader, 2);
  const before = await finish(sessions, reader, agent, world, 2);
  expect(await resume(progress, world, reader)).toEqual([2]);
  await reopen(reader, agent, before.id);
  expect(await resume(progress, world, reader)).toEqual([2]);

  const held = await finish(sessions, reader, agent, world, 5);
  await complete(progress, world, reader, 5, false);
  await complete(progress, world, reader, 5);
  await reopen(reader, agent, held.id);
  expect(await resume(progress, world, reader)).toEqual([5, 2]);

  // A completion the reader made on one revision of the chapter also stands.
  const revision = 'urn:rezics:content:revision:' + randomUUID();
  const selected = await finish(sessions, reader, agent, world, 7);
  await progress.write({ principal: reader, structure: world.structure, occurrence: world.occurrences[7]!,
    selectedRevision: revision, order: world.plan(7).order, completed: true, position: null,
    expectedVersion: 0, idempotencyKey: key('revision') });
  await reopen(reader, agent, selected.id);
  expect(await resume(progress, world, reader)).toContain(7);
});

test('a Session and a Library read holding the same placement release it only when both have', async () => {
  const world = series(10), { progress, library, sessions } = stores(world);
  const reader = principal(), agent = id();
  const session = await finish(sessions, reader, agent, world, 9, key('finish'), world.work);
  // The finish also marked the Work read, so the end is held twice.
  expect(await resume(progress, world, reader)).toEqual([9]);
  const status = (await library.batch(agent, [world.work]))[0]!;
  expect(status.status).toBe('read');
  await library.write({ agent, work: world.work, status: 'reading', expectedVersion: status.version, idempotencyKey: key('reading'), principal: reader });
  expect(await resume(progress, world, reader)).toEqual([9]);
  await reopen(reader, agent, session.id);
  expect(await resume(progress, world, reader)).toEqual([]);
});

test('anchors on the enclosing series follow the hold and the release', async () => {
  const world = series(10, { seriesStructure: true }), { progress, sessions } = stores(world);
  const reader = principal(), agent = id();
  const session = await finish(sessions, reader, agent, world, 4);
  const anchor = async () => (await progress.resumeCandidates(reader, world.parent, world.parentRevision)).items.length;
  expect(await anchor()).toBe(1);
  await reopen(reader, agent, session.id);
  expect(await anchor()).toBe(0);
});

test('concurrent finishes and reopens settle on the committed state of the source', async () => {
  const world = series(10), { progress, sessions } = stores(world);
  const reader = principal(), agent = id();
  const session = await finish(sessions, reader, agent, world, 4);
  const source = () => progressCompletion(pool)!.reconcile(sessionCompletionSource({ principal: reader, agent }, session.id));
  const setState = (value: string) => setSessionState(session.id, value);
  for (let round = 0; round < 4; round++) {
    await setState('active');
    await Promise.all([source(), source(), (async () => { await setState('finished'); await source(); })(), source()]);
    expect(await resume(progress, world, reader)).toEqual([4]);
    await Promise.all([source(), (async () => { await setState('active'); await source(); })(), source(), source()]);
    expect(await resume(progress, world, reader)).toEqual([]);
  }
  // One completion per placement and source, however many commands raced.
  const receipts = await pool.query(`SELECT count(*)::int AS count FROM structure.progress_command
    WHERE principal_subject = $1 AND starts_with(idempotency_key, 'projection:') AND substr(idempotency_key, 60, 1) = 'h'`, [reader.subject]);
  const holds = await pool.query(`SELECT count(*)::int AS count FROM structure.progress_command
    WHERE principal_subject = $1 AND starts_with(idempotency_key, 'projection:') AND substr(idempotency_key, 60, 1) = 'r'`, [reader.subject]);
  expect(receipts.rows[0].count).toBe(holds.rows[0].count);
});

test('a replayed finish adds no second completion', async () => {
  const world = series(10), { progress, sessions } = stores(world);
  const reader = principal(), agent = id();
  const idempotencyKey = key('replay');
  const first = await finish(sessions, reader, agent, world, 4, idempotencyKey, world.work);
  const read = () => pool.query(`SELECT occurrence, version::text AS version FROM structure.progress
    WHERE principal_subject = $1 AND structure = $2 ORDER BY occurrence`, [reader.subject, world.structure]);
  const saved = (await read()).rows;
  const receipts = () => pool.query(`SELECT count(*)::int AS count FROM structure.progress_command
    WHERE principal_subject = $1`, [reader.subject]);
  const count = (await receipts()).rows[0].count;
  const replay = await finish(sessions, reader, agent, world, 4, idempotencyKey, world.work);
  expect(replay).toMatchObject({ id: first.id, replayed: true });
  await Promise.all([finish(sessions, reader, agent, world, 4, idempotencyKey, world.work),
    finish(sessions, reader, agent, world, 4, idempotencyKey, world.work)]);
  expect((await read()).rows).toEqual(saved);
  expect((await receipts()).rows[0].count).toBe(count);
  expect(await resume(progress, world, reader)).toEqual([9, 4]);
});

test('a placement the reader cannot hold is not projected, and nothing is revealed', async () => {
  const world = series(10, { hidden: new Set([4]) }), { progress, library, sessions } = stores(world);
  const reader = principal(), neighbour = principal(), agent = id();
  const elsewhere = id();
  const foreign = await sessions.write({ principal: reader, agent, target: elsewhere, changes: { state: 'finished' },
    expectedVersion: 0, idempotencyKey: key('foreign') }, async () => [sessionOn(world, elsewhere, id())]);
  const unreadable = await finish(sessions, reader, agent, world, 4);
  const stranger = id();
  await library.write({ agent, work: stranger, status: 'read', expectedVersion: 0, idempotencyKey: key('stranger'), principal: reader });
  expect([foreign.state, unreadable.state]).toEqual(['finished', 'finished']);
  expect((await pool.query('SELECT count(*)::int AS count FROM structure.progress WHERE principal_subject = $1',
    [reader.subject])).rows[0].count).toBe(0);
  expect(await resume(progress, world, reader)).toEqual([]);
  // The record belongs to its reader: another reader's finish never lands in it.
  await finish(sessions, neighbour, id(), world, 2);
  expect(await resume(progress, world, reader)).toEqual([]);
  expect(await resume(progress, world, neighbour)).toEqual([2]);
  // The ledger prefix is the owner's: a reader's own key cannot forge a hold.
  await expect(progress.write({ principal: reader, structure: world.structure, occurrence: world.occurrences[0]!,
    completed: true, position: null, expectedVersion: 0, idempotencyKey: `projection:${'0'.repeat(48)}h1` }))
    .rejects.toBeInstanceOf(InvalidStructureProgress);
});

test('the projection costs the same statements and graph reads in a 10- and a 1,000-chapter series', async () => {
  const measure = async (chapters: number) => {
    const world = series(chapters), { sessions, library } = stores(world);
    const reader = principal(), agent = id();
    // A long history of the reader's own completions, mid-series, in the same range.
    await pool.query(`INSERT INTO structure.progress (principal_issuer, principal_subject, structure, occurrence,
        selection_key, completed, version, order_revision, order_key, resume_eligible)
      SELECT $1, $2, $3, 'https://rezics.com/id/' || gen_random_uuid(), '', true, 1, $4,
        'a' || chr(2) || 'x' || lpad(to_hex(n), 6, '0'), true FROM generate_series(1, $5::int) AS n`,
    [reader.issuer, reader.subject, world.structure, world.revision, chapters]);
    const statements: string[] = [];
    const query = pool.query.bind(pool), connect = pool.connect.bind(pool);
    const normal = (sql: unknown) => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : String((sql as { text?: string })?.text);
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      statements.push(normal(args[0]));
      return (query as (...inner: unknown[]) => unknown)(...args);
    };
    const clients = new Map<object, unknown>();
    (pool as unknown as { connect: unknown }).connect = async (...callback: unknown[]) => {
      // pg-pool's own query() connects with a callback; leave that path alone.
      if (callback.length) return (connect as (...inner: unknown[]) => unknown)(...callback);
      const client = await connect();
      if (!clients.has(client)) {
        const run = client.query.bind(client);
        clients.set(client, client.query);
        (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
          statements.push(normal(args[0]));
          return (run as (...inner: unknown[]) => unknown)(...args);
        };
      }
      return client;
    };
    const phases: Record<string, string[]> = {};
    try {
      const session = await finish(sessions, reader, agent, world, Math.floor(chapters / 2), key('measure'), world.work);
      phases.finish = statements.splice(0).filter(sql => /projection|progress|library/.test(sql));
      await reopen(reader, agent, session.id);
      phases.reopen = statements.splice(0);
      const status = (await library.batch(agent, [world.work]))[0]!;
      await library.write({ agent, work: world.work, status: 'reading', expectedVersion: status.version,
        idempotencyKey: key('measure-back'), principal: reader });
      phases.library = statements.splice(0);
    } finally {
      (pool as unknown as { query: unknown }).query = query;
      (pool as unknown as { connect: unknown }).connect = connect;
      for (const [client, original] of clients) (client as { query: unknown }).query = original;
    }
    return { phases, calls: { ...world.calls } };
  };
  const small = await measure(10), large = await measure(1000);
  expect(large.phases).toEqual(small.phases);
  expect(large.calls).toEqual(small.calls);
  expect(small.phases.finish!.length).toBeGreaterThan(5);
}, 120_000);
