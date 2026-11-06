import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import {
  enqueueIntent,
  runOperationalTransaction,
  type OperationalTransaction,
  type OperationalOptions,
} from '../../src/command/operational.ts';
import {
  OPERATIONAL_WORK_DOMAIN,
  registerPositionedOperationalHistoryWork,
  registerOperationalHistoryWork,
  reserveOperationalWorkTransfer,
  resolveCommittedOperationalWork,
  verifyCommittedOperationalWorkOrigin,
  receiveCommittedOperationalWork,
  operationalWorkSource,
} from '../../src/history/adapters/operational-work.ts';
import {
  inspectOperationalWorkRetirement,
  verifyOperationalWorkReplay,
} from '../../src/history/adapters/operational-work-receiving.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import type { WorkIntent } from '../../src/work/client.ts';
import { operationalFixture } from '../command/support/operational-fixture.ts';
import {
  type OperationalMembersBinding,
  type OperationalWorkRegistration,
  type OperationalWorkTransfer,
} from '../../src/history/contract/operational-types.ts';

// UNRUN: native acceptance is owned by the integration controller.
let native: Awaited<ReturnType<typeof operationalFixture>>;
beforeAll(async () => {
  native = await operationalFixture(3088);
  await native.db.admin.query(
    'CREATE TABLE public.positioned_members_reservation(episode uuid PRIMARY KEY,binding jsonb NOT NULL)',
  );
});
afterAll(async () => {
  await native?.close();
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
    operationalHistory: true as const,
  };
}
async function head() {
  return (
    await native.db.admin.query('SELECT * FROM core.operational_work_head WHERE partition_no=$1', [
      partitionOf(routeOf(native.actor.accountId)!),
    ])
  ).rows[0];
}
async function original(locator: OperationalWorkRegistration) {
  return (
    await native.db.admin.query(
      'SELECT * FROM core.operational_work_original WHERE partition_no=$1 AND custody_id=$2',
      [locator.partition, locator.custodyId],
    )
  ).rows[0];
}
async function produce(input = reservation(), legacy = false) {
  return runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    // Commerce retains ownership of its real reservation and episode association serializer.
    await tx.query('INSERT INTO public.positioned_members_reservation VALUES($1,$2)', [
      input.binding.episodes[0]!.episodeId,
      input.binding,
    ]);
    const register = legacy ? registerOperationalHistoryWork : registerPositionedOperationalHistoryWork;
    const locator = await register(tx, input.binding, input.intent);
    expect(await register(tx, input.binding, input.intent)).toBe(locator);
    return {
      ...input,
      locator,
      resolve: reserveOperationalWorkTransfer(tx, 'resolve'),
      verify: reserveOperationalWorkTransfer(tx, 'verify'),
      receive: reserveOperationalWorkTransfer(tx, 'receive'),
      replay: reserveOperationalWorkTransfer(tx, 'replay'),
      retirement: reserveOperationalWorkTransfer(tx, 'retirement'),
    };
  });
}

