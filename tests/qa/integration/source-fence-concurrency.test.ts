import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { recordRatingAggregateHead } from '../../../services/main/src/modules/access/rating-aggregate-inventory.ts';
import { alsoEnjoyedAccessFence, alsoEnjoyedContentFence }
  from '../../../services/main/src/modules/also-enjoyed/store.ts';
import { automaticDiscovery } from '../../../services/main/src/modules/discovery/automation.ts';
import { DiscoveryProjection, discoveryAccessCurrent, foldSourceFence, sourceChanges, sourceFence }
  from '../../../services/main/src/modules/discovery/store.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { ReaderLibraryStatusStore } from '../../../services/main/src/modules/library/status.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../../../services/main/src/modules/rating/global.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

// Source writers, builders and fences are the production code on real Access
// and Content PostgreSQL. Only the held transactions are paused by the test.
let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let access: Pool, content: Pool;
const native = () => `https://rezics.com/id/${randomUUID()}`;
const issuer = 'https://qa-source-fences.test';
const digest = () => randomUUID().replaceAll('-', '').repeat(2);

beforeAll(async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Use the QA integration tier');
  databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'content'], 'owner');
  access = new Pool({ connectionString: databases.urls.access, max: 12 });
  content = new Pool({ connectionString: databases.urls.content, max: 8 });
  expect((await access.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role).toBe('access');
  expect((await content.query<{ role: string }>('SELECT current_user AS role')).rows[0]?.role).toBe('content');
  await migrateContent(content);
}, 60_000);

afterAll(async () => {
  await access?.end();
  await content?.end();
  await databases?.close();
});

/** A pool whose matching transaction runs every statement, then waits at COMMIT. */
function holdCommit(pool: Pool, holds: (sql: string) => boolean = () => true) {
  let release!: () => void, reach!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { reach = resolve; });
  const held = new Proxy(pool, { get(target, key, receiver) {
    if (key !== 'connect') {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
    return async () => {
      const client = await target.connect();
      let matched = false;
      return new Proxy(client, { get(object, name, own) {
        const value = Reflect.get(object, name, own);
        if (name !== 'query') return typeof value === 'function' ? value.bind(object) : value;
        return async (...args: unknown[]) => {
          const sql = typeof args[0] === 'string' ? args[0] : '';
          matched ||= holds(sql);
          if (sql === 'COMMIT' && matched) { matched = false; reach(); await released; }
          return (value as (...a: unknown[]) => unknown).apply(object, args);
        };
      } });
    };
  } });
  return { pool: held, reached, release };
}

/** Wait until the held transaction pauses at COMMIT; fail if it finishes first. */
const paused = (reached: Promise<void>, work: Promise<unknown>) => Promise.race([reached,
  work.then(() => { throw new Error('The held transaction finished without pausing'); })]);

async function within<T>(work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  expect(performance.now() - started).toBeLessThan(1_000);
  return result;
}

async function voter() {
  const principal = { issuer, subject: randomUUID() };
  await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [randomUUID(), principal.issuer, principal.subject]);
  return principal;
}

const vote = (statement: string) => ({ statement, context: { kind: 'global' as const }, dimension: 'fit' as const,
  value: 1, expectedRevision: '0', idempotencyKey: randomUUID(), requestDigest: digest() });

