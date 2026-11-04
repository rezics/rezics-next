import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling } from '@rezics/bounds';
import canonicalize from 'canonicalize';
import {
  enqueueIntent,
  runOperationalTransaction,
  type OperationalOptions,
  type OperationalTransaction,
} from '../../src/command/operational.ts';
import {
  registerOperationalHistoryWork,
  reserveOperationalWorkTransfer,
  resolveCommittedOperationalWork,
  receiveCommittedOperationalWork,
  operationalWorkSource,
  validateOperationalMembersBinding,
  type OperationalMembersBinding,
  type OperationalWorkRegistration,
  type OperationalWorkTransfer,
} from '../../src/history/operational-work.ts';
import { verifyOperationalWorkReplay } from '../../src/history/operational-work-receiving.ts';
import { minimizeHistoryWork } from '../../src/history/durable.ts';
import { HistoryRegistry } from '../../src/history/registry.ts';
import { OPERATIONAL_WORK_LOCAL_DECLARATION } from '../../src/history/operational-work-budget.ts';
import { SELECTED_LOCAL_DECLARATION } from '../../src/work/selected-runtime-cost.ts';
import { encodeLocator } from '../../src/history/locator.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkIntent } from '../../src/work/client.ts';
import { operationalFixture } from '../command/support/operational-fixture.ts';

// Deliberately UNRUN at delivery: the controller owns native database acceptance.
let native: Awaited<ReturnType<typeof operationalFixture>>;
beforeAll(async () => {
  native = await operationalFixture(3088);
  await native.db.admin.query(
    'CREATE TABLE public.operational_members_reservation(episode uuid PRIMARY KEY,binding jsonb NOT NULL)',
  );
});
afterAll(async () => {
  await native?.close();
});

test('shared bounds compose finite History declarations and refuse invalid or overflowing dimensions', () => {
  const zero = declareBound(Object.fromEntries(BOUND_AXES.map((axis) => [axis, 0])));
  const page = declareBound({ ...zero, candidateKeys: 2, statements: 1, bytes: 256 });
  const composed = sumBounds(page, page);
  expect(composed).toMatchObject({ candidateKeys: 4, statements: 2, bytes: 512 });
  expect(repeatBound(page, 3)).toMatchObject({ candidateKeys: 6, statements: 3, bytes: 768 });
  expect(OPERATIONAL_WORK_LOCAL_DECLARATION.engineRequests).toBe(0);
  expect(SELECTED_LOCAL_DECLARATION.engineRequests).toBe(0);
  expect(withinCeiling(composed, declareBound({ ...composed, statements: 2 }))).toBe(true);
  expect(withinCeiling(composed, page)).toBe(false);
  expect(() => declareBound({ ...zero, unsupported: 1 })).toThrow('Invalid bound declaration axes');
  expect(() => declareBound({ ...zero, bytes: -1 })).toThrow('Invalid bound declaration value: bytes');
  expect(() => declareBound({ ...zero, bytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
    'Invalid bound declaration value: bytes',
  );
  const omitted = { ...zero } as Record<string, number>;
  delete omitted.bytes;
  expect(() => declareBound(omitted)).toThrow('Invalid bound declaration axes');
  expect(() => sumBounds({ ...page, bytes: Number.MAX_SAFE_INTEGER }, page)).toThrow('Bound declaration overflow');
});

function reservation() {
  const ownerAccountId = native.actor.accountId;
  const route = routeOf(ownerAccountId)!;
  const collectionId = newId(route);
  const episodeId = newId(route);
  const canonicalBasis = canonicalize([1, ownerAccountId, collectionId, { status: 'owned' }, 'id', 'a'.repeat(64)])!;
  const binding: OperationalMembersBinding = {
    route,
    ownerAccountId,
    collectionId,
    retired: [],
    episodes: [
      {
        collectionId,
        episodeId,
        reservedIncarnation: `${collectionId}:1`,
        reservedGeneration: '1',
        canonicalBasis,
        basisDigest: createHash('sha256').update(canonicalBasis).digest('hex'),
      },
    ],
  };
  const intent: WorkIntent = {
    queue: 'workflows',
    workflowName: 'library.membersPreparation',
    workflowId: `library:members-preparation:${route}:${ownerAccountId}:${episodeId}`,
    input: { accounts: [ownerAccountId], route, episodes: [{ collectionId, episodeId }], cleanup: [] },
  };
  return { binding, intent };
}
async function options(binding: OperationalMembersBinding): Promise<OperationalOptions> {
  return {
    ...(await native.request(native.actor, Date.now() + 60_000)),
    kind: 'library.membersPreparation',
    partition: partitionOf(binding.route),
    accounts: [binding.ownerAccountId],
    operationalHistory: true,
  };
}
async function produce(input = reservation()) {
  return runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    // Native test reservation serializer; Commerce's real reserve SQL and association are its
    // separate integration operand. No synthetic CommandTransaction or identity table is used.
    await tx.query('INSERT INTO public.operational_members_reservation VALUES($1,$2)', [
      input.binding.episodes[0]!.episodeId,
      input.binding,
    ]);
    const locator = await registerOperationalHistoryWork(tx, input.binding, input.intent);
    const same = await registerOperationalHistoryWork(tx, input.binding, input.intent);
    expect(same).toBe(locator);
    return {
      ...input,
      locator,
      resolve: reserveOperationalWorkTransfer(tx, 'resolve'),
      receive: reserveOperationalWorkTransfer(tx, 'receive'),
      replay: reserveOperationalWorkTransfer(tx, 'replay'),
      retirement: reserveOperationalWorkTransfer(tx, 'retirement'),
    };
  });
}
async function original(locator: OperationalWorkRegistration) {
  return (
    await native.db.admin.query(
      'SELECT * FROM core.operational_work_original WHERE partition_no=$1 AND custody_id=$2',
      [locator.partition, locator.custodyId],
    )
  ).rows[0];
}