test('Authentic operational Members origin, deterministic SDK mapping, committed receiving and guarded retirement in operational-work/v1', async () => {
  const input = reservation();
  const partition = partitionOf(input.binding.route);
  const canonicalBefore = (
    await native.db.admin.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partition])
  ).rows[0];
  const before = await head();
  const result = await produce(input);
  const row = await original(result.locator);
  expect(row.source_domain).toBe(OPERATIONAL_WORK_DOMAIN);
  expect(row.source_position).toBe(String(BigInt(before?.position ?? '0') + 1n));
  expect(row.log_gap).toBeNull();
  expect(row.sealed).toBe(true);
  expect(row.creation_captured).toBe(true);
  expect(row.intent).toEqual(input.intent);
  expect(row.binding).toEqual(input.binding);
  expect(
    (await native.db.admin.query('SELECT epoch,position FROM core.partition WHERE partition_no=$1', [partition]))
      .rows[0],
  ).toEqual(canonicalBefore);
  expect(
    (await native.db.admin.query('SELECT 1 FROM core.receipt WHERE transaction_id=$1', [row.transaction_id])).rows,
  ).toEqual([]);
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  expect(origin).not.toBeNull();
  const source = operationalWorkSource(native.db.pool, origin!);
  expect(source.stamp).toEqual({
    domain: OPERATIONAL_WORK_DOMAIN,
    partition,
    epoch: row.source_epoch,
    generation: row.source_generation,
    position: row.source_position,
  });
  expect(await verifyCommittedOperationalWorkOrigin(native.db.pool, origin!, result.verify)).toEqual(source.stamp!);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive)).toBe(
    'registered-pending-source-currentness',
  );
  const mapping = (
    await native.db.admin.query('SELECT * FROM core.operational_work_mapping WHERE partition_no=0 AND custody_id=$1', [
      row.custody_id,
    ])
  ).rows[0];
  expect(mapping.source_domain).toBe(OPERATIONAL_WORK_DOMAIN);
  expect(mapping.source_position).toBe(row.source_position);
  expect(mapping.source.stamp).toEqual(source.stamp!);
  expect(mapping.workflow_id).toBe(input.intent.workflowId);
  expect(
    (await native.db.admin.query('SELECT 1 FROM core.agent_identity_work WHERE custody_id=$1', [row.custody_id])).rows,
  ).toEqual([]);
  await expect(verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, result.replay)).rejects.toThrow(
    'operational-work-source-currentness-unavailable',
  );
  expect(
    await inspectOperationalWorkRetirement(native.db.pool, native.workClient, row.custody_id, {
      origin: origin!,
      transfer: result.retirement,
    }),
  ).toBe('operational-work-source-currentness-unavailable');
  await expect(
    native.db.admin.query('UPDATE core.history_work SET owner_ready=true WHERE partition_no=0 AND work_id=$1', [
      row.custody_id,
    ]),
  ).rejects.toThrow('operational-work-source-currentness-unavailable');
});

test('Rollback loses allocation, reservation and SDK enqueue; precommit/failed handles never resolve', async () => {
  const input = reservation();
  const before = await head();
  let escaped!: OperationalTransaction;
  let locator!: OperationalWorkRegistration;
  let token!: OperationalWorkTransfer;
  await expect(
    runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
      escaped = tx;
      await tx.query('INSERT INTO public.positioned_members_reservation VALUES($1,$2)', [
        input.binding.episodes[0]!.episodeId,
        input.binding,
      ]);
      locator = await registerPositionedOperationalHistoryWork(tx, input.binding, input.intent);
      token = reserveOperationalWorkTransfer(tx, 'resolve');
      await expect(resolveCommittedOperationalWork(native.db.pool, locator, token)).rejects.toThrow(
        'operational-work-native-transfer-unavailable',
      );
      throw new Error('rollback original');
    }),
  ).rejects.toThrow('rollback original');
  expect(await head()).toEqual(before);
  expect(await original(locator)).toBeUndefined();
  expect(
    (
      await native.db.admin.query('SELECT 1 FROM public.positioned_members_reservation WHERE episode=$1', [
        input.binding.episodes[0]!.episodeId,
      ])
    ).rows,
  ).toEqual([]);
  expect(
    (
      await native.db.admin.query('SELECT 1 FROM dbos.workflow_status WHERE workflow_uuid=$1', [
        input.intent.workflowId,
      ])
    ).rows,
  ).toEqual([]);
  expect(() => escaped.query('SELECT 1')).toThrow('No live operational transaction');
  await expect(resolveCommittedOperationalWork(native.db.pool, locator, token)).rejects.toThrow(
    'operational-work-native-transfer-unavailable',
  );
});

