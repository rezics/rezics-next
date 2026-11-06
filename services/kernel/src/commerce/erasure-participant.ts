import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { acknowledgeErasure, resolveRetention, type RetentionException } from '../access/erasure.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readHistoryOwnerCoverage } from '../history/receiving.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
// Load the same permanent kind bindings even when Stripe is unconfigured.
import './erasure-history.ts';
import account from './erasure-account.sql';
import obligation from './erasure-obligation.sql';
import proof from './erasure-proof.sql';
import unsupportedProof from './erasure-unsupported-proof.sql';
import initialize from './erasure-progress.sql';
import read from './erasure-read.sql';
import pageEntitlements from './erasure-page.sql';
import pageAcquisitions from './erasure-acquisition-page.sql';
import purgeEntitlements from './erasure-purge.sql';
import purgeAcquisitions from './erasure-acquisition-purge.sql';
import deleteMoneyObservations from './erasure-money-observation-delete.sql';
import pageOrders from './erasure-order-page.sql';
import minimizeOrders from './erasure-order-minimize.sql';
import pageRetained from './erasure-retained-page.sql';
import purgeRetained from './erasure-retained-purge.sql';
import purgeSales from './erasure-creator-sales.sql';
import checkpoint from './erasure-checkpoint.sql';
import readRetention from './erasure-retention-read.sql';
import insertRetentionPolicy from './erasure-retention-policy-insert.sql';
import readRetentionPolicy from './erasure-retention-policy-read.sql';
import listRetentionPolicy from './erasure-retention-policy-list.sql';
import readRetentionOwner from './erasure-retention-owner.sql';

export const COMMERCE_ERASURE_WORKFLOW = 'commerce.eraseAccount';
export const commerceErasureWorkflowId = (accountId: string) => `commerce:erasure:${accountId}:v1`;
export const FINANCIAL_ERASURE_BLOCKER =
  'Financial field/purpose/jurisdiction/expiry schedule; receipt/outbox/write-basis and DBOS minimizers; ' +
  'delegation/operator historical locators; Stripe Session/PaymentIntent/Charge/Product/refund custody and backup expiry unresolved';

export const COMMERCE_CUSTODY_BLOCKER =
  'UNKNOWN: Commerce command/outbox/durable producer conversion and receiving custody; ' +
  'write-basis/operational intent minimizers; foreign seller/creator locators and sealed coverage';

/** The only currently supported order-retention policy is a deterministic native-test fixture policy. */
export const NATIVE_TEST_ORDER_RETENTION_FIELDS = ['buyer_account_id', 'checkout_url', 'expires_at'] as const;
export const NATIVE_TEST_ORDER_RETENTION_PURPOSE =
  'Finite native test retention of the exact original Checkout capability.';
export const ORDER_RETENTION_STORE = 'commerce.purchase_order_retained';
export const ORDER_RETENTION_BLOCKER =
  'Order retention policy is not configured uniformly for every buyer order before the account barrier';

const ZERO = '00000000-0000-0000-0000-000000000000';
type Progress = {
  hadData: boolean;
  cursor: string;
  phase: string;
  blocker: string | null;
  retentionStore: string | null;
  retentionFields: string[] | null;
  retentionPurpose: string | null;
  retentionExpiresAt: string | null;
};
type Advance = 'none' | 'more' | 'pending' | 'retained' | 'resolve';

function routeForAccount(accountId: string): number {
  const route = routeOf(accountId);
  if (route === null) throw new Error('Invalid commerce erasure account');
  return route;
}

function checkpointInput(
  key: { route: number; account_id: string },
  progress: Progress,
  cursor: string,
  phase: string,
  blocker: string | null,
  retention?: Partial<Pick<Progress, 'retentionStore' | 'retentionFields' | 'retentionPurpose' | 'retentionExpiresAt'>>,
) {
  return {
    ...key,
    cursor,
    phase,
    blocker: blocker ?? '',
    retention_store: retention?.retentionStore ?? progress.retentionStore,
    retention_fields: retention?.retentionFields ?? progress.retentionFields,
    retention_purpose: retention?.retentionPurpose ?? progress.retentionPurpose,
    retention_expires_at: retention?.retentionExpiresAt ?? progress.retentionExpiresAt,
  };
}

