import { DBOS } from '@dbos-inc/dbos-sdk';
import { createAccess } from '../access/index.ts';
import { routeOf } from '../route/route.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { createCheckoutAnchorResolver, type CheckoutAnchor, type CheckoutAnchorResult } from './checkout-anchor.ts';
import { CheckoutMismatchError } from './settlement.ts';
import { readCommerceProviderConfig } from './config.ts';
import type { WorkModule } from '../work/registry.ts';
import { createCommerceCommands, type CheckoutOutcome } from './commands.ts';
import { checkoutUrlsForOrder } from './config.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import {
  StripeRejectedError,
  StripeUnavailableError,
  type CheckoutLocator,
  type StripeCheckoutLocatorPort,
  type Order,
  type StripeEventRef,
  type StripePort,
} from './model.ts';
import { readOrder } from './store.ts';
import { createPayouts } from './payouts.ts';
import {
  CHECKOUT_SYNC_WORKFLOW,
  checkoutWorkflowId,
  EXPIRY_SYNC_WORKFLOW,
  ORDER_RECONCILE_WORKFLOW,
  orderExpiryWorkflowId,
  orderReconcileWorkflowId,
  STRIPE_EVENT_WORKFLOW,
  WORKFLOWS_QUEUE,
  KNOWN_ORDER_REPAIR_WORKFLOW,
  checkoutPartitionKey,
} from './work-contract.ts';
import clockQuery from './work-clock.sql';

export type CommerceWorkDependencies = {
  stripe: StripePort;
  /** Trusted test/service clock for royalty command T; otherwise PostgreSQL supplies it. */
  royaltyClock?: () => Date;
  checkout: { successUrl: string; cancelUrl: string };
  provider?: Readonly<{ accountNamespace: string; livemode: boolean }>;
};

