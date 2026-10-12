import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AsyncResource } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { grantFixtureAuthority } from '../src/modules/access/fixture-authority.ts';
import { accessClient, controlRead, ControlDenied, ControlUnavailable } from '../src/modules/access/topology-control.ts';
import { ProfilesAccess } from '../src/modules/profiles/access.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const root = resolve(import.meta.dir, '../../..');
const native = () => `https://rezics.com/id/${randomUUID()}`;
const previousMode = nestedPoolCheckoutMode();
const agent = native(), missing = native(), placement = native();
const principal: VerifiedPrincipal = { issuer: 'https://account.profiles.test', subject: randomUUID() };
const principalId = randomUUID();
let cluster: PostgresCluster | undefined;
let pool: Pool;
let profiles: ProfilesAccess;
let threads: RealmReplyThreadStore;

beforeAll(async () => {
  setNestedPoolCheckoutMode('throw');
  cluster = await startPostgresCluster();
  pool = boundedPool({ ...cluster.connection, max: 1, connectionTimeoutMillis: 1_000 });
  for (const file of schemaFiles(root, 'access')) {
    await pool.query(readFileSync(join(root, 'services/main/migrations/access', file), 'utf8'));
  }
  await pool.query('INSERT INTO access.principal(id,account_issuer,account_subject) VALUES ($1,$2,$3)',
    [principalId, principal.issuer, principal.subject]);
  await pool.query("INSERT INTO access.authority_subject(id,kind) VALUES ($1,'agent')", [agent]);
  await grantFixtureAuthority(pool, { scope: `profiles:library:${agent}`, requireDispatch: true,
    representations: [{ principalId, actor: agent, action: 'contribution.read', lifetime: 'infinity' }],
    grant: { actor: agent, action: 'contribution.read', lifetime: 'infinity' } });
  await pool.query(`INSERT INTO access.feed_item
    (data_epoch,id,sequence,kind,occurred_at,time_basis,score,best_key,group_bucket,group_key,
      group_leader,group_members,sort_time)
    VALUES ('profile-thread-epoch',$1,1,'reply',now(),'revision',7,0,'profile-thread','profile-thread',true,ARRAY[$1],now())`,
  [placement]);
  profiles = new ProfilesAccess(pool);
  threads = new RealmReplyThreadStore(pool, pool);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  cluster?.remove();
  setNestedPoolCheckoutMode(previousMode);
}, 60_000);

/** Observe the one real client, retaining the owner's query results and cost.
 * A consumer hook also proves publication independently of sibling isolation. */
async function observeQueries<T>(run: () => Promise<T>, observe: (sql: string, client: PoolClient) => Promise<void>) {
  const client = await pool.connect();
  const original = client.query;
  const query = original.bind(client);
  client.release();
  client.query = (async (sql: string, parameters?: unknown[]) => {
    const result = await query(sql, parameters);
    await observe(sql, client);
    return result;
  }) as PoolClient['query'];
  try { return await run(); }
  finally { client.query = original; }
}

test('thread author fences and sibling vote reads keep independent transactions on a one-client pool', async () => {
  const expected = await profiles.agentFences([agent, missing]);
  const ids: string[] = [];
  const [fences, votes] = await observeQueries(() => Promise.all([
    // The production fanout evaluates authors before votes. Its raw checkout
    // must not escape into the sibling's instrumentation or Access context.
    profiles.agentFences([agent, missing]),
    threads.votes('profile-thread-epoch', [placement]),
  ]), async (sql, client) => {
    if (!sql.includes('CROSS JOIN unnest') && !sql.includes('FROM access.feed_item')) return;
    expect(accessClient(pool)).toBe(client);
    ids.push((await client.query('SELECT txid_current()::text AS id')).rows[0]!.id);
  });
  expect(fences).toEqual(expected);
  expect([...fences.keys()]).toEqual([agent]);
  expect(votes).toEqual(new Map([[placement, { score: 7, value: 0, revision: null, open: true }]]));
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
  expect(accessClient(pool)).toBeUndefined();
  expect(pool.idleCount).toBe(1);
}, 30_000);