test('Failed contention allocations do not escape; one real original owns the next position', async () => {
  const input = reservation();
  const before = await head();
  const failed: { locator: OperationalWorkRegistration; token: OperationalWorkTransfer }[] = [];
  let attempts = 0;
  const result = await runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    const locator = await registerPositionedOperationalHistoryWork(tx, input.binding, input.intent);
    const token = reserveOperationalWorkTransfer(tx, 'resolve');
    if (++attempts < 3) {
      failed.push({ locator, token });
      throw Object.assign(new Error('retry serialization'), { code: '40001' });
    }
    return { locator, token };
  });
  expect(attempts).toBe(3);
  expect((await original(result.locator)).source_position).toBe(String(BigInt(before?.position ?? '0') + 1n));
  for (const attempt of failed) {
    expect(await original(attempt.locator)).toBeUndefined();
    await expect(resolveCommittedOperationalWork(native.db.pool, attempt.locator, attempt.token)).rejects.toThrow(
      'operational-work-native-transfer-unavailable',
    );
  }
  expect(await resolveCommittedOperationalWork(native.db.pool, result.locator, result.token)).not.toBeNull();
});

test('Exact repeated original reuses its position without enqueue; conflicting body cannot remap it', async () => {
  const first = await produce();
  const before = await head();
  const enqueue = spyOn(native.workClient, 'enqueueInTransaction');
  try {
    const repeated = await runOperationalTransaction(native.db.pool, await options(first.binding), (tx) =>
      registerPositionedOperationalHistoryWork(tx, first.binding, first.intent),
    );
    expect(repeated).toEqual(first.locator);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await head()).toEqual(before);
  } finally {
    enqueue.mockRestore();
  }
  const changed = structuredClone(first.binding);
  const episode = changed.episodes[0]!;
  const binding = { ...changed, episodes: [{ ...episode, reservedGeneration: '2' }] };
  await expect(
    runOperationalTransaction(native.db.pool, await options(binding), (tx) =>
      registerPositionedOperationalHistoryWork(tx, binding, first.intent),
    ),
  ).rejects.toThrow('Conflicting operational History registration');
  expect(await head()).toEqual(before);
  await expect(
    native.db.admin.query(
      'UPDATE core.operational_work_original SET source_position=source_position+1 WHERE partition_no=$1 AND custody_id=$2',
      [first.locator.partition, first.locator.custodyId],
    ),
  ).rejects.toThrow('immutable');
});

test('No-intent existing-basis reuse allocates nothing; retained legacy rows are never backfilled', async () => {
  const input = reservation();
  const before = await head();
  await runOperationalTransaction(native.db.pool, await options(input.binding), async () => undefined);
  expect(await head()).toEqual(before);
  const old = await produce(input, true);
  expect(await head()).toEqual(before);
  expect((await original(old.locator)).source_domain).toBe('legacy-unpositioned');
  const repeated = await runOperationalTransaction(native.db.pool, await options(input.binding), (tx) =>
    registerPositionedOperationalHistoryWork(tx, input.binding, input.intent),
  );
  expect(repeated).toEqual(old.locator);
  expect((await original(old.locator)).source_position).toBeNull();
  expect(await head()).toEqual(before);
  const origin = await resolveCommittedOperationalWork(native.db.pool, old.locator, old.resolve);
  await expect(verifyCommittedOperationalWorkOrigin(native.db.pool, origin!, old.verify)).rejects.toThrow(
    'operational-work-original-log-position-unavailable',
  );
});

test('A counter advance without its exact sealed original cannot commit', async () => {
  const input = reservation();
  const before = await head();
  await expect(
    runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
      await tx.query('UPDATE core.operational_work_head SET position=position+1 WHERE partition_no=$1', [
        partitionOf(input.binding.route),
      ]);
    }),
  ).rejects.toThrow('operational-work-native-position-binding-unavailable');
  expect(await head()).toEqual(before);
});

test('A genuine positioned registration never captures an older SDK execution', async () => {
  const input = reservation();
  const ordinary = await options(input.binding);
  delete ordinary.operationalHistory;
  await runOperationalTransaction(native.db.pool, ordinary, (tx) => enqueueIntent(tx, input.intent));
  const result = await produce(input);
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  expect(operationalWorkSource(native.db.pool, origin!).stamp?.domain).toBe(OPERATIONAL_WORK_DOMAIN);
  expect(operationalWorkSource(native.db.pool, origin!).creationCaptured).toBe(false);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive)).toBe(
    'uncaptured',
  );
  await expect(verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, result.replay)).rejects.toThrow(
    'operational-work-uncaptured-older-execution',
  );
});

