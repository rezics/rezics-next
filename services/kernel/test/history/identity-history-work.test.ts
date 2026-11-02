import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { CommandTransaction } from '../../src/command/command.ts';
import { verifyAgentIdentityRecoveryArtifactReadiness } from '../../src/history/agent-identity-recovery-receiving.ts';
import {
  activeIdentitySourceConsumerMaintenance,
  identitySourceConsumerNativeWork,
  withIdentitySourceConsumerMaintenance,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import {
  IdentityHistoryWorkUnavailable,
  nativeWork,
  reserveIdentityHistoryWork,
} from '../../src/history/agent-identity-inventory-work.ts';
import { minimizeHistoryWork } from '../../src/history/durable.ts';
import { encodeLocator } from '../../src/history/locator.ts';
import { HistoryRegistry, type HistoryBarrier } from '../../src/history/registry.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { WorkClient } from '../../src/work/client.ts';
import {
  ORIGINAL_AXES,
  HISTORY_ORIGINAL_SELECTION,
  HISTORY_ORIGINAL_VALIDATION,
  HISTORY_ORIGINAL_SETTLEMENT,
  originalWorkVector,
  sumOriginalControl,
  historyOriginalPosition,
  consumeSelectedHistoryOriginal,
  identityOriginalRemainder,
  IdentityOriginalUnavailable,
  type IdentityOriginalTransfer,
  type SelectedHistoryPosition,
} from '../../src/access/identity-original-admission.ts';
import {
  bindIdentityOriginalEffect,
  associateIdentityFxOriginal,
  validateIdentityOriginalEvent,
  requireIdentityFxOriginalDispatch,
  IDENTITY_FX_CHILD_DECLARATION_MISSING,
  identityFxSourceIncarnation,
} from '../../src/history/identity-original-association.ts';
import type { CloudEvent, Envelope } from '../../src/events/log.ts';
import type { Effect } from '../../src/events/effects.ts';

function checkoutSentinel(message: string) {
  const failure = new Error(message);
  let checkouts = 0;
  const pool = {
    connect() {
      checkouts++;
      throw failure;
    },
  } as unknown as Pool;
  return { pool, failure, checkouts: () => checkouts };
}

const cost = nativeWork(1, 2, 3, 4);

test('The implicit History reservation retains the original same-Pool token and deadline and debits the existing native balance', async () => {
  const { pool } = checkoutSentinel('reservation must precede checkout');
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    expect(activeIdentitySourceConsumerMaintenance(pool)).toEqual(funded);
    const before = identitySourceConsumerNativeWork(pool, funded.identityConsumerWork, funded.deadline)!;
    await reserveIdentityHistoryWork(pool, cost);
    const after = identitySourceConsumerNativeWork(pool, funded.identityConsumerWork, funded.deadline)!;
    expect({
      rows: before.rows - after.rows,
      points: before.points - after.points,
      statements: before.statements - after.statements,
      bytes: before.bytes - after.bytes,
      engineRequests: before.engineRequests - after.engineRequests,
    }).toEqual(cost);
  });
});