test('profile callback consumers borrow the held transaction, retain bounds and leave its commit to the owner', async () => {
  const expected = await profiles.agentFences([agent]);
  const statements: string[] = [];
  let after: (() => PoolClient | undefined) | undefined;
  let callbacks = 0;
  const fences = await observeQueries(() => profiles.agentFences([agent]), async (sql, client) => {
    statements.push(sql);
    if (!sql.includes('CROSS JOIN unnest')) return;
    callbacks++;
    expect(accessClient(pool)).toBe(client);
    await expect(pool.connect()).rejects.toBeInstanceOf(NestedPoolCheckoutError);
    const id = (await client.query('SELECT txid_current()::text AS id')).rows[0]!.id;
    await controlRead(pool, async inner => {
      expect(inner).toBe(client);
      expect((await inner.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
      expect((await inner.query('SHOW lock_timeout')).rows[0]!.lock_timeout).toBe('2s');
      expect((await inner.query('SHOW statement_timeout')).rows[0]!.statement_timeout).toBe('5s');
      // Tighter parent bounds cannot be widened by a borrowed consumer.
      await inner.query("SET LOCAL lock_timeout = '500ms'; SET LOCAL statement_timeout = '1s'");
      await controlRead(pool, async nested => {
        expect((await nested.query('SHOW lock_timeout')).rows[0]!.lock_timeout).toBe('500ms');
        expect((await nested.query('SHOW statement_timeout')).rows[0]!.statement_timeout).toBe('1s');
      });
      const continuation = new AsyncResource('profile-callback-continuation');
      after = () => {
        const held = continuation.runInAsyncScope(() => accessClient(pool));
        continuation.emitDestroy();
        return held;
      };
    });
    expect((await client.query('SELECT txid_current()::text AS id')).rows[0]!.id).toBe(id);
  });
  expect(fences).toEqual(expected);
  expect(callbacks).toBe(1);
  expect(statements.filter(sql => sql.startsWith('BEGIN'))).toHaveLength(1);
  expect(statements.filter(sql => sql === 'COMMIT')).toHaveLength(1);
  expect(statements.filter(sql => sql.includes('access.recovery_fence'))).toHaveLength(1);
  expect(after?.()).toBeUndefined();
  expect(accessClient(pool)).toBeUndefined();
  expect(pool.idleCount).toBe(1);
}, 30_000);

test('ordinary profile reads keep their single predicate costs and closed recovery refuses every owner path', async () => {
  for (const [read, cost] of [
    [() => profiles.agentFences([agent, missing]), 5],
    [() => profiles.libraryFence(principal, agent, 'contribution.read'), 8],
    [() => profiles.ratings(principalId, '', 1), 6],
  ] as const) {
    const statements: string[] = [];
    await observeQueries<unknown>(read, async sql => { statements.push(sql); });
    expect(statements).toHaveLength(cost);
    expect(statements.filter(sql => sql.includes('access.recovery_fence'))).toHaveLength(1 + Number(cost === 8));
    await pool.query('UPDATE access.recovery_fence SET open=false WHERE id');
    try {
      await expect(read()).rejects.toBeInstanceOf(WorkReadUnavailable);
      await expect(threads.votes('profile-thread-epoch', [placement])).rejects.toBeInstanceOf(ControlUnavailable);
      expect(accessClient(pool)).toBeUndefined();
    } finally { await pool.query('UPDATE access.recovery_fence SET open=true WHERE id'); }
  }
  await expect(profiles.libraryFence({ ...principal, subject: 'absent' }, agent, 'contribution.read'))
    .rejects.toBeInstanceOf(ControlDenied);
  expect(await profiles.ratings(principalId, '', 1)).toEqual([]);
}, 30_000);

test('a failing borrowed consumer rolls back with the profile owner and releases its holding', async () => {
  const marker = randomUUID();
  await expect(observeQueries(() => profiles.libraryFence(principal, agent, 'contribution.read'), async (sql, client) => {
    if (!sql.includes('SELECT s.generation,')) return;
    await controlRead(pool, async inner => {
      expect(inner).toBe(client);
      await inner.query('INSERT INTO access.template_seek_checkpoint(epoch,instance,complete) VALUES ($1,$2,true)',
        [marker, randomUUID()]);
      throw new Error('Profile consumer failed');
    });
  })).rejects.toThrow('Profile consumer failed');
  expect((await pool.query('SELECT 1 FROM access.template_seek_checkpoint WHERE epoch=$1', [marker])).rowCount).toBe(0);
  expect(accessClient(pool)).toBeUndefined();
  expect(pool.idleCount).toBe(1);
  expect(await profiles.agentFence(agent)).not.toBeNull();
}, 30_000);

test('a queued profile checkout keeps the parent deadline and releases a connection arriving after abort', async () => {
  const blocker = new AsyncResource('independent-profile-blocker');
  const client = await blocker.runInAsyncScope(() => pool.connect());
  try {
    const signal = AbortSignal.timeout(30);
    await expect(fusekiReadBudget.run({ signal, callsLeft: 1, bytesLeft: 1 }, () => profiles.agentFence(agent)))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(pool.waitingCount).toBe(1);
  } finally { client.release(); blocker.emitDestroy(); }
  // Queued pg acquisitions cannot be cancelled; the late client is released
  // before the next real profile read can acquire this max:1 pool.
  expect(await profiles.agentFence(agent)).not.toBeNull();
  expect(pool.waitingCount).toBe(0);
  expect(pool.idleCount).toBe(1);
  expect(accessClient(pool)).toBeUndefined();
}, 30_000);
