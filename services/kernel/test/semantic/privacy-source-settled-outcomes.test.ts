import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { AccessUnavailableError, classifyUnavailability, requireAccessDeadline } from '../../src/access/unavailable.ts';
import type { NativeReadQueryConfig } from '../../src/database/bounded-read-lifetime.ts';
import type { PublicFilterSourceFactory } from '../../src/semantic/public-filter-source-contract.ts';
import type {
  PublicFilterAccessBindingPort,
  PublicFilterSearchBindingPort,
} from '../../src/semantic/source-binding-port.ts';

test('native privacy reads preserve settled causes through cleanup and continue from the same head', async (t) => {
  // Isolate storage rows while retaining the native source and physical read lifetime.
  const partition = await import('../../src/partition/partition.ts');
  t.mock.module('../../src/partition/partition.ts', {
    namedExports: {
      ...partition,
      readPartition: async (client: PoolClient, partition: number) =>
        (await client.query('SELECT privacy_test_owner', [partition])).rows[0],
    },
  });
  t.mock.module('../../src/semantic/public-filter-source-head.sql', {
    defaultExport: {
      run: async (client: PoolClient, input: { partition_no: number }) =>
        (await client.query('SELECT privacy_test_head', [input.partition_no])).rows[0],
    },
  });
  t.mock.module('../../src/semantic/public-filter-source-log-page.sql', {
    defaultExport: {
      run: async (
        client: PoolClient,
        input: { partition_no: number; after: string; through: string; input_limit: number },
      ) =>
        (
          await client.query('SELECT privacy_test_log', [
            input.partition_no,
            input.after,
            input.through,
            input.input_limit,
          ])
        ).rows,
    },
  });
  const { createNativePublicFilterSource } = await import('../../src/semantic/public-filter-source.ts');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });

  const head = { partition: 0, epoch: 7, position: 2n };
  const subject = '0:00000000-0000-4000-8000-000000000001';
  const entries = [1n, 2n].map((position) => ({
    head: { ...head, position },
    transactionId: `00000000-0000-4000-8000-00000000000${position}`,
    cause: 'subject' as const,
    affected: [{ kind: 'subject' as const, route: 0, subject }],
    impacts: [{ kind: 'subject' as const, route: 0, subject }],
  }));
  const emptyCost = {
    inputKeys: 0,
    candidates: 0,
    accessPoints: 0,
    dependencyPoints: 0,
    engineSearches: 0,
    engineIteratorSteps: 0,
    outputSlots: 0,
    resultWrites: 0,
    frontierWrites: 0,
  };
  const rowCost = { ...emptyCost, inputKeys: 1 };
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] });
  type Method = 'home' | 'log';
  type Phase = 'begin' | 'read' | 'commit';
  type Cleanup = 'complete' | 'reject' | 'late';
  let attempt:
    | {
        method: Method;
        phase: Phase;
        deadline: number;
        error?: Error;
        cleanup?: Cleanup;
        stall?: { entered(): void; result: Promise<ReturnType<typeof result>> };
      }
    | undefined;
  const checkouts: { queries: string[]; releaseError?: Error | undefined; released: Promise<void> }[] = [];
  const unused = () => {
    throw new Error('Privacy head/log reads must not call another source producer');
  };
  const pool = {
    query: unused,
    async connect() {
      const current = attempt;
      let release!: () => void;
      const checkout: (typeof checkouts)[number] = {
        queries: [],
        released: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      checkouts.push(checkout);
      return {
        async query(input: NativeReadQueryConfig) {
          const sql = input.text;
          checkout.queries.push(sql);
          const phase = sql.startsWith('BEGIN')
            ? 'begin'
            : sql === 'COMMIT'
              ? 'commit'
              : sql === `SELECT privacy_test_${current?.method === 'home' ? 'head' : 'log'}`
                ? 'read'
                : undefined;
          if (current && phase === current.phase) {
            if (current.stall) {
              current.stall.entered();
              return current.stall.result;
            }
            throw current.error;
          }
          if (sql === 'ROLLBACK') {
            if (current?.cleanup === 'reject') throw new AccessUnavailableError('deadline');
            if (current?.cleanup === 'late') t.mock.timers.setTime(current.deadline + 1);
          }
          if (sql === 'SELECT privacy_test_owner') {
            assert.deepEqual(input.values, [head.partition]);
            return result([{ partition: head.partition, epoch: head.epoch, writeState: 'active' }]);
          }
          if (sql === 'SELECT privacy_test_head') {
            assert.deepEqual(input.values, [head.partition]);
            return result([{ position: head.position.toString(), owner_epoch: head.epoch, population_fenced: false }]);
          }
          if (sql === 'SELECT privacy_test_log') {
            const [partition, after, through, limit] = input.values as [number, string, string, number];
            assert.equal(partition, head.partition);
            assert.equal(through, head.position.toString());
            return result(
              entries
                .filter((entry) => entry.head.position > BigInt(after) && entry.head.position <= BigInt(through))
                .slice(0, limit)
                .map((entry) => ({
                  position: entry.head.position.toString(),
                  transaction_id: entry.transactionId,
                  cause: entry.cause,
                  affected: entry.affected,
                  impacts: entry.impacts,
                })),
            );
          }
          return result();
        },
        release(error?: Error) {
          checkout.releaseError = error;
          release();
        },
      } as unknown as PoolClient;
    },
  } as unknown as Pool;
  const accessPort: PublicFilterAccessBindingPort = {
    classifyUnavailability,
    requireDeadline: requireAccessDeadline,
    isUnavailable: (error) => error instanceof AccessUnavailableError,
    readAccountRepair: unused,
    enrollAccountHome: unused,
    checkSubjectRead: unused,
  };
  const source = createNativePublicFilterSource(
    {
      pool,
      routeKey: new Uint8Array(32),
      access: { authenticate: unused, authorize: unused } as Parameters<PublicFilterSourceFactory>[0]['access'],
      clock: undefined as never,
    },
    unused,
    {} as PublicFilterSearchBindingPort,
    accessPort,
  );
  const read = (method: Method, deadline: number, after = 0n) =>
    method === 'home'
      ? source.readPrivacyReductionHeads({ kind: 'home', partition: head.partition, context: { deadline } })
      : source.readPrivacyReductionPage({
          partition: head.partition,
          epoch: head.epoch,
          after,
          through: head.position,
          inputLimit: 1,
          context: { deadline },
        });
  const healthyContinuation = async () => {
    attempt = undefined;
    const deadline = Date.now() + 100;
    assert.deepEqual(await read('home', deadline), { status: 'home', head, cost: rowCost });
    for (const [index, entry] of entries.entries()) {
      assert.deepEqual(await read('log', deadline, BigInt(index)), {
        status: index === 0 ? 'progress' : 'complete',
        head,
        entries: [entry],
        after: entry.head.position,
        cost: rowCost,
      });
      assert.equal(checkouts.at(-1)!.releaseError, undefined);
    }
  };
  await healthyContinuation();

  // Raw SQL, transport and domain failures keep their existing rejection identity,
  // even when Access's classifier would recognize a raw SQL/dependency timeout.
  const failures = [
    { error: new AccessUnavailableError('overloaded'), unavailable: true },
    { error: new AccessUnavailableError('contention'), unavailable: true },
    { error: new Error('Query read timeout'), unavailable: false },
    { error: Object.assign(new Error('Connection lost'), { code: '08006' }), unavailable: false },
    {
      error: Object.assign(new Error('Statement canceled'), { code: '57014', severity: 'ERROR' }),
      unavailable: false,
    },
    { error: new TypeError('Native privacy domain failure'), unavailable: false },
  ];
  for (const method of ['home', 'log'] as const) {
    for (const phase of ['begin', 'read', 'commit'] as const) {
      for (const failure of failures) {
        const cleanups: Cleanup[] = phase === 'read' ? ['complete', 'reject', 'late'] : ['complete'];
        for (const cleanup of cleanups) {
          const deadline = Date.now() + 100;
          attempt = { method, phase, deadline, error: failure.error, cleanup };
          const label = `${method}/${phase}/${cleanup}/${failure.error.message}`;
          if (failure.unavailable) {
            assert.deepEqual(
              await read(method, deadline),
              { status: 'unavailable', reason: 'dependency_unavailable', cost: emptyCost },
              label,
            );
          } else {
            await assert.rejects(read(method, deadline), (error) => error === failure.error, label);
          }
          const checkout = checkouts.at(-1)!;
          await checkout.released;
          assert.equal(checkout.queries.includes('ROLLBACK'), phase === 'read', label);
          assert.equal(checkout.releaseError instanceof Error, phase !== 'read' || cleanup !== 'complete', label);
          if (cleanup === 'late') assert.ok(Date.now() > deadline, label);
          await healthyContinuation();
        }
      }
    }

    const beforePreflight = checkouts.length;
    assert.deepEqual(await read(method, Date.now()), {
      status: 'unavailable',
      reason: 'deadline',
      cost: emptyCost,
    });
    assert.equal(checkouts.length, beforePreflight);
    await healthyContinuation();

    // Advance the actual bounded lifetime's timer while a native query is pending.
    let entered!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let settle!: (value: ReturnType<typeof result>) => void;
    const pending = new Promise<ReturnType<typeof result>>((resolve) => {
      settle = resolve;
    });
    const deadline = Date.now() + 100;
    attempt = { method, phase: 'read', deadline, stall: { entered, result: pending } };
    const expired = read(method, deadline);
    await dispatched;
    t.mock.timers.tick(100);
    assert.deepEqual(await expired, { status: 'unavailable', reason: 'deadline', cost: emptyCost });
    const retired = checkouts.at(-1)!;
    await retired.released;
    assert.ok(retired.releaseError instanceof Error);
    const retiredQueries = [...retired.queries];
    settle(result());
    await pending;
    await healthyContinuation();
    assert.deepEqual(retired.queries, retiredQueries);
  }
});