test('Implicit, explicit, expired, detached and exhausted Source authority refuses before checkout', async () => {
  const original = checkoutSentinel('original Pool must not be checked out');
  const foreign = checkoutSentinel('foreign Pool must not be checked out');
  const deadline = Date.now() + 5000;
  let ended: IdentitySourceConsumerMaintenanceContext | undefined;

  await withIdentitySourceConsumerMaintenance({ pool: original.pool, env: {} }, { deadline }, async (funded) => {
    ended = funded;
    await expect(reserveIdentityHistoryWork(foreign.pool, cost)).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
    await expect(
      reserveIdentityHistoryWork(original.pool, cost, {
        ...funded,
        identityConsumerWork: { ...funded.identityConsumerWork },
      }),
    ).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
    await expect(reserveIdentityHistoryWork(foreign.pool, cost, funded)).rejects.toBeInstanceOf(
      IdentityHistoryWorkUnavailable,
    );
    await expect(
      reserveIdentityHistoryWork(original.pool, cost, {
        deadline: funded.deadline,
        identityConsumerWork: undefined as unknown as IdentitySourceConsumerMaintenanceContext['identityConsumerWork'],
      }),
    ).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
  });
  await expect(reserveIdentityHistoryWork(original.pool, cost, ended)).rejects.toBeInstanceOf(
    IdentityHistoryWorkUnavailable,
  );
  expect(original.checkouts()).toBe(0);
  expect(foreign.checkouts()).toBe(0);

  const expired = checkoutSentinel('expired frame must refuse before checkout');
  const expiringDeadline = Date.now() + 20;
  await withIdentitySourceConsumerMaintenance(
    { pool: expired.pool, env: {} },
    { deadline: expiringDeadline },
    async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(activeIdentitySourceConsumerMaintenance(expired.pool)?.deadline).toBe(expiringDeadline);
      await expect(reserveIdentityHistoryWork(expired.pool, cost)).rejects.toBeInstanceOf(
        IdentityHistoryWorkUnavailable,
      );
    },
  );
  expect(expired.checkouts()).toBe(0);

  const detached = checkoutSentinel('settled descendant must refuse before checkout');
  let lateReservation: Promise<void> | undefined;
  await withIdentitySourceConsumerMaintenance(
    { pool: detached.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (funded) => {
      lateReservation = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
        expect(activeIdentitySourceConsumerMaintenance(detached.pool)).toEqual(funded);
        await reserveIdentityHistoryWork(detached.pool, cost);
      });
    },
  );
  await expect(lateReservation).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
  expect(detached.checkouts()).toBe(0);

  const limited = {
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS: '1',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_POINTS: '1',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '1',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_BYTES: '1',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ENGINE_REQUESTS: '0',
  };
  const axes = ['rows', 'points', 'statements', 'bytes', 'engineRequests'] as const;
  for (const axis of axes) {
    const exhausted = checkoutSentinel(`${axis} exhaustion must refuse before checkout`);
    await withIdentitySourceConsumerMaintenance(
      { pool: exhausted.pool, env: limited },
      { deadline: Date.now() + 5000 },
      async () => {
        const amount = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
        amount[axis] = 2;
        await expect(reserveIdentityHistoryWork(exhausted.pool, amount)).rejects.toBeInstanceOf(
          IdentityHistoryWorkUnavailable,
        );
      },
    );
    expect(exhausted.checkouts()).toBe(0);
  }
});

test('The durable History caller refuses inherited no-token wrong-Pool authority before checkout', async () => {
  const original = checkoutSentinel('original Source Pool must not be checked out');
  const foreign = checkoutSentinel('wrong-Pool durable caller must refuse before checkout');
  const route = 0x9d10;
  const accountId = newId(route);
  const barrier: HistoryBarrier = {
    accountId,
    accountRoute: routeOf(accountId)!,
    version: 1,
    at: new Date().toISOString(),
  };
  const locator = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: randomUUID() }));

  await withIdentitySourceConsumerMaintenance(
    { pool: original.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async () => {
      await expect(
        minimizeHistoryWork(
          foreign.pool,
          {} as WorkClient,
          { partition_no: 0, account_route: barrier.accountRoute, account_id: accountId },
          locator,
          new HistoryRegistry(),
          barrier,
        ),
      ).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
    },
  );

  expect(original.checkouts()).toBe(0);
  expect(foreign.checkouts()).toBe(0);
});

test('The installed independent Work readiness callback retains its precise missing-command gap before SQL', async () => {
  let queries = 0;
  const tx = {
    async query() {
      queries++;
      throw new Error('unfunded Work readiness must not dispatch SQL');
    },
  } as unknown as CommandTransaction;
  const answer = await verifyAgentIdentityRecoveryArtifactReadiness(tx, {
    partition: 0,
    locator: {
      artifactType: 'command-receipt/v1',
      partitionNo: 0,
      principalKind: 'account',
      principalId: randomUUID(),
      commandKindId: 1,
      keyVersion: 0,
      keyToken: '0'.repeat(64),
    },
    accounts: [],
  });

  expect(answer).toEqual({ state: 'pending', gap: 'agent-identity-recovery-command-resources-unavailable' });
  expect(queries).toBe(0);
});