test('Authentic operational Members origin, deterministic SDK mapping, committed receiving and guarded retirement', async () => {
  const input = reservation();
  const partition = partitionOf(input.binding.route);
  const before = (await native.db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partition]))
    .rows[0];
  const result = await produce(input);
  const row = await original(result.locator);
  expect(row.sealed).toBe(true);
  expect(row.source_epoch).toBeGreaterThan(0);
  expect(row.source_position).toBeNull(); // No fictitious event-log position or event-log gap.
  expect(row.log_gap).toBe('operational-work-original-log-position-unavailable');
  expect(row.creation_captured).toBe(true);
  expect(row.workflow_id).toBe(input.intent.workflowId);
  expect(row.intent).toEqual(input.intent);
  expect(row.binding).toEqual(input.binding);
  expect(
    (await native.db.admin.query('SELECT position FROM core.partition WHERE partition_no=$1', [partition])).rows[0],
  ).toEqual(before);
  expect(
    (await native.db.admin.query('SELECT 1 FROM core.receipt WHERE transaction_id=$1', [row.transaction_id])).rows,
  ).toEqual([]);
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  expect(origin).not.toBeNull();
  expect(operationalWorkSource(native.db.pool, origin!).transactionId).toBe(row.transaction_id);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive)).toBe(
    'registered-pending-position',
  );
  const mapping = (
    await native.db.admin.query('SELECT * FROM core.operational_work_mapping WHERE partition_no=0 AND custody_id=$1', [
      result.locator.custodyId,
    ])
  ).rows[0];
  expect(mapping.workflow_id).toBe(input.intent.workflowId);
  expect(mapping.source_transaction).toBe(row.transaction_id);
  expect(mapping.source_position).toBeNull();
  expect(
    (
      await native.db.admin.query('SELECT 1 FROM core.agent_identity_work WHERE custody_id=$1', [
        result.locator.custodyId,
      ])
    ).rows,
  ).toEqual([]);
  await expect(verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, result.replay)).rejects.toThrow(
    'operational-work-original-log-position-unavailable',
  );
  const locator = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: result.locator.custodyId }));
  expect(
    await minimizeHistoryWork(
      native.db.pool,
      native.workClient,
      { partition_no: 0, account_route: input.binding.route, account_id: input.binding.ownerAccountId },
      locator,
      new HistoryRegistry(),
      {
        accountRoute: input.binding.route,
        accountId: input.binding.ownerAccountId,
        version: 1,
        at: new Date().toISOString(),
      },
      undefined,
      { origin: origin!, transfer: result.retirement },
    ),
  ).toBe('operational-work-original-log-position-unavailable');
  await expect(
    native.db.admin.query('UPDATE core.history_work SET absence_verified=true WHERE partition_no=0 AND work_id=$1', [
      result.locator.custodyId,
    ]),
  ).rejects.toThrow('operational-work-source-currentness-unavailable');
  expect(
    (
      await native.db.admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [
        input.intent.workflowId,
      ])
    ).rows,
  ).toHaveLength(1);
});