/** Registration owns closures over explicit ports; the worker supplies its pool and queue registry. */
export function createCommerceWork(deps: CommerceWorkDependencies): WorkModule {
  const { stripe } = deps;
  const checkout = { ...deps.checkout };
  return {
    name: 'commerce',
    register({ pool, queues, client, addEffects, env, clock: workClock }) {
      const provider = { ...(deps.provider ?? readCommerceProviderConfig(env)) };
      const locator: StripeCheckoutLocatorPort = {
        readCheckoutLocator(sessionId) {
          if (!('readCheckoutLocator' in stripe) || typeof stripe.readCheckoutLocator !== 'function')
            throw new StripeUnavailableError('Checkout locator is unavailable');
          return stripe.readCheckoutLocator(sessionId) as Promise<CheckoutLocator>;
        },
      };
      const resolver = createCheckoutAnchorResolver({
        pool,
        stripe: { ...locator, findCheckoutSession: stripe.findCheckoutSession.bind(stripe) },
        provider,
      });
      if (!Object.hasOwn(queues, WORKFLOWS_QUEUE)) throw new Error('Commerce requires the workflows queue');
      // Only the trusted checkout command ports are used here. No request identity is fabricated.
      const commands = createCommerceCommands({ pool, access: createAccess({ actions: new Map() }) });
      const stripeRetries = {
        retriesAllowed: true,
        intervalSeconds: 1,
        backoffRate: 2,
        maxAttempts: 5,
        shouldRetry: (error: unknown) => error instanceof StripeUnavailableError,
      };
      const refreshRetries = {
        ...COMMAND_STEP_RETRIES,
        shouldRetry: (error: unknown) => stripeRetries.shouldRetry(error) || COMMAND_STEP_RETRIES.shouldRetry(error),
      };
      // The limit covers the actual physical body, even if DBOS abandons its checkpoint.
      let physical = 0;
      async function attempt<T>(run: () => Promise<T>): Promise<T> {
        if (physical >= queues.effects.workerConcurrency)
          throw new StripeUnavailableError('Checkout capacity unavailable');
        physical++;
        try {
          return await withRequestDeadline(deadlineFor(20_000), run);
        } finally {
          physical--;
        }
      }
      const resolveCheckout = DBOS.registerStep(
        // Preserve the name and distinguish old cached string outputs from new routing results.
        (ref: StripeEventRef): Promise<CheckoutAnchorResult | string | null> =>
          attempt(async () => {
            let identity: CheckoutLocator | undefined;
            const eventResolver = createCheckoutAnchorResolver({
              pool,
              provider,
              stripe: {
                findCheckoutSession: stripe.findCheckoutSession.bind(stripe),
                async readCheckoutLocator(sessionId) {
                  identity = await locator.readCheckoutLocator(sessionId);
                  return identity;
                },
              },
            });
            const result = await eventResolver.resolveEvent(ref);
            // Unrelated malformed correlation is a refused wake-up. A contradictory native locator
            // fails visibly, without admitting a claim or reading financial children.
            if (
              result.kind === 'mismatch' &&
              identity?.clientReferenceId &&
              routeOf(identity.clientReferenceId) !== null
            )
              throw new CheckoutMismatchError('Checkout correlation differs from the order');
            return result;
          }),
        { name: 'commerce.resolveCheckout', ...stripeRetries },
      );
      const clock = DBOS.registerStep(
        async () => {
          const row = await clockQuery.run({ query: pool.query.bind(pool) });
          if (!row) throw new Error('PostgreSQL clock is unavailable');
          return row.observedAt;
        },
        { name: 'commerce.clock' },
      );
      const expiryDelay = DBOS.registerStep(
        async (checkoutExpiresAt: string) => {
          const row = await clockQuery.run({ query: pool.query.bind(pool) });
          if (!row) throw new Error('PostgreSQL clock is unavailable');
          const remaining = Date.parse(checkoutExpiresAt) + 600_000 - Date.parse(row.observedAt);
          return remaining <= 0 ? 0 : Math.ceil(remaining / 1000);
        },
        { name: 'commerce.expiryDelay' },
      );
      async function sessionAnchor(sessionId: string): Promise<CheckoutAnchor | null> {
        const identity = await locator.readCheckoutLocator(sessionId);
        const id = identity.clientReferenceId;
        if (
          identity.sessionId !== sessionId ||
          identity.livemode !== provider.livemode ||
          identity.mode !== 'payment' ||
          !id ||
          id !== identity.metadataOrderId
        )
          return null;
        const result = await resolver.resolveKnownOrder({ orderId: id });
        return result.kind === 'anchor' && result.anchor.sessionId === sessionId ? result.anchor : null;
      }
      type Refresh = { anchor: CheckoutAnchor; intent: string };
      const refresh = DBOS.registerStep(
        (input: Refresh) =>
          attempt(async () => {
            const result = await resolver.resolveKnownOrder({ orderId: input.anchor.orderId });
            if (result.kind !== 'anchor' || result.anchor.sessionId !== input.anchor.sessionId)
              throw new CheckoutMismatchError('Checkout binding differs from the order');
            const admission = await commands.beginCheckoutRefresh({
              ...input.anchor,
              workflowId: `wf:${input.intent}`,
            });
            if (admission.kind === 'completed') return;
            // Admission/completion uses native evidence only. A replay of completed A sends nothing to Stripe.
            const current = await sessionAnchor(input.anchor.sessionId);
            if (!current || current.orderId !== input.anchor.orderId)
              throw new CheckoutMismatchError('Checkout correlation differs from the order');
            const snapshot = await stripe.readCheckout(input.anchor.sessionId);
            const order = admission.command.value.order;
            if (
              snapshot.livemode !== provider.livemode ||
              snapshot.sessionId !== order.checkoutSessionId ||
              snapshot.clientReferenceId !== order.id ||
              snapshot.metadataOrderId !== order.id ||
              snapshot.currency !== order.currency ||
              snapshot.amountSubtotalMinor !== order.unitAmountMinor
            )
              throw new CheckoutMismatchError('Checkout identity or price differs from the order');
            await commands.applyClaimedCheckoutSnapshot(
              { ...snapshot, observedAt: workClock().toISOString() },
              admission.command.value,
            );
          }),
        { name: 'commerce.refreshCheckout', ...refreshRetries },
      );
      // These legacy registrations retain every old function position. Cached financial outputs are
      // consumed only for their Session locator; no old bytes are passed to any native apply port.
      const readCheckout = DBOS.registerStep(async (sessionId: string, _observedAt: string) => ({ sessionId }), {
        name: 'commerce.readCheckout',
        ...stripeRetries,
      });
      const applyCheckout = DBOS.registerStep(
        async (old: { sessionId: string; clientReferenceId?: string | null }, workflowId: string) => {
          const anchor = await attempt(async () => {
            // An old snapshot's correlation is only a candidate native key, never financial authority.
            // This also lets native completion answer a lost acknowledgement without any provider send.
            if (old.clientReferenceId) {
              const known = await resolver.resolveKnownOrder({ orderId: old.clientReferenceId });
              return known.kind === 'anchor' && known.anchor.sessionId === old.sessionId ? known.anchor : null;
            }
            return sessionAnchor(old.sessionId);
          });
          if (!anchor) return;
          const handle = await client.enqueue(
            {
              workflowName: CHECKOUT_SYNC_WORKFLOW,
              workflowID: `${workflowId}:refresh`,
              workflowIDReusePolicy: 'return-existing',
              queueName: 'effects',
              queuePartitionKey: checkoutPartitionKey(provider, anchor.sessionId),
            },
            anchor.sessionId,
            { anchor, intent: workflowId },
          );
          await handle.getResult();
        },
        { name: 'commerce.applyCheckout', ...stripeRetries },
      );
      async function legacySync(sessionId: string, workflowId: string) {
        const observedAt = await clock();
        await applyCheckout(await readCheckout(sessionId, observedAt), workflowId);
      }
      const checkoutSync = DBOS.registerWorkflow(
        async (sessionId: string, input?: Refresh) => {
          if (input) await refresh(input);
          else await legacySync(sessionId, DBOS.workflowID!);
        },
        { name: CHECKOUT_SYNC_WORKFLOW },
      );
      async function sync(anchor: CheckoutAnchor, intent: string, workflowID = intent) {
        const child = await DBOS.startWorkflow(checkoutSync, {
          workflowID,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'effects',
          enqueueOptions: { queuePartitionKey: checkoutPartitionKey(provider, anchor.sessionId) },
        })(anchor.sessionId, { anchor, intent });
        await child.getResult();
      }
      DBOS.registerWorkflow(
        async (ref: StripeEventRef) => {
          const resolved = await resolveCheckout(ref);
          if (typeof resolved === 'string') {
            // Old parents may have checkpointed only a Session. Replay their original child input.
            const child = await DBOS.startWorkflow(checkoutSync, {
              workflowID: checkoutWorkflowId(resolved, ref.eventId),
              workflowIDReusePolicy: 'return-existing',
              queueName: WORKFLOWS_QUEUE,
            })(resolved);
            await child.getResult();
          } else if (resolved?.kind === 'anchor') {
            await sync(resolved.anchor, checkoutWorkflowId(resolved.anchor.sessionId, ref.eventId));
          }
        },
        { name: STRIPE_EVENT_WORKFLOW },
      );
      DBOS.registerWorkflow(
        async (orderId: string) => {
          const result = await DBOS.runStep(() => resolver.resolveKnownOrder({ orderId }), {
            name: 'commerce.resolveRepair',
            ...stripeRetries,
          });
          if (result.kind === 'anchor') await sync(result.anchor, `${DBOS.workflowID!}:refresh`);
        },
        { name: KNOWN_ORDER_REPAIR_WORKFLOW },
      );
      const getOrder = DBOS.registerStep(
        async (orderId: string) => {
          const route = routeOf(orderId);
          if (route === null) return null;
          const order = await readOrder(pool, route, orderId);
          return order ? { ...order, refresh: 'combined' as const } : null;
        },
        { name: 'commerce.readOrder' },
      );
      const createCheckout = DBOS.registerStep(
        async (order: Order): Promise<CheckoutOutcome> => {
          try {
            return {
              session: await stripe.createCheckoutSession(
                {
                  orderId: order.id,
                  buyerAccountId: order.buyerAccountId,
                  title: order.title,
                  currency: order.currency,
                  unitAmountMinor: order.unitAmountMinor,
                  taxCode: order.taxCode,
                  ...checkoutUrlsForOrder(checkout, order.id),
                  // Stable across the HTTP attempt, delayed reconciliation and step recovery.
                  expiresAt: Math.floor(Date.parse(order.createdAt) / 1000) + 3600,
                },
                `order:${order.id}`,
              ),
            };
          } catch (error) {
            if (error instanceof StripeRejectedError) return { kind: 'failed' };
            throw error;
          }
        },
        { name: 'commerce.createCheckout', ...stripeRetries },
      );
      const recordCheckout = DBOS.registerStep(
        async (orderId: string, outcome: CheckoutOutcome) => {
          await commands.recordCheckout(orderId, outcome);
        },
        { name: 'commerce.recordCheckout', ...COMMAND_STEP_RETRIES },
      );
      const expirySync = DBOS.registerWorkflow(
        async (orderId: string) => {
          const order = await getOrder(orderId);
          if (
            !order ||
            order.settlement === 'paid' ||
            order.settlement === 'failed' ||
            !order.checkoutSessionId ||
            !order.checkoutExpiresAt
          )
            return;
          if (order.refresh === 'combined')
            await sync(
              { orderId, sessionId: order.checkoutSessionId },
              DBOS.workflowID!,
              `${DBOS.workflowID!}:refresh`,
            );
          else await legacySync(order.checkoutSessionId, DBOS.workflowID!);
        },
        { name: EXPIRY_SYNC_WORKFLOW },
      );
      DBOS.registerWorkflow(
        async (orderId: string) => {
          let order = await getOrder(orderId);
          if (!order || order.settlement === 'paid' || order.settlement === 'failed') return;
          if (!order.checkoutSessionId) {
            const outcome = await createCheckout(order);
            await recordCheckout(orderId, outcome);
            order = await getOrder(orderId);
            if (!order || order.settlement === 'paid' || order.settlement === 'failed') return;
          }
          if (!order.checkoutSessionId || !order.checkoutExpiresAt) return;
          const workflowId = DBOS.workflowID!;
          if (order.refresh === 'combined')
            await sync({ orderId, sessionId: order.checkoutSessionId }, `${workflowId}:initial`);
          else await legacySync(order.checkoutSessionId, `${workflowId}:initial`);
          order = await getOrder(orderId);
          if (
            !order ||
            order.settlement === 'paid' ||
            order.settlement === 'failed' ||
            !order.checkoutSessionId ||
            !order.checkoutExpiresAt
          )
            return;
          const delaySeconds = await expiryDelay(order.checkoutExpiresAt);
          await DBOS.startWorkflow(expirySync, {
            workflowID: orderExpiryWorkflowId(orderId),
            workflowIDReusePolicy: 'return-existing',
            queueName: WORKFLOWS_QUEUE,
            enqueueOptions: { delaySeconds },
          })(orderId);
        },
        { name: ORDER_RECONCILE_WORKFLOW },
      );
      const payouts = createPayouts({ pool, clock: deps.royaltyClock });
      addEffects([
        {
          name: 'commerce_royalty',
          types: ['com.rezics.commerce.transactions.recorded.v1'],
          async run(event) {
            const { orderId, transactionIds } = event.data as { orderId: string; transactionIds: string[] };
            await payouts.recordTransactions(orderId, transactionIds, `effect:${event.id}:royalty`);
          },
        },
        {
          name: 'commerce_reconcile_order',
          types: ['com.rezics.commerce.order.created.v1'],
          async run(event) {
            const { orderId } = event.data as { orderId: string };
            await client.enqueue(
              {
                workflowName: ORDER_RECONCILE_WORKFLOW,
                workflowID: orderReconcileWorkflowId(orderId),
                workflowIDReusePolicy: 'return-existing',
                queueName: WORKFLOWS_QUEUE,
                delaySeconds: 900,
              },
              orderId,
            );
          },
        },
      ]);
    },
  };
}
