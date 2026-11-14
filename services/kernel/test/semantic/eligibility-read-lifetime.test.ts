import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { prepareAnonymousEligibility, type ResourceEligibility } from '../../src/access/eligibility.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { AccessWorkAccounting, type AccessWork } from '../../src/access/work.ts';
import contextPublicEvidence from '../../src/semantic/context-public-evidence.sql';
import { GLOBAL_SUBJECT_CONTEXT } from '../../src/semantic/contract/subject-values.ts';
import { globalReadEligibility, subjectReadEligibility } from '../../src/semantic/eligibility.ts';
import subjectPublicEvidence from '../../src/semantic/scope-leaf-evidence-eligibility.sql';

type NativeCall = { text: string; values: readonly unknown[]; query_timeout: number };
type PointRow = Record<string, string>;
type PointResult = { rows: PointRow[] };
type Case = {
  name: string;
  action: string;
  resource: { route: number; id: string };
  eligibility: () => ResourceEligibility;
  statement: { sql: string; params: readonly string[] };
  input: Record<string, unknown>;
  projection: PointRow;
  row: PointRow;
};

const cases: readonly Case[] = [
  {
    name: 'Global Definition catalogue',
    action: 'definitions:read',
    resource: { route: 0, id: GLOBAL_SUBJECT_CONTEXT },
    eligibility: () => globalReadEligibility('definitions:read'),
    statement: contextPublicEvidence,
    input: { route: 0, context_id: GLOBAL_SUBJECT_CONTEXT },
    projection: { kind: 'community' },
    row: { kind: 'community' },
  },
  {
    name: 'Subject catalogue',
    action: 'subject:read',
    resource: { route: 17, id: '11111111-1111-4111-8111-111111111111' },
    eligibility: () => subjectReadEligibility({ route: 17, id: '11111111-1111-4111-8111-111111111111' }),
    statement: subjectPublicEvidence,
    input: { route: 17, subject_id: '11111111-1111-4111-8111-111111111111' },
    projection: { visibility: 'taken_down', security_revision: '9223372036854775807' },
    row: { visibility: 'visible', security_revision: '7' },
  },
];

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null');
const budget = () => Date.now() + 250;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function expectedWork(entry: Case, row?: PointRow): AccessWork {
  return {
    keys: 1,
    points: 2,
    witnesses: 0,
    rows: 1,
    bytes: bytes({ route: entry.resource.route, subject_id: entry.resource.id }) + bytes(row ?? entry.projection),
    emptySeeks: row ? 0 : 1,
  };
}

function ledger(deadline: number) {
  const receipts: Array<{ operation: string; kind: string; bound: AccessWork; settled?: AccessWork }> = [];
  const work = new AccessWorkAccounting(
    {
      reserve(operation, bound, kind) {
        const receipt = { operation, kind, bound, settled: undefined as AccessWork | undefined };
        receipts.push(receipt);
        return {
          settle(actual) {
            receipt.settled = actual;
          },
        };
      },
    },
    deadline,
  );
  return { work, receipts };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lease(query: (call: NativeCall) => Promise<PointResult>) {
  const calls: NativeCall[] = [];
  const releases: Array<Error | undefined> = [];
  const client = {
    query(call: NativeCall) {
      calls.push(call);
      return query(call);
    },
    release(error?: Error) {
      releases.push(error);
    },
  } as unknown as PoolClient;
  return { client, calls, releases };
}

function poolOf(...checkouts: Array<() => Promise<PoolClient>>) {
  let connects = 0;
  const pool = {
    connect() {
      const checkout = checkouts[connects++];
      assert.ok(checkout, 'unexpected checkout');
      return checkout();
    },
  } as unknown as Pool;
  return {
    pool,
    get connects() {
      return connects;
    },
  };
}

type Binding = Parameters<typeof prepareAnonymousEligibility>[0];
type Context = Parameters<typeof prepareAnonymousEligibility>[1];

function prepare(entry: Case, eligibility: ResourceEligibility, pool: Pool, deadline: number, work: AccessWorkAccounting) {
  return prepareAnonymousEligibility(
    {
      actor: {} as Binding['actor'],
      action: entry.action,
      resource: { ...entry.resource, eligibility } as Binding['resource'],
      deadline,
    },
    { pool, deadline, work } as Context,
  );
}

function assertPoint(entry: Case, calls: readonly NativeCall[]) {
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call);
  assert.equal(call.text, entry.statement.sql);
  assert.deepEqual(call.values, entry.statement.params.map((name) => entry.input[name]));
  assert.ok(Number.isInteger(call.query_timeout) && call.query_timeout >= 1 && call.query_timeout <= 250);
}

function assertReceipt(
  entry: Case,
  receipts: ReturnType<typeof ledger>['receipts'],
  settled: AccessWork = expectedWork(entry, entry.row),
) {
  assert.equal(receipts.length, 1);
  const [receipt] = receipts;
  assert.ok(receipt);
  assert.equal(receipt.operation, 'Content resource eligibility.prepare');
  assert.equal(receipt.kind, 'owner');
  assert.deepEqual(receipt.bound, expectedWork(entry));
  assert.deepEqual(receipt.settled, settled);
}

function assertDeadline(error: unknown) {
  return error instanceof AccessUnavailableError && error.reason === 'deadline';
}