test('Rollback invalidates the locator transfer and every escaped live handle, and rolls back original plus SDK', async () => {
  const input = reservation();
  let escaped!: OperationalTransaction;
  let locator!: OperationalWorkRegistration;
  let child!: OperationalWorkTransfer;
  await expect(
    runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
      escaped = tx;
      locator = await registerOperationalHistoryWork(tx, input.binding, input.intent);
      child = reserveOperationalWorkTransfer(tx, 'resolve');
      await expect(resolveCommittedOperationalWork(native.db.pool, locator, child)).rejects.toThrow(
        'operational-work-native-transfer-unavailable',
      );
      throw new Error('rollback-original');
    }),
  ).rejects.toThrow('rollback-original');
  expect(() => escaped.query('SELECT 1')).toThrow('No live operational transaction');
  await expect(registerOperationalHistoryWork(escaped, input.binding, input.intent)).rejects.toThrow(
    'No live operational transaction',
  );
  await expect(resolveCommittedOperationalWork(native.db.pool, locator, child)).rejects.toThrow(
    'operational-work-native-transfer-unavailable',
  );
  expect(await original(locator)).toBeUndefined();
  expect(
    (
      await native.db.admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [
        input.intent.workflowId,
      ])
    ).rows,
  ).toEqual([]);
});

test('A failed contention attempt cannot supply a receipt or refill a private transfer', async () => {
  const input = reservation();
  const failed: { locator: OperationalWorkRegistration; token: OperationalWorkTransfer }[] = [];
  let count = 0;
  const result = await runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    const locator = await registerOperationalHistoryWork(tx, input.binding, input.intent);
    if (count++ === 0) {
      failed.push({ locator, token: reserveOperationalWorkTransfer(tx, 'resolve') });
      throw Object.assign(new Error('retry-original'), { code: '40001' });
    }
    return { locator, token: reserveOperationalWorkTransfer(tx, 'resolve') };
  });
  expect(count).toBe(2);
  expect(result.locator.custodyId).not.toBe(failed[0]!.locator.custodyId);
  expect(await original(failed[0]!.locator)).toBeUndefined();
  await expect(resolveCommittedOperationalWork(native.db.pool, failed[0]!.locator, failed[0]!.token)).rejects.toThrow(
    'operational-work-native-transfer-unavailable',
  );
  expect(await resolveCommittedOperationalWork(native.db.pool, result.locator, result.token)).not.toBeNull();
});