/** One sealed global standing Context, ready for observation seals of one rater. */
async function ratingContext() {
  const principal = randomUUID(), actor = native(), context = native();
  const scope = `rating:observe:${context}`;
  await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [principal, issuer, randomUUID()]);
  await access.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [actor]);
  await access.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  const admitted = async (action: string) => {
    const id = randomUUID(), requestDigest = digest();
    await access.query(`INSERT INTO access.admission (id, principal_id, acting_subject, scope_id, action,
      idempotency_key, request_digest, authority_epoch, expires_at, state, claimed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,0,now() + interval '1 hour','claimed',now())`,
    [id, principal, actor, scope, action, randomUUID(), requestDigest]);
    return { id, action, principal_id: principal, acting_subject: actor, request_digest: requestDigest };
  };
  const created = await admitted('rating.context.create');
  await access.query(`INSERT INTO access.rating_aggregate_context (context, realm, revision, policy_revision, admission_id)
    VALUES ($1,$2,$3,$3,$4)`, [context, GLOBAL_RATING_POPULATION_OWNER, native(), created.id]);
  /** The seal's inventory write in its own transaction, as the admission seal runs it. */
  const seal = async (client: PoolClient) => {
    const admission = await admitted('rating.observation.set');
    const proof = { outcome: 'succeeded' as const, receipt: `urn:rezics:receipt:${randomUUID()}`,
      admissionId: admission.id, requestDigest: admission.request_digest, authorityEpoch: '0', scope,
      dataEpoch: randomUUID(), sequence: '1', context, realm: GLOBAL_RATING_POPULATION_OWNER,
      work: native(), mainVersion: native(), observation: native(), revision: native(),
      slot: `urn:rezics:rating-slot:${digest()}`, predecessor: null };
    await client.query("SELECT set_config('rezics.discovery_rating_outbox','on',true)");
    await recordRatingAggregateHead(client, admission, proof);
    await client.query("SELECT set_config('rezics.discovery_rating_outbox','off',true)");
  };
  return { seal };
}

async function begin(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '750ms'");
  return client;
}
async function end(client: PoolClient, outcome: 'COMMIT' | 'ROLLBACK') {
  try { await client.query(outcome); } finally { client.release(); }
}
const changes = async (pool: Pool, log: string) =>
  Number((await pool.query<{ count: string }>(`SELECT count(*)::text FROM ${log}`)).rows[0]!.count);

test('independent votes, rating seals and shelf changes commit within one second while one of each stays open', async () => {
  const shelves = new ReaderLibraryStatusStore(content);
  const shelf = (agent: string) => ({ agent, work: native(), status: 'reading' as const,
    expectedVersion: 0, idempotencyKey: randomUUID() });
  const ratings = await ratingContext();
  const [heldVoter, otherVoter] = [await voter(), await voter()];
  const before = { discovery: await changes(access, 'access.discovery_source_change'),
    signals: await changes(access, 'access.also_enjoyed_source_change'),
    shelves: await changes(content, 'reader.also_enjoyed_source_change') };

  const heldVote = holdCommit(access);
  const heldVoteDone = new AccessJudgments(heldVote.pool).write(heldVoter, vote(native()));
  const heldSeal = await begin(access), heldShelf = await begin(content);
  try {
    await paused(heldVote.reached, heldVoteDone);
    await ratings.seal(heldSeal);
    await shelves.write(shelf(native()), heldShelf);
    await within(() => new AccessJudgments(access).write(otherVoter, vote(native())));
    await within(async () => {
      const client = await begin(access);
      try { await ratings.seal(client); } catch (error) { await end(client, 'ROLLBACK'); throw error; }
      await end(client, 'COMMIT');
    });
    await within(() => shelves.write(shelf(native())));
    expect({ discovery: await changes(access, 'access.discovery_source_change'),
      signals: await changes(access, 'access.also_enjoyed_source_change'),
      shelves: await changes(content, 'reader.also_enjoyed_source_change') })
      .toEqual({ discovery: before.discovery + 1, signals: before.signals + 1, shelves: before.shelves + 1 });
  } finally {
    heldVote.release();
    await end(heldSeal, 'COMMIT');
    await end(heldShelf, 'COMMIT');
  }
  await heldVoteDone;
  expect({ discovery: await changes(access, 'access.discovery_source_change'),
    signals: await changes(access, 'access.also_enjoyed_source_change'),
    shelves: await changes(content, 'reader.also_enjoyed_source_change') })
    .toEqual({ discovery: before.discovery + 2, signals: before.signals + 2, shelves: before.shelves + 2 });
}, 60_000);