test('Receiving cannot overwrite a conflicting stamp or deterministic SDK mapping', async () => {
  const result = await produce();
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, result.receive);
  await expect(
    native.db.admin.query(
      `UPDATE core.operational_work_mapping SET source=jsonb_set(source,'{stamp,position}',to_jsonb('9223372036854775807'::text))
     WHERE partition_no=0 AND custody_id=$1`,
      [result.locator.custodyId],
    ),
  ).rejects.toThrow('immutable');
  await expect(
    native.db.admin.query(
      `UPDATE core.operational_work_mapping SET workflow_id=$2 WHERE partition_no=0 AND custody_id=$1`,
      [result.locator.custodyId, `${result.intent.workflowId}:recreated`],
    ),
  ).rejects.toThrow('immutable');
  const mapping = (
    await native.db.admin.query(
      'SELECT source FROM core.operational_work_mapping WHERE partition_no=0 AND custody_id=$1',
      [result.locator.custodyId],
    )
  ).rows[0];
  expect(mapping.source).toEqual(operationalWorkSource(native.db.pool, origin!));
});

test('Positive local provenance grants no replay after SDK recreation or receiver restore', async () => {
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

test('Same-home verification refuses changed source epoch and family generation', async () => {
  const result = await produce();
  const origin = await resolveCommittedOperationalWork(native.db.pool, result.locator, result.resolve);
  await native.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [
    result.locator.partition,
  ]);
  await expect(verifyCommittedOperationalWorkOrigin(native.db.pool, origin!, result.verify)).rejects.toThrow(
    'operational-work-source-restore-fence-changed',
  );
  const current = await produce();
  const currentOrigin = await resolveCommittedOperationalWork(native.db.pool, current.locator, current.resolve);
  await native.db.admin.query('UPDATE core.history_family_domain SET generation=generation+1 WHERE singleton');
  await expect(verifyCommittedOperationalWorkOrigin(native.db.pool, currentOrigin!, current.verify)).rejects.toThrow(
    'operational-work-source-restore-fence-changed',
  );
});

test('Expired handles and copied/foreign transfers refuse before checkout; counter cannot reset or disappear', async () => {
  const input = reservation();
  let escaped!: OperationalTransaction;
  const result = await runOperationalTransaction(native.db.pool, await options(input.binding), async (tx) => {
    escaped = tx;
    return {
      locator: await registerPositionedOperationalHistoryWork(tx, input.binding, input.intent),
      token: reserveOperationalWorkTransfer(tx, 'resolve'),
    };
  });
  expect(() => reserveOperationalWorkTransfer(escaped, 'verify')).toThrow('No live operational transaction');
  const checkout = spyOn(native.db.pool, 'connect');
  try {
    await expect(resolveCommittedOperationalWork(native.db.pool, result.locator, { ...result.token })).rejects.toThrow(
      'operational-work-native-transfer-unavailable',
    );
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      await expect(resolveCommittedOperationalWork(native.db.pool, result.locator, result.token)).rejects.toThrow(
        'operational-work-native-transfer-unavailable',
      );
    } finally {
      clock.mockRestore();
    }
    expect(checkout).not.toHaveBeenCalled();
  } finally {
    checkout.mockRestore();
  }
  await expect(
    native.db.admin.query('UPDATE core.operational_work_head SET position=position-1 WHERE partition_no=$1', [
      result.locator.partition,
    ]),
  ).rejects.toThrow('must advance exactly once');
  await expect(
    native.db.admin.query('DELETE FROM core.operational_work_head WHERE partition_no=$1', [result.locator.partition]),
  ).rejects.toThrow('permanent');
});
