import { DBOS } from '@dbos-inc/dbos-sdk';
import { createAccess } from '../access/index.ts';
import { routeOf } from '../route/route.ts';
import type { WorkModule } from '../work/registry.ts';
import { createCommerceCommands, type CheckoutOutcome } from './commands.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import {
  StripeRejectedError,
  StripeUnavailableError,
  type CheckoutSnapshot,
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
} from './work-contract.ts';
import clockQuery from './work-clock.sql';

export type CommerceWorkDependencies = {
  stripe: StripePort;
  /** Trusted test/service clock for royalty command T; otherwise PostgreSQL supplies it. */
  royaltyClock?: () => Date;
  checkout: { successUrl: string; cancelUrl: string };
};

/** Registration owns closures over explicit ports; the worker supplies its pool and queue registry. */
export function createCommerceWork(deps: CommerceWorkDependencies): WorkModule {
  const { stripe } = deps;
  const checkout = { ...deps.checkout };
  return {
    name: 'commerce',
    register({ pool, queues, client, addEffects }) {
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
      const resolveCheckout = DBOS.registerStep(
        async (ref: StripeEventRef) =>
          ref.sessionId ?? (ref.paymentIntentId ? stripe.findCheckoutSession(ref.paymentIntentId) : null),
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
      const readCheckout = DBOS.registerStep(
        async (sessionId: string, observedAt: string): Promise<CheckoutSnapshot> => ({
          ...(await stripe.readCheckout(sessionId)),
          observedAt,
        }),
        { name: 'commerce.readCheckout', ...stripeRetries },
      );
      const applyCheckout = DBOS.registerStep(
        async (snapshot: CheckoutSnapshot, workflowId: string) => {
          // The command appends ':apply'; supplying this prefix preserves ADR-0033's wf:{id}:{step} key.
          await commands.applyCheckoutSnapshot(snapshot, `wf:${workflowId}`);
        },
        { name: 'commerce.applyCheckout', ...COMMAND_STEP_RETRIES },
      );
      async function sync(sessionId: string, workflowId: string) {
        // Persist the database observation before contacting Stripe. A delayed old response cannot outrank
        // a workflow that observed a later provider state, and recovery reuses both durable results.
        const observedAt = await clock();
        const snapshot = await readCheckout(sessionId, observedAt);
        await applyCheckout(snapshot, workflowId);
      }
      const checkoutSync = DBOS.registerWorkflow(
        async (sessionId: string) => {
          await sync(sessionId, DBOS.workflowID!);
        },
        { name: CHECKOUT_SYNC_WORKFLOW },
      );
      DBOS.registerWorkflow(
        async (ref: StripeEventRef) => {
          const sessionId = await resolveCheckout(ref);
          if (sessionId) {
            const child = await DBOS.startWorkflow(checkoutSync, {
              workflowID: checkoutWorkflowId(sessionId, ref.eventId),
              workflowIDReusePolicy: 'return-existing',
              queueName: WORKFLOWS_QUEUE,
            })(sessionId);
            await child.getResult();
          }
        },
        { name: STRIPE_EVENT_WORKFLOW },
      );
      const getOrder = DBOS.registerStep(
        async (orderId: string) => {
          const route = routeOf(orderId);
          return route === null ? null : readOrder(pool, route, orderId);
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
                  ...checkout,
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
          await sync(order.checkoutSessionId, DBOS.workflowID!);
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
          await sync(order.checkoutSessionId, `${workflowId}:initial`);
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