test('a vote commits while a discovery batch is committing, and the next staleness check reports it', async () => {
  const batch = holdCommit(access, sql => sql.includes('UPDATE access.discovery_generation SET checkpoint'));
  const projection = new DiscoveryProjection(batch.pool);
  const operator = automaticDiscovery(null);
  const basis = { scope: 'global' as const, realm: null, context: null };
  const position = { dataEpoch: randomUUID(), sequence: '1' };
  const key = () => ({ idempotencyKey: randomUUID(), requestDigest: digest() });
  const registered = await projection.register(operator, basis, position, key());
  const step = await projection.beginStep(operator, registered.generation_id, registered.checkpoint);
  const committing = projection.commitBatch(operator, registered.generation_id, step.lease, '',
    { after: '', complete: true, items: [] }, position);
  try {
    await paused(batch.reached, committing);
    await within(async () => new AccessJudgments(access).write(await voter(), vote(native())));
  } finally { batch.release(); }
  expect((await committing).complete).toBe(true);
  await projection.activate(operator, registered.generation_id, null, position, key());
  const read = await projection.active({ ...basis, owner: null }, position);
  expect(read.generation_id).toBe(registered.generation_id);
  expect(read.stale).toBe(true);

  // The next fold gives the committed vote its key above the generation's basis.
  const client = await access.connect();
  try {
    await client.query('BEGIN');
    const folded = await foldSourceFence(client);
    await client.query('COMMIT');
    expect(folded.changed).toBe(false);
    expect(BigInt(folded.revision)).toBe(BigInt(registered.access_revision) + 1n);
    expect(discoveryAccessCurrent(await sourceChanges(client, basis, folded.revision, 1))).toBe(true);
    expect(discoveryAccessCurrent(await sourceChanges(client, basis, registered.access_revision, 1))).toBe(false);
    // Mine projects no classifications, so no vote reaches it.
    expect(discoveryAccessCurrent(await sourceChanges(client, { scope: 'mine', realm: null },
      registered.access_revision, 1))).toBe(true);
  } finally { client.release(); }
}, 60_000);

test('a judgment reaches the bases of its context; a hint every Work there; a deactivation every basis', async () => {
  const [realm, otherRealm, statement, concept] = [native(), native(), native(), native()];
  const declarer = randomUUID();
  await access.query('INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1,$2,$3)',
    [declarer, issuer, randomUUID()]);
  const fold = async () => {
    const client = await begin(access);
    try { return (await foldSourceFence(client)).revision; } finally { await end(client, 'COMMIT'); }
  };
  const reach = async (scope: 'global' | 'realm' | 'mine', at: string, inRealm: string | null = null) => {
    const client = await begin(access);
    try {
      const since = await sourceChanges(client, { scope, realm: inRealm }, at, 2);
      return { wide: since.wide, statements: since.statements };
    } finally { await end(client, 'COMMIT'); }
  };
  const voted = await fold();
  await access.query(`INSERT INTO access.judgment_aggregate (statement, context_key, fit_positive)
    VALUES ($1, $2, 1)`, [statement, realm]);
  const hinted = await fold();
  expect(await reach('realm', voted, realm)).toEqual({ wide: false, statements: [statement] });
  expect(await reach('realm', voted, otherRealm)).toEqual({ wide: false, statements: [] });
  expect(await reach('global', voted)).toEqual({ wide: false, statements: [] });
  expect(await reach('realm', hinted, realm)).toEqual({ wide: false, statements: [] });

  await access.query(`INSERT INTO access.judgment_concept_hint (concept, context_key) VALUES ($1, 'global')`, [concept]);
  await access.query(`UPDATE access.judgment_concept_hint SET hint = 'minor', generation = 1,
    declared_by_principal = $2, updated_at = clock_timestamp() WHERE concept = $1 AND context_key = 'global'`,
  [concept, declarer]);
  const deactivated = await fold();
  expect(await reach('global', hinted)).toEqual({ wide: true, statements: [] });
  expect(await reach('realm', hinted, otherRealm)).toEqual({ wide: true, statements: [] });
  expect(await reach('mine', hinted)).toEqual({ wide: false, statements: [] });

  await access.query('UPDATE access.principal SET active = false WHERE id = $1', [declarer]);
  await fold();
  expect(await reach('mine', deactivated)).toEqual({ wide: true, statements: [] });
}, 30_000);