test('Durable History mapping failures and repeated invocations keep their original pre-checkout charges', async () => {
  const sentinel = checkoutSentinel('durable mapping checkout sentinel');
  const route = 0x9d10;
  const accountId = newId(route);
  const barrier: HistoryBarrier = {
    accountId,
    accountRoute: routeOf(accountId)!,
    version: 1,
    at: new Date().toISOString(),
  };
  const locator = Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: randomUUID() }));
  const registry = new HistoryRegistry();
  const client = {} as WorkClient;
  const deadline = Date.now() + 5000;

  await withIdentitySourceConsumerMaintenance({ pool: sentinel.pool, env: {} }, { deadline }, async (funded) => {
    const before = identitySourceConsumerNativeWork(sentinel.pool, funded.identityConsumerWork, funded.deadline)!;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(
        minimizeHistoryWork(
          sentinel.pool,
          client,
          { partition_no: 0, account_route: barrier.accountRoute, account_id: accountId },
          locator,
          registry,
          barrier,
        ),
      ).rejects.toBe(sentinel.failure);
      expect(sentinel.checkouts()).toBe(attempt);
      const after = identitySourceConsumerNativeWork(sentinel.pool, funded.identityConsumerWork, funded.deadline)!;
      expect({
        rows: before.rows - after.rows,
        points: before.points - after.points,
        statements: before.statements - after.statements,
        bytes: before.bytes - after.bytes,
        engineRequests: before.engineRequests - after.engineRequests,
      }).toEqual({
        rows: 4 * attempt,
        points: 4 * attempt,
        statements: 3 * attempt,
        bytes: 16384 * attempt,
        engineRequests: 0,
      });
    }
  });
});

test('Original control declarations validate every safe integer axis and reject missing or additional dimensions', () => {
  const allowance = sumOriginalControl(
    HISTORY_ORIGINAL_SELECTION,
    HISTORY_ORIGINAL_VALIDATION,
    HISTORY_ORIGINAL_SETTLEMENT,
  );
  expect(originalWorkVector(allowance)).toHaveLength(8);
  for (const axis of ORIGINAL_AXES)
    for (const value of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => originalWorkVector({ ...allowance, [axis]: value })).toThrow(RangeError);
    }
  expect(() => originalWorkVector({ ...allowance, unpriced: 1 } as typeof allowance)).toThrow(RangeError);
  expect(() => sumOriginalControl({ ...allowance, bytes: Number.MAX_SAFE_INTEGER }, allowance)).toThrow(RangeError);
});

function originalPosition(): SelectedHistoryPosition {
  const accountId = newId(0x9d10);
  return {
    job_id: randomUUID(),
    partition_no: 0x9d1,
    account_route: 0x9d10,
    account_id: accountId,
    barrier_id: accountId,
    barrier_version: 1,
    barrier_at: new Date().toISOString(),
    phase: 'scan',
    scan_partition: 0,
    verify_partition: 0,
    scan_type: 'durable-work/v1',
    scan_locator: Buffer.from([1, 3]),
    registry_digest: '1'.repeat(64),
    registry_generation: '1',
  };
}

test('Original position includes the exact native home, account barrier, registry and both cursors', () => {
  const position = originalPosition();
  const bound = historyOriginalPosition(position);
  expect(bound.scan_locator).toBe('0103');
  for (const change of [
    { scan_partition: 1 },
    { verify_partition: 1 },
    { phase: 'verify' as const },
    { scan_locator: Buffer.from([1, 3, 0]) },
    { registry_generation: '2' },
    { registry_digest: '2'.repeat(64) },
  ]) {
    expect(historyOriginalPosition({ ...position, ...change })).not.toEqual(bound);
  }
  for (const change of [
    { partition_no: 0 },
    { barrier_id: randomUUID() },
    { scan_partition: 4097 },
    { scan_locator: Buffer.alloc(257) },
    { scan_locator: null },
    { registry_generation: '9007199254740992' },
  ]) {
    expect(() => historyOriginalPosition({ ...position, ...change })).toThrow(IdentityOriginalUnavailable);
  }
  position.scan_locator!.fill(0);
  expect(bound.scan_locator).toBe('0103');
});