for (const entry of cases) {
  test(`${entry.name}: successful prepare retains one point and its measured receipt`, async () => {
    const eligibility = entry.eligibility();
    const healthy = lease(async () => ({ rows: [entry.row] }));
    const source = poolOf(async () => healthy.client);
    const deadline = budget();
    const { work, receipts } = ledger(deadline);

    assert.equal(typeof await prepare(entry, eligibility, source.pool, deadline, work), 'function');
    assert.equal(source.connects, 1);
    assertPoint(entry, healthy.calls);
    assert.deepEqual(healthy.releases, [undefined]);
    assertReceipt(entry, receipts);
  });

  test(`${entry.name}: expired preflight never checks out`, async () => {
    const eligibility = entry.eligibility();
    const source = poolOf();
    const deadline = Date.now() - 1;
    const { work, receipts } = ledger(deadline);

    await assert.rejects(prepare(entry, eligibility, source.pool, deadline, work), assertDeadline);
    assert.equal(source.connects, 0);
    assert.deepEqual(receipts, []);
  });

  test(`${entry.name}: queued checkout expires and a late client runs no point`, async () => {
    const eligibility = entry.eligibility();
    const queued = deferred<PoolClient>();
    const late = lease(async () => ({ rows: [entry.row] }));
    const source = poolOf(() => queued.promise);
    const deadline = budget();
    const { work, receipts } = ledger(deadline);

    await assert.rejects(prepare(entry, eligibility, source.pool, deadline, work), assertDeadline);
    queued.resolve(late.client);
    await nextTurn();
    assert.equal(source.connects, 1);
    assert.deepEqual(late.calls, []);
    assert.deepEqual(late.releases, [undefined]);
    assertReceipt(entry, receipts, expectedWork(entry));
  });

  test(`${entry.name}: stalled query retires its client, ignores late completion, then recovers`, async () => {
    const eligibility = entry.eligibility();
    const native = deferred<PointResult>();
    const dispatched = deferred<void>();
    const stalled = lease(() => {
      dispatched.resolve(undefined);
      return native.promise;
    });
    const healthy = lease(async () => ({ rows: [entry.row] }));
    const source = poolOf(async () => stalled.client, async () => healthy.client);
    const firstDeadline = budget();
    const first = ledger(firstDeadline);
    const attempt = prepare(entry, eligibility, source.pool, firstDeadline, first.work);

    await dispatched.promise;
    await assert.rejects(attempt, assertDeadline);
    await nextTurn();
    assertPoint(entry, stalled.calls);
    assert.equal(stalled.releases.length, 1);
    assert.ok(stalled.releases[0] instanceof Error);
    assertReceipt(entry, first.receipts, expectedWork(entry));

    native.resolve({ rows: [entry.row] });
    await nextTurn();
    assert.equal(stalled.releases.length, 1);
    assert.equal(first.receipts.length, 1);

    const recoveryDeadline = budget();
    const recovery = ledger(recoveryDeadline);
    assert.equal(typeof await prepare(entry, eligibility, source.pool, recoveryDeadline, recovery.work), 'function');
    assert.equal(source.connects, 2);
    assertPoint(entry, healthy.calls);
    assert.deepEqual(healthy.releases, [undefined]);
    assertReceipt(entry, recovery.receipts);
  });

  test(`${entry.name}: settled native rejection burns reserved work and a later point succeeds`, async () => {
    const eligibility = entry.eligibility();
    const rejection = Object.assign(new Error('native point rejected'), { code: '23514', severity: 'ERROR' });
    const failed = lease(async () => {
      throw rejection;
    });
    const healthy = lease(async () => ({ rows: [entry.row] }));
    const source = poolOf(async () => failed.client, async () => healthy.client);
    const firstDeadline = budget();
    const first = ledger(firstDeadline);

    await assert.rejects(prepare(entry, eligibility, source.pool, firstDeadline, first.work));
    assertPoint(entry, failed.calls);
    assert.deepEqual(failed.releases, [undefined]);
    assertReceipt(entry, first.receipts, expectedWork(entry));

    const recoveryDeadline = budget();
    const recovery = ledger(recoveryDeadline);
    assert.equal(typeof await prepare(entry, eligibility, source.pool, recoveryDeadline, recovery.work), 'function');
    assert.equal(source.connects, 2);
    assertPoint(entry, healthy.calls);
    assert.deepEqual(healthy.releases, [undefined]);
    assertReceipt(entry, recovery.receipts);
  });

  test(`${entry.name}: settled client-side query timeout retires its client`, async () => {
    const eligibility = entry.eligibility();
    const failed = lease(async () => {
      throw new Error('query read timeout');
    });
    const healthy = lease(async () => ({ rows: [entry.row] }));
    const source = poolOf(async () => failed.client, async () => healthy.client);
    const firstDeadline = budget();
    const first = ledger(firstDeadline);

    await assert.rejects(prepare(entry, eligibility, source.pool, firstDeadline, first.work), assertDeadline);
    assertPoint(entry, failed.calls);
    assert.equal(failed.releases.length, 1);
    assert.ok(failed.releases[0] instanceof Error);
    assertReceipt(entry, first.receipts, expectedWork(entry));

    const recoveryDeadline = budget();
    const recovery = ledger(recoveryDeadline);
    assert.equal(typeof await prepare(entry, eligibility, source.pool, recoveryDeadline, recovery.work), 'function');
    assert.equal(source.connects, 2);
    assertPoint(entry, healthy.calls);
    assert.deepEqual(healthy.releases, [undefined]);
    assertReceipt(entry, recovery.receipts);
  });
}