test('a shelf change outside read and reading is not a co-reader input', async () => {
  const shelves = new ReaderLibraryStatusStore(content);
  const before = await changes(content, 'reader.also_enjoyed_source_change');
  const wanted = { agent: native(), work: native(), status: 'want-to-read' as const,
    expectedVersion: 0, idempotencyKey: randomUUID() };
  await shelves.write(wanted);
  expect(await changes(content, 'reader.also_enjoyed_source_change')).toBe(before);
  await shelves.write({ ...wanted, status: 'reading', expectedVersion: 1, idempotencyKey: randomUUID() });
  expect(await changes(content, 'reader.also_enjoyed_source_change')).toBe(before + 1);
}, 30_000);

test('a held source change with the lower transaction id is never covered by a later fold', async () => {
  const xid = async (client: PoolClient) =>
    BigInt((await client.query<{ xid: string }>('SELECT pg_current_xact_id()::text AS xid')).rows[0]!.xid);
  // A vote's aggregate row and a real shelf command, each in the caller's transaction.
  const judged = (client: PoolClient) => client.query(`INSERT INTO access.judgment_aggregate
    (statement, context_key, fit_positive) VALUES ($1, 'global', 1)`, [native()]);
  const shelves = new ReaderLibraryStatusStore(content);
  const shelved = (client: PoolClient) => shelves.write({ agent: native(), work: native(), status: 'read',
    expectedVersion: 0, idempotencyKey: randomUUID() }, client);
  const discovery = async (fold: boolean) => {
    const client = await begin(access);
    try { return await (fold ? foldSourceFence(client) : sourceFence(client)); } finally { await end(client, 'COMMIT'); }
  };
  const logs = [
    { pool: access, change: judged, fence: discovery },
    { pool: content, change: shelved, fence: (fold: boolean) => alsoEnjoyedContentFence(content, fold) },
  ];
  for (const log of logs) {
    const held = await begin(log.pool);
    let basis: { revision: string; changed: boolean };
    try {
      const lower = await xid(held);
      await log.change(held);
      const later = await begin(log.pool);
      try {
        expect(lower).toBeLessThan(await xid(later));
        await log.change(later);
      } finally { await end(later, 'COMMIT'); }
      basis = await log.fence(true);
      expect(basis.changed).toBe(false);
      expect(await log.fence(false)).toEqual(basis);
    } finally { await end(held, 'COMMIT'); }
    expect(await log.fence(false)).toEqual({ ...basis, changed: true });
    expect((await log.fence(true)).revision).toBe(String(BigInt(basis.revision) + 1n));
  }
}, 60_000);

test('a transaction appends one change row, and a rolled-back savepoint takes its mark with it', async () => {
  const client = await begin(access);
  const before = await changes(access, 'access.also_enjoyed_source_change');
  try {
    const subject = () => client.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [native()]);
    await client.query('SAVEPOINT attempt');
    await subject();
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    await subject();
    await subject();
    const fence = await alsoEnjoyedAccessFence(client);
    expect(fence.changed).toBe(true);
    expect(Number((await client.query<{ count: string }>(
      'SELECT count(*)::text FROM access.also_enjoyed_source_change')).rows[0]!.count)).toBe(before + 1);
  } finally { await end(client, 'COMMIT'); }
  expect(await changes(access, 'access.also_enjoyed_source_change')).toBe(before + 1);
}, 30_000);
