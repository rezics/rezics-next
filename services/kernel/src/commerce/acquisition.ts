import type { PoolClient } from 'pg';
import { contentEditionBenefitBinding, copyContentEditionBenefit } from '../access/authenticated-benefit.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { AccountActor } from '../request/access.ts';
import { newId, routeOf } from '../route/route.ts';
import { decodeCapturedContentEdition } from './benefit.ts';
import type { CapturedContentEdition, CheckoutSnapshot, Order } from './model.ts';
import lock from './acquisition-lock.sql';
import reserve from './acquisition-reserve.sql';
import owned from './acquisition-owned.sql';
import pending from './acquisition-pending.sql';
import disposition from './acquisition-disposition.sql';
import cash from './acquisition-cash.sql';
import orderRead from './store-order-read.sql';

type Client = Pick<PoolClient, 'query'>;
export class BenefitAcquisitionError extends Error {
  constructor(
    readonly code: 'benefit_already_owned' | 'acquisition_pending',
    readonly locators: Readonly<{ orderId?: string; entitlementId?: string }>,
  ) {
    super(code === 'benefit_already_owned' ? 'Benefit already owned' : 'Acquisition pending');
    this.name = 'BenefitAcquisitionError';
  }
}
function key(buyerAccountId: string, capture: CapturedContentEdition) {
  const route = routeOf(buyerAccountId);
  if (route === null) throw new TypeError('Invalid acquisition buyer');
  return {
    route,
    buyer_account_id: buyerAccountId,
    benefit: JSON.stringify(copyContentEditionBenefit(capture.benefit)),
  };
}
function sameBenefit(serialized: string | null, capture: CapturedContentEdition): boolean {
  const actual = decodeCapturedContentEdition(serialized);
  return (
    actual !== null && contentEditionBenefitBinding(actual.benefit) === contentEditionBenefitBinding(capture.benefit)
  );
}
/** Caller owns the buyer-home transaction. No pool, provider or Content checkout is acquired here. */
export async function lockBenefitAcquisition(
  client: Client,
  order: Pick<Order, 'id' | 'buyerAccountId' | 'contentEdition'>,
) {
  if (!order.contentEdition) return null; // UNKNOWN historical subject-only mapping is not a slot.
  const input = key(order.buyerAccountId, order.contentEdition);
  if (routeOf(order.id) !== input.route) throw new TypeError('Invalid acquisition order');
  const row = await lock.run(client, { ...input, slot_id: newId(input.route), order_id: order.id });
  if (!row || routeOf(row.orderId) !== input.route) throw new AccessUnavailableError('overloaded');
  return row.orderId;
}
/** Must run after ordinary current authorization/replay, revision and exact Content capture. */
export async function admitBenefitAcquisition(
  client: Client,
  buyer: AccountActor,
  orderId: string,
  capture: CapturedContentEdition,
): Promise<void> {
  const input = key(buyer.accountId, capture);
  await lockBenefitAcquisition(client, { id: orderId, buyerAccountId: buyer.accountId, contentEdition: capture });
  const active = await owned.run(client, input);
  const unresolved = active ? null : await pending.run(client, input);
  const priorId = active?.orderId ?? unresolved?.id;
  if (priorId !== undefined) {
    // Validate the actual native own order as well as the exact entitlement, never a projected locator.
    const prior = await orderRead.run(client, { route: input.route, id: priorId, receipt: false });
    if (
      !prior ||
      routeOf(priorId) !== input.route ||
      prior.buyerAccountId !== buyer.accountId ||
      !sameBenefit(prior.contentEdition, capture) ||
      (active &&
        (routeOf(active.id) !== input.route ||
          active.accountId !== buyer.accountId ||
          !sameBenefit(active.contentEdition, capture))) ||
      (unresolved &&
        (unresolved.buyerAccountId !== buyer.accountId || !sameBenefit(unresolved.contentEdition, capture)))
    )
      throw new AccessUnavailableError('overloaded');
    throw new BenefitAcquisitionError(active ? 'benefit_already_owned' : 'acquisition_pending', {
      ...(buyer.scopes.includes('order:read') ? { orderId: priorId } : {}),
      ...(active && buyer.scopes.includes('entitlement:read') ? { entitlementId: active.id } : {}),
    });
  }
  await reserve.run(client, { ...input, order_id: orderId });
}
/** Slot serialization must be held before the first order lock in refresh application. */
export async function canActivateBenefit(client: Client, order: Order): Promise<boolean> {
  if (!order.contentEdition) return false;
  const incumbent = await lockBenefitAcquisition(client, order);
  if (incumbent !== order.id) return false;
  const active = await owned.run(client, key(order.buyerAccountId, order.contentEdition));
  return !active || active.orderId === order.id;
}
export type AcquisitionRelease = 'no-creation' | 'cancelled-no-charge' | 'refunded' | 'lost-dispute';

