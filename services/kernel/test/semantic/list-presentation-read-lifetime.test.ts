import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test, type TestContext } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient, within } from '../../src/access/deadline.ts';
import {
  AccessUnavailableError,
  requireAccessDeadline,
  throwAccessUnavailable,
} from '../../src/access/unavailable.ts';
import {
  discardConnection,
  RetiredReadClientError,
  withBoundedReadOnlyTransaction,
  withConnection,
} from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
import { withRequestDeadline } from '../../src/request/deadline.ts';

// Run the actual reader body without loading its SQL/definition graph. The pool checkout,
// bounded transaction, deadline classification and reader orchestration remain real.
const source = readFileSync(new URL('../../src/semantic/list-presentation.ts', import.meta.url), 'utf8');
const start = source.indexOf('type Dependencies =');
const end = source.indexOf("\nexport { readListPresentationFacts }");
assert.ok(start >= 0 && end > start);
const body = stripTypeScriptTypes(
  source
    .slice(start, end)
    .replace('export async function readNativeListPresentationFacts', 'async function readNativeListPresentationFacts'),
);
type Reader = (
  deps: { pool: Pool; routeKey: Uint8Array; deadline: number },
  originals: readonly string[],
  options: { workContext: boolean },
  evidence: { validateHitOptions(): { languages: string[] } },
) => Promise<Map<string, unknown>>;

const original = '00000000-0000-4000-8000-000000000001';
const begin = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
type Result = { rows: unknown[] };
type Query = { text: string; values?: unknown[]; query_timeout?: number };
type Native = {
  queries: Query[];
  releases: (Error | undefined)[];
  query(input: Query | string): Promise<Result>;
  release(error?: Error): void;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const failureOf = (read: Promise<unknown>) =>
  read.then(() => assert.fail('Expected a failed read'), (error: unknown) => error);
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
}
function unavailable(error: unknown, reason: string) {
  assert.ok(error instanceof AccessUnavailableError);
  assert.equal(error.reason, reason);
}

function fixture() {
  const natives: Native[] = [];
  const clients: PoolClient[] = [];
  const homes: number[] = [];
  const faults = new Map<string, () => Promise<Result>>();
  const state = {
    held: false,
    checkouts: 0,
    queued: undefined as Promise<void> | undefined,
    afterReleaseRead: undefined as (() => void) | undefined,
  };
  let reusable: Native | undefined;
  const active = { digest: 'release', release: { types: {}, properties: {} } };
  const pool = {
    async connect() {
      state.checkouts++;
      const queued = state.queued;
      state.queued = undefined;
      if (queued) await queued;
      assert.equal(state.held, false, 'No checkout may overlap another home');
      state.held = true;
      const native: Native = reusable ?? {
        queries: [],
        releases: [],
        async query(input) {
          const query = typeof input === 'string' ? { text: input } : input;
          native.queries.push(query);
          const fault = faults.get(query.text);
          if (fault) {
            faults.delete(query.text);
            return fault();
          }
          return {
            rows:
              query.text === 'partition'
                ? [{ writeState: 'active', position: 7n, epoch: 3 }]
                : query.text === 'release' ? [active] : [],
          };
        },
        release(error) {
          assert.equal(state.held, true, 'Release each checkout exactly once');
          state.held = false;
          native.releases.push(error);
          if (!error) reusable = native;
        },
      };
      if (!reusable) natives.push(native);
      reusable = undefined;
      return native as unknown as PoolClient;
    },
  } as unknown as Pool;
  const bindings = {
    AccessUnavailableError,
    requireAccessDeadline,
    throwAccessUnavailable,
    ProblemError,
    withBoundedReadOnlyTransaction,
    withRequestDeadline,
    // Retain the previous owner's dependencies so a regression fails on custody, not a missing binding.
    deadlineClient,
    within,
    discardConnection,
    withConnection,
    async readPartition(client: PoolClient, home: number) {
      homes.push(home);
      clients.push(client);
      return (await client.query('partition', [home])).rows[0];
    },
    async activeRelease(client: PoolClient) {
      const result = await client.query('release');
      const after = state.afterReleaseRead;
      state.afterReleaseRead = undefined;
      after?.();
      return result.rows[0];
    },
    async accessCheck() {
      assert.equal(state.held, false, 'Release the native home before Access preparation');
      return async () => false;
    },
    async readIdentityMappings(_pool: Pool, ids: readonly string[]) {
      assert.equal(state.held, false);
      assert.deepEqual(ids, []);
      return [];
    },
    routeOf: (id: string) => (id === original ? 1 : null),
    partitionOf: (route: number) => route,
    subjectReadEligibility: () => undefined,
    createReleasedRelationDirectionResolver: () => undefined,
    withPublicStatementReader: (read: () => Promise<unknown>) => read(),
    listWorkTargets: () => [],
    subjectsSQL: { sql: 'subjects' },
  };
  const reader = new Function(...Object.keys(bindings), `${body}\nreturn readNativeListPresentationFacts;`)(
    ...Object.values(bindings),
  ) as Reader;
  const read = (deadline = Date.now() + 100) =>
    reader(
      { pool, deadline, routeKey: new Uint8Array(32) },
      [original],
      { workContext: true },
      { validateHitOptions: () => ({ languages: ['en'] }) },
    );
  return { read, state, natives, clients, homes, faults };
}

