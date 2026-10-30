import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { createCommerceCommands } from './commands.ts';
import { checkoutUrlsForOrder } from './config.ts';
import { StripeRejectedError, StripeUnavailableError, type Order, type StripePort } from './model.ts';
import { readOrder } from './store.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';

type Commands = ReturnType<typeof createCommerceCommands>;

/** Commands release their connections before the provider call. Replays must read
 * the current order because the create receipt predates its Checkout outcome.
 */
export async function checkout(
  {
    pool,
    commands,
    stripe,
    successUrl,
    cancelUrl,
  }: {
    pool: Pool;
    commands: Commands;
    stripe: StripePort;
    successUrl: string;
    cancelUrl: string;
  },
  actor: Actor,
  offerId: string,
  requestKey: string,
): Promise<Order> {
  return withRequestDeadline(deadlineFor(20_000), () => runCheckout());
  async function runCheckout(): Promise<Order> {
    const created = await commands.createOrder(actor, offerId, requestKey);
    const id = created.value.id;
    const current = async () => {
      const order = await readOrder(pool, routeOf(id)!, id);
      if (!order) throw new Error('Created order is missing');
      return order;
    };
    const order = await current();
    if (order.checkoutSessionId !== null || order.settlement === 'failed' || order.settlement === 'paid') return order;
    try {
      const urls = checkoutUrlsForOrder({ successUrl, cancelUrl }, id);
      const session = await stripe.createCheckoutSession(
        {
          orderId: id,
          buyerAccountId: order.buyerAccountId,
          title: order.title,
          currency: order.currency,
          unitAmountMinor: order.unitAmountMinor,
          taxCode: order.taxCode,
          ...urls,
          expiresAt: Math.floor(Date.parse(order.createdAt) / 1000) + 3600,
        },
        `order:${id}`,
      );
      await commands.recordCheckout(id, { session });
    } catch (error) {
      if (error instanceof StripeRejectedError) await commands.recordCheckout(id, { kind: 'failed' });
      else if (error instanceof StripeUnavailableError) {
        await commands.recordCheckout(id, { kind: 'unknown' });
        throw error;
      } else throw error;
    }
    return current();
  }
}