test('Repeated real original is idempotent; same native binding with a different body conflicts', async () => {
  const first = await produce();
  const repeated = await runOperationalTransaction(native.db.pool, await options(first.binding), async (tx) =>
    registerOperationalHistoryWork(tx, first.binding, first.intent),
  );
  expect(repeated).toEqual(first.locator);
  const changed = structuredClone(first.binding);
  const basis = canonicalize([
    1,
    changed.ownerAccountId,
    changed.collectionId,
    { status: 'owned' },
    'ordinal',
    'a'.repeat(64),
  ])!;
  const conflicting: OperationalMembersBinding = {
    ...changed,
    episodes: [
      { ...changed.episodes[0]!, canonicalBasis: basis, basisDigest: createHash('sha256').update(basis).digest('hex') },
    ],
  };
  await expect(
    runOperationalTransaction(native.db.pool, await options(conflicting), async (tx) =>
      registerOperationalHistoryWork(tx, conflicting, first.intent),
    ),
  ).rejects.toThrow('Conflicting operational History registration');
  expect((await original(first.locator)).binding).toEqual(first.binding);
});

test('An older uncaptured SDK execution receives inventory but never initial positive custody', async () => {
  const input = reservation();
  const ordinary = await options(input.binding);
  delete ordinary.operationalHistory;
  await runOperationalTransaction(native.db.pool, ordinary, (tx) => enqueueIntent(tx, input.intent));
  const result = await produce(input);
  expect((await original(result.locator)).creation_captured).toBe(false);
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive)).toBe(
    'uncaptured',
  );
  await expect(verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, result.replay)).rejects.toThrow(
    'operational-work-uncaptured-older-execution',
  );
});

test('SDK recreation and receiving restore cannot replay a previously mapped native original', async () => {
  const result = await produce();
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive);
  await native.db.admin.query('UPDATE dbos.workflow_status SET creator_xid=$2 WHERE workflow_uuid=$1', [
    result.intent.workflowId,
    crypto.randomUUID(),
  ]);
  await expect(verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, result.replay)).rejects.toThrow(
    'operational-work-sdk-original-recreated-or-changed',
  );
  const restored = await produce();
  const restoredOrigin = await resolveCommittedOperationalWork(native.db.pool, restored.locator, restored.resolve);
  await receiveCommittedOperationalWork(native.db.pool, native.workClient, restoredOrigin!, restored.receive);
  await native.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=0');
  await expect(
    verifyOperationalWorkReplay(native.db.pool, native.workClient, restoredOrigin!, restored.replay),
  ).rejects.toThrow('operational-work-receiving-restore-or-binding-changed');
});

test('Copied funding and malformed native episode sets refuse before authority or enqueue', async () => {
  const input = reservation();
  expect(() => validateOperationalMembersBinding({ ...input.binding, episodes: [] }, input.intent)).toThrow();
  expect(() =>
    validateOperationalMembersBinding(
      {
        ...input.binding,
        retired: [{ collectionId: input.binding.collectionId, episodeId: input.binding.episodes[0]!.episodeId }],
      },
      input.intent,
    ),
  ).toThrow();
  const result = await produce(input);
  const copied = { ...result.resolve };
  await expect(resolveCommittedOperationalWork(native.db.pool, result.locator, copied)).rejects.toThrow(
    'operational-work-native-transfer-unavailable',
  );
  const other = await produce();
  await expect(resolveCommittedOperationalWork(native.db.pool, other.locator, result.resolve)).rejects.toThrow(
    'operational-work-native-transfer-unavailable',
  );
  expect(await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve)).not.toBeNull();
});

test('Successful commit invalidates escaped live handles and absolute expiry refuses released funding', async () => {
  const input = reservation();
  let escaped!: OperationalTransaction;
  const result = await runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    escaped = tx;
    return {
      locator: await registerOperationalHistoryWork(tx, input.binding, input.intent),
      token: reserveOperationalWorkTransfer(tx, 'resolve'),
    };
  });
  expect(() => escaped.query('SELECT 1')).toThrow('No live operational transaction');
  expect(() => reserveOperationalWorkTransfer(escaped, 'receive')).toThrow('No live operational transaction');
  const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
  try {
    await expect(resolveCommittedOperationalWork(native.db.pool, result.locator, result.token)).rejects.toThrow(
      'operational-work-native-transfer-unavailable',
    );
  } finally {
    now.mockRestore();
  }
});