test('Copied original handles and wrong Pool/client/position refuse before any affected checkout', async () => {
  const home = checkoutSentinel('original refusal must precede checkout');
  const foreign = checkoutSentinel('foreign refusal must precede checkout');
  const token = Object.freeze({}) as IdentityOriginalTransfer;
  const deps = { pool: home.pool, client: {} as WorkClient, registry: new HistoryRegistry() };
  for (const altered of [deps, { ...deps, pool: foreign.pool }, { ...deps, client: {} as WorkClient }]) {
    await expect(consumeSelectedHistoryOriginal(altered, token, randomUUID())).rejects.toBeInstanceOf(
      IdentityOriginalUnavailable,
    );
    expect(() => identityOriginalRemainder(altered, { ...token }, randomUUID())).toThrow(IdentityOriginalUnavailable);
  }
  expect(home.checkouts()).toBe(0);
  expect(foreign.checkouts()).toBe(0);
});

function originalEnvelope(): Envelope {
  const accountId = newId(0x9d10);
  const event: CloudEvent = {
    specversion: '1.0',
    id: randomUUID(),
    source: 'urn:rezics:log:2513.1',
    type: 'com.rezics.access.agent-verification.reversing.v1',
    subject: accountId,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    sequence: '0000000000000000001',
    data: {
      accountId,
      catalogueSubjectId: newId(0x9d10),
      verificationReceiptId: randomUUID(),
      receiptId: randomUUID(),
      requestedBy: accountId,
      kind: 'released',
      reason: null,
    },
  };
  return { partition: 2513, epoch: 1, position: 1n, events: [event] };
}

