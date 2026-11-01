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