/** Pure interpretation of an already verified, complete current native refresh, never a client status.
 * Unknown associations, pending obligations and absent actual adverse movements stay conservative.
 */
export function verifiedAcquisitionRelease(order: Order, snapshot: CheckoutSnapshot): AcquisitionRelease | null {
  if (
    snapshot.sessionId !== order.checkoutSessionId ||
    snapshot.clientReferenceId !== order.id ||
    snapshot.metadataOrderId !== order.id
  )
    return null;
  if (order.settlement !== 'paid') {
    return snapshot.paymentStatus === 'unpaid' &&
      (snapshot.status === 'expired' || snapshot.status === 'complete') &&
      snapshot.paymentIntentId?.startsWith('pi_') &&
      snapshot.paymentIntentStatus === 'canceled' &&
      snapshot.chargeId === null &&
      snapshot.chargeAmountMinor === null &&
      snapshot.transactions.length === 0 &&
      snapshot.refunds.length === 0 &&
      snapshot.disputes.length === 0
      ? 'cancelled-no-charge'
      : null;
  }
  if (
    snapshot.status !== 'complete' ||
    snapshot.paymentStatus !== 'paid' ||
    snapshot.paymentIntentStatus !== 'succeeded' ||
    !snapshot.paymentIntentId ||
    !snapshot.chargeId ||
    !snapshot.chargeAmountMinor ||
    snapshot.chargeAmountMinor !== snapshot.amountTotalMinor
  )
    return null;
  if (
    snapshot.refunds.some((r) => !['succeeded', 'failed', 'canceled'].includes(r.status)) ||
    snapshot.disputes.some((d) => !['lost', 'won', 'warning_closed', 'prevented'].includes(d.status))
  )
    return null;
  const succeeded = snapshot.refunds.filter((r) => r.status === 'succeeded');
  const backed = (kind: 'refund' | 'dispute', id: string, amount: number) =>
    snapshot.transactions.some((t) => t.kind === kind && t.sourceId === id && t.amountMinor === -amount);
  if (
    succeeded.reduce((sum, r) => sum + r.amountMinor, 0) === snapshot.chargeAmountMinor &&
    succeeded.every((r) => backed('refund', r.id, r.amountMinor))
  )
    return 'refunded';
  if (snapshot.disputes.some((d) => d.status === 'lost' && backed('dispute', d.id, d.amountMinor)))
    return 'lost-dispute';
  return null;
}
/** Native order revision is held by the creation/refresh apply; this metadata never rewrites money/history. */
export async function recordAcquisitionDisposition(
  client: Client,
  order: Pick<Order, 'id' | 'buyerAccountId' | 'contentEdition' | 'revision'>,
  release: AcquisitionRelease | null,
) {
  if (!order.contentEdition) return false;
  if (
    (release === 'no-creation' || release === 'cancelled-no-charge') &&
    (await cash.run(client, { route: routeOf(order.id)!, order_id: order.id })).hasCash
  )
    release = null;
  return (
    (await disposition.run(client, {
      route: routeOf(order.id)!,
      order_id: order.id,
      buyer_account_id: order.buyerAccountId,
      revision: order.revision,
      disposition: release ?? '',
    })) !== null
  );
}