async function changeProgress(pool: Pool, accountId: string, phase: string, blocker: string | null) {
  const route = routeForAccount(accountId);
  const key = { route, account_id: accountId };
  await runCommand(
    pool,
    {
      partition: partitionOf(route),
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-commerce-erasure',
        requestedBy: null,
      },
    },
    async (tx) => {
      const current = await account.run(tx, key);
      const barrier = await obligation.run(tx, key);
      if (current?.state !== 'deleted' || barrier?.version !== 1)
        throw new Error('Commerce erasure requires the committed native version 1 tombstone');
      const progress = (await read.run(tx, key)) as Progress | null;
      if (!progress) throw new Error('Commerce erasure progress unavailable');
      if (progress.phase === phase && progress.blocker === blocker) return noEffect(null);
      await checkpoint.run(tx, checkpointInput(key, progress, progress.cursor, phase, blocker));
      return {
        value: null,
        events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
      };
    },
  );
}

/**
 * Trusted native fixture/composition seam. It attaches one explicit, finite policy to an already
 * created order; there is no HTTP input or production default for this test policy.
 */
export async function prepareCommerceOrderRetention(pool: Pool, input: { orderId: string; expiresAt: Date }) {
  const route = routeOf(input.orderId);
  if (route === null) throw new Error('Invalid native Commerce order locator');
  const ownerKey = { route, order_id: input.orderId };
  const fields = [...NATIVE_TEST_ORDER_RETENTION_FIELDS];
  const expiresAt = input.expiresAt.toISOString();
  return runCommand(
    pool,
    {
      partition: partitionOf(route),
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-commerce-erasure-fixture',
        requestedBy: null,
      },
    },
    async (tx, { time }) => {
      if (Date.parse(expiresAt) <= Date.parse(authoritativeTimeValue(time)))
        throw new Error('Native Commerce retention expiry must be after configuration');
      const owner = (await readRetentionOwner.run(tx, ownerKey))[0];
      if (!owner) throw new Error('Order retention configuration requires a genuine active native order');
      const prior = await listRetentionPolicy.run(tx, { route, account_id: owner.buyerAccountId });
      if (
        prior &&
        (prior.purpose !== NATIVE_TEST_ORDER_RETENTION_PURPOSE ||
          Date.parse(prior.expiresAt) !== Date.parse(expiresAt) ||
          prior.fields.join('\0') !== fields.join('\0'))
      )
        throw new Error('A buyer account has one exact Commerce order-retention policy');
      const inserted = await insertRetentionPolicy.run(tx, {
        route,
        order_id: input.orderId,
        fields,
        purpose: NATIVE_TEST_ORDER_RETENTION_PURPOSE,
        expires_at: expiresAt,
      });
      const retained = await readRetentionPolicy.run(tx, {
        route,
        order_id: input.orderId,
        account_id: owner.buyerAccountId,
      });
      if (
        !retained ||
        retained.purpose !== NATIVE_TEST_ORDER_RETENTION_PURPOSE ||
        Date.parse(retained.expiresAt) !== Date.parse(expiresAt) ||
        retained.fields.join('\0') !== fields.join('\0')
      )
        throw new Error('Commerce order retention configuration did not commit exactly');
      const value = {
        orderId: input.orderId,
        store: ORDER_RETENTION_STORE,
        fields,
        purpose: retained.purpose,
        expiresAt,
      };
      return inserted.length
        ? {
            value,
            events: [
              {
                type: 'com.rezics.access.account-updated.v1',
                subject: owner.buyerAccountId,
                data: { accountId: owner.buyerAccountId },
              },
            ],
          }
        : noEffect(value);
    },
  );
}