async function recover(f: ReturnType<typeof fixture>) {
  const before = f.state.checkouts;
  assert.deepEqual(await f.read(), new Map([[original, null]]));
  assert.equal(f.state.held, false);
  assert.equal(f.state.checkouts - before, 4);
  assert.deepEqual(f.homes.slice(-4), [0, 1, 1, 0]);
  const native = f.natives.at(-1)!;
  assert.deepEqual(native.queries.slice(-16).map(({ text }) => text), [
    begin, 'partition', 'release', 'COMMIT',
    begin, 'partition', 'subjects', 'COMMIT',
    begin, 'partition', 'subjects', 'COMMIT',
    begin, 'partition', 'release', 'COMMIT',
  ]);
  for (const query of native.queries.slice(-16))
    assert.ok(query.query_timeout! > 0 && query.query_timeout! <= 100);
  assert.deepEqual(native.releases.slice(-4), [undefined, undefined, undefined, undefined]);
}

test('list facts reject an expired request before checkout and remain usable', async (t) => {
  clock(t);
  const f = fixture();
  unavailable(await failureOf(f.read(Date.now())), 'deadline');
  assert.equal(f.state.checkouts, 0);
  await recover(f);
});

test('list facts release a checkout arriving after expiry without starting a snapshot', async (t) => {
  clock(t);
  const f = fixture();
  const queued = deferred<void>();
  f.state.queued = queued.promise;
  const outcome = failureOf(f.read());
  await flush();
  t.mock.timers.tick(100);
  unavailable(await outcome, 'deadline');
  assert.equal(f.natives.length, 0);
  await recover(f);
  const native = f.natives[0]!;
  const queries = native.queries.length;
  queued.resolve();
  await flush();
  assert.equal(native.queries.length, queries);
  assert.equal(native.releases.length, 5);
  assert.equal(native.releases.at(-1), undefined);
  assert.equal(f.state.held, false);
});

for (const statement of [begin, 'release', 'COMMIT']) {
  test(`list facts retire a stalled ${statement} and ignore its late completion`, async (t) => {
    clock(t);
    const f = fixture();
    const stalled = deferred<Result>();
    f.faults.set(statement, () => stalled.promise);
    const outcome = failureOf(f.read());
    await flush();
    const native = f.natives[0]!;
    assert.equal(native.queries.at(-1)?.text, statement);
    t.mock.timers.tick(100);
    unavailable(await outcome, 'deadline');
    await flush();
    assert.equal(f.state.held, false);
    assert.equal(native.releases.length, 1);
    unavailable(native.releases[0], 'deadline');
    const queries = native.queries.length;
    for (const client of f.clients) await assert.rejects(client.query('late'), RetiredReadClientError);
    await recover(f);
    if (statement === 'release') stalled.reject(new Error('Late native rejection'));
    else stalled.resolve({ rows: [] });
    await flush();
    assert.equal(native.queries.length, queries);
    assert.equal(native.releases.length, 1);
  });
}

for (const kind of ['server', 'domain'] as const) {
  for (const cleanup of ['settled', 'stalled', 'failed', 'expired'] as const) {
    test(`list facts preserve a settled ${kind} failure with ${cleanup} cleanup`, async (t) => {
      clock(t);
      const f = fixture();
      const cause =
        kind === 'server'
          ? Object.assign(new Error('Read contention'), { code: '40001', severity: 'ERROR' })
          : new ProblemError('semantic_not_ready');
      const fail = () => {
        if (cleanup === 'expired') t.mock.timers.setTime(Date.now() + 100);
        throw cause;
      };
      if (kind === 'server') f.faults.set('release', async () => fail());
      else f.state.afterReleaseRead = fail;
      const rollback = deferred<Result>();
      if (cleanup === 'stalled') f.faults.set('ROLLBACK', () => rollback.promise);
      if (cleanup === 'failed')
        f.faults.set('ROLLBACK', async () => {
          throw new Error('Cleanup failed');
        });
      const outcome = failureOf(f.read());
      await flush();
      if (cleanup === 'stalled') {
        assert.equal(f.natives[0]!.queries.at(-1)?.text, 'ROLLBACK');
        t.mock.timers.tick(100);
      }
      const error = await outcome;
      if (kind === 'server') unavailable(error, 'contention');
      else assert.equal(error, cause);
      await flush();
      const native = f.natives[0]!;
      assert.equal(f.state.held, false);
      assert.equal(native.releases.length, 1);
      assert.equal(native.releases[0] === undefined, cleanup === 'settled');
      assert.equal(native.queries.some(({ text }) => text === 'ROLLBACK'), cleanup !== 'expired');
      const queries = native.queries.length;
      await recover(f);
      if (cleanup === 'stalled') {
        rollback.resolve({ rows: [] });
        await flush();
        assert.equal(native.queries.length, queries);
        assert.equal(native.releases.length, 1);
      }
    });
  }
}

test('list facts retire an uncertain native failure without attempting rollback', async (t) => {
  clock(t);
  const f = fixture();
  const cause = new Error('Native transport lost');
  f.faults.set('release', async () => {
    throw cause;
  });
  assert.equal(await failureOf(f.read()), cause);
  assert.equal(f.state.held, false);
  assert.deepEqual(f.natives[0]!.releases, [cause]);
  assert.equal(f.natives[0]!.queries.some(({ text }) => text === 'ROLLBACK'), false);
  await recover(f);
});
