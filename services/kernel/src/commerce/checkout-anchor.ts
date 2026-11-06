import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { readOrder } from './store.ts';
import type { StripeCheckoutLocatorPort, StripeEventRef, StripePort } from './model.ts';

/** Private routing references only. Never persist/enqueue without Accounts' typed history scope. */
export type CheckoutAnchor = Readonly<{ orderId: string; sessionId: string }>;
export type KnownCheckoutOrder = Readonly<{ orderId: string }>;
/**
 * not-ours: absent known native order or null filtered PI lookup.
 * mismatch: invalid correlation/mode/recorded binding, including an event naming an unknown native order.
 * Dependency failures reject; these classifications carry no personal diagnostics or HTTP response.
 */
export type CheckoutAnchorResult =
  | Readonly<{ kind: 'anchor'; anchor: CheckoutAnchor }>
  | Readonly<{ kind: 'not-ours' }>
  | Readonly<{ kind: 'mismatch' }>;

export type CheckoutAnchorConfig = Readonly<{
  pool: Pool;
  /** Separate, mandatory locator capability; full readCheckout is deliberately unavailable here. */
  stripe: StripeCheckoutLocatorPort & Pick<StripePort, 'findCheckoutSession'>;
  /** Trusted direct-account namespace and mode from service configuration, never event/key/ID text. */
  provider: Readonly<{ accountNamespace: string; livemode: boolean }>;
}>;

export interface CheckoutAnchorResolver {
  /** Validate the routable ID, then one route+order PK read. Pending AND paid require a recorded Session. */
  resolveKnownOrder(input: KnownCheckoutOrder): Promise<CheckoutAnchorResult>;
  /** Verified/classified wake-up only. Validate unexpanded correlation, then one native binding point. */
  resolveEvent(event: Readonly<StripeEventRef>): Promise<CheckoutAnchorResult>;
}

/** Readonly routing. Admission must revalidate the binding under the native order lock. */
export function createCheckoutAnchorResolver(config: CheckoutAnchorConfig): CheckoutAnchorResolver {
  const { pool, stripe } = config;
  const provider = { ...config.provider };
  if (!provider.accountNamespace.trim() || typeof provider.livemode !== 'boolean')
    throw new TypeError('Checkout requires a trusted provider namespace and mode');
  async function known(orderId: string): Promise<CheckoutAnchorResult> {
    const route = routeOf(orderId);
    if (route === null) return { kind: 'mismatch' };
    const order = await withConnection(pool, (client) => readOrder(client, route, orderId));
    if (!order) return { kind: 'not-ours' };
    if (!order.checkoutSessionId) return { kind: 'mismatch' };
    return { kind: 'anchor', anchor: { orderId: order.id, sessionId: order.checkoutSessionId } };
  }
  return {
    resolveKnownOrder({ orderId }) {
      return known(orderId);
    },
    async resolveEvent(event) {
      if (event.livemode !== provider.livemode) return { kind: 'mismatch' };
      const sessionId =
        event.sessionId ?? (event.paymentIntentId ? await stripe.findCheckoutSession(event.paymentIntentId) : null);
      if (!sessionId) return { kind: 'not-ours' };
      const locator = await stripe.readCheckoutLocator(sessionId);
      const orderId = locator.clientReferenceId;
      if (
        locator.sessionId !== sessionId ||
        locator.livemode !== provider.livemode ||
        locator.mode !== 'payment' ||
        !orderId ||
        locator.metadataOrderId !== orderId ||
        routeOf(orderId) === null ||
        (event.paymentIntentId !== null && locator.paymentIntentId !== event.paymentIntentId)
      )
        return { kind: 'mismatch' };
      const result = await known(orderId);
      return result.kind === 'anchor' && result.anchor.sessionId === sessionId ? result : { kind: 'mismatch' };
    },
  };
}