/** One committed, bounded page. No initiator, provider call, callback proof or fabricated Actor. */
export async function advanceCommerceErasure(pool: Pool, accountId: string): Promise<Advance> {
  const route = routeForAccount(accountId);
  const key = { route, account_id: accountId };
  const result = await runCommand<Advance>(
    pool,
    {
      partition: partitionOf(route),
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'internal-commerce-erasure',
        requestedBy: null,
      },
    },
    async (tx, { time }) => {
      const current = await account.run(tx, key);
      const barrier = await obligation.run(tx, key);
      if (current?.state !== 'deleted' || barrier?.version !== 1)
        throw new Error('Commerce erasure requires the committed native version 1 tombstone');
      const found = await proof.run(tx, key);
      if (!found) throw new Error('Commerce native ownership proof unavailable');
      await initialize.run(tx, { ...key, had_data: found.hasData });
      const progress = (await read.run(tx, key)) as Progress | null;
      if (!progress) throw new Error('Commerce erasure progress unavailable');

      if (progress.phase === 'none') return noEffect('none' as const);
      if (progress.phase === 'pending') return noEffect('pending' as const);
      if (progress.phase === 'retained') {
        const now = authoritativeTimeValue(time);
        if (progress.retentionExpiresAt !== null && Date.parse(progress.retentionExpiresAt) <= Date.parse(now)) {
          const retained = await pageRetained.run(tx, {
            ...key,
            after: progress.cursor,
            now,
          });
          if (retained.length) {
            const removed = await purgeRetained.run(tx, {
              ...key,
              ids: retained.map((row) => row.id),
              now,
            });
            if (removed.length !== retained.length) throw new Error('Commerce retained-order purge was incomplete');
          }
          const nextPhase =
            retained.length === 100
              ? 'retained'
              : progress.blocker && progress.blocker !== COMMERCE_CUSTODY_BLOCKER
                ? 'pending'
                : 'resolve';
          await checkpoint.run(
            tx,
            checkpointInput(key, progress, retained.at(-1)?.id ?? progress.cursor, nextPhase, progress.blocker),
          );
          return {
            value: nextPhase === 'retained' ? ('more' as const) : nextPhase,
            events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
          };
        }
        return noEffect('retained' as const);
      }
      if (progress.phase === 'resolve') return noEffect('resolve' as const);

      // Projection cleanup also runs for already-pending financial accounts.
      const removedSales = await purgeSales.run(tx, key);
      if (removedSales.length)
        return {
          value: 'more' as const,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };

      if (progress.phase === 'entitlements') {
        const keys = await pageEntitlements.run(tx, { ...key, after: progress.cursor });
        if (keys.length) await purgeEntitlements.run(tx, { ...key, ids: keys.map((row) => row.id) });
        const full = keys.length === 100;
        await checkpoint.run(
          tx,
          checkpointInput(key, progress, full ? keys.at(-1)!.id : ZERO, full ? 'entitlements' : 'acquisitions', ''),
        );
        return {
          value: 'more' as const,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      }

      if (progress.phase === 'acquisitions') {
        const keys = await pageAcquisitions.run(tx, { ...key, after: progress.cursor });
        if (keys.length) await purgeAcquisitions.run(tx, { ...key, ids: keys.map((row) => row.id) });
        const full = keys.length === 100;
        await checkpoint.run(
          tx,
          checkpointInput(
            key,
            progress,
            full ? keys.at(-1)!.id : ZERO,
            full ? 'acquisitions' : 'money-observations',
            '',
          ),
        );
        return {
          value: 'more' as const,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      }

      if (progress.phase === 'money-observations') {
        const removed = await deleteMoneyObservations.run(tx, { route, buyer: accountId });
        const full = removed.length === 100;
        await checkpoint.run(tx, checkpointInput(key, progress, ZERO, full ? 'money-observations' : 'orders', ''));
        return {
          value: 'more' as const,
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      }

      if (progress.phase === 'orders') {
        const unsupported = await unsupportedProof.run(tx, key);
        let blocker = unsupported?.unsupportedData ? FINANCIAL_ERASURE_BLOCKER : progress.blocker;
        const orders = await pageOrders.run(tx, { ...key, after: progress.cursor });
        if (orders.length === 0) {
          if (!progress.hadData) {
            await checkpoint.run(tx, checkpointInput(key, progress, ZERO, 'pending', COMMERCE_CUSTODY_BLOCKER));
            return {
              value: 'pending' as const,
              events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
            };
          }
          const nextPhase = blocker && progress.retentionStore === null ? 'pending' : 'retained';
          await checkpoint.run(
            tx,
            checkpointInput(
              key,
              progress,
              ZERO,
              nextPhase,
              nextPhase === 'retained' ? (blocker ?? COMMERCE_CUSTODY_BLOCKER) : blocker,
            ),
          );
          return {
            value: nextPhase,
            events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
          };
        }

        let retainedPolicy = {
          retentionStore: progress.retentionStore,
          retentionFields: progress.retentionFields,
          retentionPurpose: progress.retentionPurpose,
          retentionExpiresAt: progress.retentionExpiresAt,
        };
        const retainedOrderIds: string[] = [];
        for (const order of orders) {
          if (order.minimized) continue;
          if (
            !order.hasCheckoutUrl ||
            order.fields === null ||
            order.purpose === null ||
            order.expiresAt === null ||
            order.fields.join('\0') !== NATIVE_TEST_ORDER_RETENTION_FIELDS.join('\0') ||
            order.purpose !== NATIVE_TEST_ORDER_RETENTION_PURPOSE
          ) {
            blocker = ORDER_RETENTION_BLOCKER;
            continue;
          }
          const priorExpiry = retainedPolicy.retentionExpiresAt;
          if (
            (priorExpiry !== null && Date.parse(priorExpiry) !== Date.parse(order.expiresAt)) ||
            (retainedPolicy.retentionPurpose !== null && retainedPolicy.retentionPurpose !== order.purpose) ||
            (retainedPolicy.retentionFields !== null &&
              retainedPolicy.retentionFields.join('\0') !== order.fields.join('\0'))
          ) {
            blocker = ORDER_RETENTION_BLOCKER;
            continue;
          }
          retainedPolicy = {
            retentionStore: ORDER_RETENTION_STORE,
            retentionFields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
            retentionPurpose: order.purpose,
            retentionExpiresAt: order.expiresAt,
          };
          retainedOrderIds.push(order.id);
        }
        if (retainedOrderIds.length) {
          const minimized = await minimizeOrders.run(tx, {
            ...key,
            ids: retainedOrderIds,
            at: barrier.at,
          });
          if (minimized.length !== retainedOrderIds.length)
            throw new Error('Commerce exact-order retention minimization was incomplete');
        }
        const full = orders.length === 100;
        const finalBlocker = blocker ?? (progress.blocker === ORDER_RETENTION_BLOCKER ? progress.blocker : null);
        const nextPhase = full
          ? 'orders'
          : finalBlocker !== null && retainedPolicy.retentionStore === null
            ? 'pending'
            : 'retained';
        await checkpoint.run(
          tx,
          checkpointInput(
            key,
            progress,
            full ? orders.at(-1)!.id : ZERO,
            nextPhase,
            nextPhase === 'retained' ? (finalBlocker ?? COMMERCE_CUSTODY_BLOCKER) : finalBlocker,
            retainedPolicy,
          ),
        );
        return {
          value: full ? ('more' as const) : nextPhase === 'retained' ? ('retained' as const) : ('pending' as const),
          events: [{ type: 'com.rezics.access.account-updated.v1', subject: accountId, data: { accountId } }],
        };
      }

      throw new Error(`Unknown Commerce erasure phase: ${progress.phase}`);
    },
  );

  if (result.value === 'retained') {
    const current = (await withConnection(pool, (client) => read.run(client, key))) as Progress | null;
    if (!current) throw new Error('Commerce erasure progress unavailable');
    if (current.blocker !== COMMERCE_CUSTODY_BLOCKER) return 'retained';
    const retained = await withConnection(pool, (client) => readRetention.run(client, key));
    if (!retained) throw new Error('Commerce retained-order progress unavailable');
    const exceptions: RetentionException[] = [];
    if (retained.store !== null) {
      if (
        retained.fields?.join('\0') !== NATIVE_TEST_ORDER_RETENTION_FIELDS.join('\0') ||
        retained.purpose !== NATIVE_TEST_ORDER_RETENTION_PURPOSE ||
        !retained.expiresAt
      )
        throw new Error('Commerce retained-order metadata is incomplete');
      exceptions.push({
        store: retained.store,
        fields: [...NATIVE_TEST_ORDER_RETENTION_FIELDS],
        purpose: retained.purpose,
        expiresAt: new Date(retained.expiresAt),
      });
    }
    await acknowledgeErasure({ pool }, { accountId, participant: 'commerce', outcome: 'erased', retained: exceptions });
    if (exceptions.length === 0) {
      await changeProgress(pool, accountId, 'pending', current.blocker ?? COMMERCE_CUSTODY_BLOCKER);
      return 'pending';
    }
    return 'retained';
  }

  if (result.value === 'pending') {
    const progress = (await withConnection(pool, (client) => read.run(client, key))) as Progress | null;
    if (!progress) throw new Error('Commerce erasure progress unavailable');
    if (!progress.hadData) {
      const barrier = await withConnection(pool, (client) => obligation.run(client, key));
      if (!barrier || barrier.version !== 1)
        throw new Error('Commerce erasure requires the committed native version 1 tombstone');
      const coverage = await readHistoryOwnerCoverage(
        { pool },
        { accountId, accountRoute: route, version: barrier.version, at: barrier.at },
        'commerce',
        { deadline: Date.now() + 5_000 },
      );
      if (coverage.state === 'complete') {
        await acknowledgeErasure({ pool }, { accountId, participant: 'commerce', outcome: 'none' });
        await changeProgress(pool, accountId, 'none', null);
        return 'none';
      }
      const blocker = `${COMMERCE_CUSTODY_BLOCKER}; commerce-history: ${coverage.gaps.join(',')}`;
      if (progress.blocker !== blocker) await changeProgress(pool, accountId, 'pending', blocker);
    }
  }
  return result.value;
}

export function registerCommerceErasure({ pool, client, addEffects }: WorkContext) {
  const advance = DBOS.registerStep((accountId: string) => advanceCommerceErasure(pool, accountId), {
    name: 'commerce.erasure.advance',
    retriesAllowed: true,
    maxAttempts: 5,
    intervalSeconds: 1,
  });
  const retentionDeadline = DBOS.registerStep(
    async (accountId: string) => {
      const route = routeForAccount(accountId);
      const progress = await withConnection(pool, (connection) =>
        readRetention.run(connection, {
          route,
          account_id: accountId,
        }),
      );
      if (!progress?.expiresAt) throw new Error('Commerce retained-order deadline unavailable');
      return Math.max(0, Date.parse(progress.expiresAt) - Date.now());
    },
    { name: 'commerce.erasure.retentionDeadline' },
  );
  const resolve = DBOS.registerStep(
    async (accountId: string) => {
      const route = routeForAccount(accountId);
      const key = { route, account_id: accountId };
      const progress = await withConnection(pool, (connection) => readRetention.run(connection, key));
      if (!progress?.store) throw new Error('Commerce retained-order store unavailable');
      await resolveRetention({ pool }, { accountId, participant: 'commerce', store: progress.store });
      await changeProgress(pool, accountId, 'pending', COMMERCE_CUSTODY_BLOCKER);
    },
    { name: 'commerce.erasure.resolveRetention' },
  );
  DBOS.registerWorkflow(
    async (accountId: string) => {
      let state = await advance(accountId);
      while (state === 'more') state = await advance(accountId);
      while (state === 'retained' || state === 'resolve') {
        if (state === 'retained') {
          const delayMs = await retentionDeadline(accountId);
          if (delayMs > 0) await DBOS.sleep(delayMs);
          state = await advance(accountId);
        } else {
          await resolve(accountId);
          state = await advance(accountId);
        }
        while (state === 'more') state = await advance(accountId);
      }
    },
    { name: COMMERCE_ERASURE_WORKFLOW },
  );
  addEffects([
    {
      name: 'commerce_erasure',
      types: ['com.rezics.access.account-tombstoned.v1'],
      async run(event) {
        const { accountId } = event.data as { accountId: string };
        await client.enqueue(
          {
            workflowName: COMMERCE_ERASURE_WORKFLOW,
            workflowID: commerceErasureWorkflowId(accountId),
            workflowIDReusePolicy: 'return-existing',
            queueName: 'workflows',
          },
          accountId,
        );
      },
    },
  ]);
}