test('Identity fx wrapper rejects wrong native position/epoch/partition before association IO', () => {
  const envelope = originalEnvelope();
  expect<unknown>(validateIdentityOriginalEvent(envelope, 0)).toEqual(envelope.events[0]!.data);
  for (const altered of [
    { ...envelope, position: 2n },
    { ...envelope, epoch: 2 },
    { ...envelope, partition: 2514 },
    { ...envelope, epoch: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    expect(() => validateIdentityOriginalEvent(altered, 0)).toThrow(IdentityOriginalUnavailable);
  }
  expect(() => validateIdentityOriginalEvent(envelope, 1)).toThrow(IdentityOriginalUnavailable);
});

test('Identity fx keeps a precise missing child declaration and authentic producer binding before dispatch', async () => {
  const home = checkoutSentinel('missing child must not dispatch');
  const foreign = checkoutSentinel('wrong Pool must not dispatch');
  let ran = false;
  const effect: Effect = bindIdentityOriginalEffect(
    {
      name: 'agent_verification_reversal',
      types: ['com.rezics.access.agent-verification.reversing.v1'],
      async run() {
        ran = true;
      },
    },
    { pool: home.pool, client: {} as WorkClient },
  );
  expect(() => requireIdentityFxOriginalDispatch(effect, home.pool)).toThrow(IDENTITY_FX_CHILD_DECLARATION_MISSING);
  const envelope = originalEnvelope();
  await expect(associateIdentityFxOriginal({ ...effect }, home.pool, envelope, 0, 'copied')).rejects.toThrow(
    'identity-fx-original-producer-unavailable',
  );
  await expect(associateIdentityFxOriginal(effect, foreign.pool, envelope, 0, 'wrong-pool')).rejects.toThrow(
    'identity-fx-original-producer-unavailable',
  );
  expect(home.checkouts()).toBe(0);
  expect(foreign.checkouts()).toBe(0);
  expect(ran).toBe(false);
});

test('Identity fx source binding pins both native enrollment generations without rounding or adopting later state', () => {
  const source = {
    intent_digest: '1'.repeat(64),
    source_transaction_id: randomUUID(),
    workflow_id: 'native-original',
    delivery_key: 'original-delivery',
    undo_job_id: randomUUID(),
    undo_job_epoch: '1',
    receiver_epoch: 1,
    domain_generation: '1',
    inventory_generation: '1',
    obligation_generation: '1',
  };
  const pinned = identityFxSourceIncarnation(source);
  expect(Object.isFrozen(pinned)).toBe(true);
  source.inventory_generation = '2';
  source.obligation_generation = '2';
  expect(identityFxSourceIncarnation(source)).not.toEqual(pinned);
  expect(pinned.inventory_generation).toBe('1');
  expect(pinned.obligation_generation).toBe('1');
  expect(() => identityFxSourceIncarnation({ ...source, obligation_generation: '1' })).toThrow(
    'source-incarnation-unavailable',
  );

  const exact = '9007199254740993';
  const large = identityFxSourceIncarnation({
    ...source,
    domain_generation: exact,
    inventory_generation: exact,
    obligation_generation: exact,
  });
  expect(large.inventory_generation).toBe(exact);
  expect(large.obligation_generation).toBe(exact);
  expect(large.domain_generation).toBe(exact);
  for (const value of ['', '0', '-1', '1.5', '01', '9223372036854775808', 'Infinity']) {
    expect(() => identityFxSourceIncarnation({ ...source, domain_generation: value })).toThrow(
      'source-incarnation-unavailable',
    );
    expect(() =>
      identityFxSourceIncarnation({ ...source, inventory_generation: value, obligation_generation: value }),
    ).toThrow('source-incarnation-unavailable');
  }
});

test('Original work vectors require all eight own axes and reject hidden additional dimensions', () => {
  const allowance = HISTORY_ORIGINAL_SELECTION;
  const inherited = Object.assign(Object.create({ candidateKeys: allowance.candidateKeys }), allowance) as Record<
    string,
    unknown
  >;
  delete inherited.candidateKeys;
  inherited.unpriced = 0;
  expect(() => originalWorkVector(inherited as unknown as typeof allowance)).toThrow(RangeError);

  const hidden = Object.defineProperty({ ...allowance }, 'unpriced', { value: 0 });
  expect(() => originalWorkVector(hidden)).toThrow(RangeError);
  const symbol = Object.defineProperty({ ...allowance }, Symbol('unpriced'), { value: 0 });
  expect(() => originalWorkVector(symbol)).toThrow(RangeError);
});

test('Original work encoding preserves the same safe snapshot that was validated', () => {
  let reads = 0;
  const declaration = Object.defineProperty({ ...HISTORY_ORIGINAL_SELECTION }, 'bytes', {
    enumerable: true,
    get: () => (++reads === 1 ? 8192 : Number.MAX_SAFE_INTEGER + 1),
  });
  const vector = originalWorkVector(declaration);
  expect(reads).toBe(1);
  expect(vector[ORIGINAL_AXES.indexOf('bytes')]).toBe(8192);
  expect(Object.isFrozen(vector)).toBe(true);
});

test('Private original transfer cannot be reconstructed from a structural grant or a configured Source frame', async () => {
  const { withIdentityOriginalSourceTransfer, reserveIdentityOriginalSourceWork, identityOriginalLibraryWork } =
    await import('../../src/access/identity-original-admission.ts');
  const selected = checkoutSentinel('a structural original cannot fund a child');
  const deps = { pool: selected.pool, client: {} as WorkClient, registry: new HistoryRegistry() };
  const job = randomUUID();
  const token = {} as import('../../src/access/identity-original-admission.ts').IdentityOriginalSourceGrant;
  let dispatched = false;
  await withIdentitySourceConsumerMaintenance(
    { pool: selected.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async () => {
      await expect(
        withIdentityOriginalSourceTransfer(deps, {} as IdentityOriginalTransfer, job, async () => {
          dispatched = true;
        }),
      ).rejects.toThrow('handle-unavailable');
      expect(() => reserveIdentityOriginalSourceWork(deps, token, job, HISTORY_ORIGINAL_SELECTION)).toThrow(
        'private-grant-unavailable',
      );
      expect(() => identityOriginalLibraryWork(deps, token, job)).toThrow('private-grant-unavailable');
    },
  );
  expect(dispatched).toBe(false);
  expect(selected.checkouts()).toBe(0);
});
