import type { PoolClient } from 'pg';
import type {
  CheckoutDecision,
  CheckoutSession,
  Entitlement,
  Offer,
  Order,
  SettlementState,
  StripeTransaction,
} from './model.ts';
import offerInsert from './store-offer-insert.sql';
import offerRead from './store-offer-read.sql';
import offerState from './store-offer-state.sql';
import offerPrice from './store-offer-price.sql';
import orderInsert from './store-order-insert.sql';
import orderRead from './store-order-read.sql';
import orderAccountPage from './order-account-page.sql';
import orderSessionRead from './store-order-session-read.sql';
import orderSession from './store-order-session.sql';
import orderSettlement from './store-order-settlement.sql';
import orderLock from './store-order-lock.sql';
import orderRefresh from './store-order-refresh.sql';
import orderDecision from './store-order-decision.sql';
import entitlementRead from './store-entitlement-read.sql';
import entitlementOrder from './store-entitlement-order.sql';
import entitlementLock from './store-entitlement-lock.sql';
import entitlementList from './store-entitlement-list.sql';
import entitlementInsert from './store-entitlement-insert.sql';
import entitlementChange from './store-entitlement-change.sql';
import transactionsRead from './store-transactions-read.sql';
import transactionsInsert from './store-transactions-insert.sql';
import transactionsCount from './store-transactions-count.sql';
import transactionsProbe from './store-transactions-probe.sql';
import transactionsNamed from './store-transactions-named.sql';
import { assertTransactionBound, CheckoutMismatchError } from './settlement.ts';
import { MAX_ORDER_TRANSACTIONS } from './model.ts';

type Client = Pick<PoolClient, 'query'>;
// All projections normalize PostgreSQL scalars explicitly, so the minimal pg interface
// keeps execution to the declared statement without driver metadata queries.
function queryClient(client: Client): Client {
  return { query: client.query.bind(client) };
}
type WriteContext = { transactionId: string; time: string };
type OfferRow = NonNullable<Awaited<ReturnType<typeof offerRead.run>>>;
type OrderRow = NonNullable<Awaited<ReturnType<typeof orderRead.run>>>;
type EntitlementRow = NonNullable<Awaited<ReturnType<typeof entitlementRead.run>>>;

function required<T>(value: T | null): T {
  if (value === null) throw new Error('Commerce row is missing or its revision changed');
  return value;
}
function iso(value: string): string {
  return new Date(value).toISOString();
}
function asOffer(row: OfferRow): Offer {
  return { ...row, unitAmountMinor: Number(row.unitAmountMinor) };
}
function asOrder(row: OrderRow): Order {
  return {
    ...row,
    unitAmountMinor: Number(row.unitAmountMinor),
    amountTaxMinor: row.amountTaxMinor === null ? null : Number(row.amountTaxMinor),
    createdAt: iso(row.createdAt),
    checkoutExpiresAt: row.checkoutExpiresAt === null ? null : iso(row.checkoutExpiresAt),
    observedAt: row.observedAt === null ? null : iso(row.observedAt),
  };
}
function asEntitlement(row: EntitlementRow): Entitlement {
  return { ...row, grantedAt: iso(row.grantedAt), revokedAt: row.revokedAt === null ? null : iso(row.revokedAt) };
}
function write(context: WriteContext) {
  return { transaction_id: context.transactionId, time: context.time };
}

export async function insertOffer(
  client: Client,
  route: number,
  offer: Omit<Offer, 'state' | 'revision'>,
  context: WriteContext,
): Promise<Offer> {
  return asOffer(
    required(
      await offerInsert.run(queryClient(client), {
        route,
        id: offer.id,
        creator_account_id: offer.creatorAccountId,
        target_subject_id: offer.targetSubjectId,
        title: offer.title,
        currency: offer.currency,
        unit_amount_minor: offer.unitAmountMinor,
        tax_code: offer.taxCode,
        royalty_basis_points: offer.royaltyBasisPoints,
        updated_at: context.time,
        ...write(context),
      }),
    ),
  );
}
export async function readOffer(client: Client, route: number, id: string): Promise<Offer | null> {
  const row = await offerRead.run(queryClient(client), { route, id });
  return row ? asOffer(row) : null;
}
export async function setOfferState(
  client: Client,
  route: number,
  id: string,
  state: Offer['state'],
  context: WriteContext,
): Promise<Offer> {
  return asOffer(required(await offerState.run(queryClient(client), { route, id, state, ...write(context) })));
}
export async function reviseOfferPrice(
  client: Client,
  route: number,
  id: string,
  unitAmountMinor: number,
  context: WriteContext,
): Promise<Offer | null> {
  const row = await offerPrice.run(queryClient(client), {
    route,
    id,
    unit_amount_minor: unitAmountMinor,
    ...write(context),
  });
  return row ? asOffer(row) : null;
}
export async function insertOrder(
  client: Client,
  route: number,
  input: { id: string; buyerAccountId: string; offer: Offer },
  context: WriteContext,
): Promise<Order> {
  const { offer } = input;
  return asOrder(
    required(
      await orderInsert.run(queryClient(client), {
        route,
        id: input.id,
        buyer_account_id: input.buyerAccountId,
        offer_id: offer.id,
        offer_revision: offer.revision,
        target_subject_id: offer.targetSubjectId,
        creator_account_id: offer.creatorAccountId,
        title: offer.title,
        currency: offer.currency,
        unit_amount_minor: offer.unitAmountMinor,
        tax_code: offer.taxCode,
        royalty_basis_points: offer.royaltyBasisPoints,
        updated_at: context.time,
        ...write(context),
      }),
    ),
  );
}
/** One buyer-local keyset; the caller owns the repeatable-read snapshot and epoch check. */
export async function listBuyerOrders(
  client: Client,
  route: number,
  buyerAccountId: string,
  page: { after: string | null; limit: number },
) {
  if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 101)
    throw new RangeError('Buyer order page must contain 1 to 101 rows');
  const rows = await orderAccountPage.run(queryClient(client), {
    route,
    buyer_account_id: buyerAccountId,
    after: page.after ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    limit: page.limit,
  });
  return rows.map((row) => ({
    ...row,
    unitAmountMinor: Number(row.unitAmountMinor),
    amountTaxMinor: row.amountTaxMinor === null ? null : Number(row.amountTaxMinor),
    createdAt: iso(row.createdAt),
    checkoutExpiresAt: row.checkoutExpiresAt === null ? null : iso(row.checkoutExpiresAt),
  }));
}
export async function readOrder(client: Client, route: number, id: string): Promise<Order | null> {
  const row = await orderRead.run(queryClient(client), { route, id });
  return row ? asOrder(row) : null;
}
/** Caller retains this transaction and lock through completion lookup, claim or apply. */
export async function lockOrder(client: Client, route: number, id: string): Promise<Order | null> {
  const locked = await orderLock.run(queryClient(client), { route, id });
  return locked ? readOrder(client, route, id) : null;
}
export async function claimOrderRefresh(
  client: Client,
  route: number,
  order: Order,
  context: WriteContext,
): Promise<Order> {
  if (order.revision >= 2147483647) throw new RangeError('Commerce order revision exhausted');
  return asOrder(
    required(
      await orderRefresh.run(queryClient(client), {
        route,
        id: order.id,
        revision: order.revision,
        session_id: required(order.checkoutSessionId),
        ...write(context),
      }),
    ),
  );
}
export async function readOrderBySession(client: Client, route: number, sessionId: string): Promise<Order | null> {
  const row = await orderSessionRead.run(queryClient(client), { route, session_id: sessionId });
  return row ? asOrder(row) : null;
}
export async function recordCheckoutSession(
  client: Client,
  route: number,
  id: string,
  session: CheckoutSession,
  context: WriteContext,
): Promise<Order> {
  return asOrder(
    required(
      await orderSession.run(queryClient(client), {
        route,
        id,
        session_id: session.id,
        url: session.url,
        expires_at: session.expiresAt,
        ...write(context),
      }),
    ),
  );
}
export async function setOrderSettlement(
  client: Client,
  route: number,
  id: string,
  settlement: 'failed' | 'unknown',
  context: WriteContext,
): Promise<Order> {
  return asOrder(
    required(await orderSettlement.run(queryClient(client), { route, id, settlement, ...write(context) })),
  );
}
export async function readEntitlement(client: Client, route: number, id: string): Promise<Entitlement | null> {
  const row = await entitlementRead.run(queryClient(client), { route, id });
  return row ? asEntitlement(row) : null;
}
export async function readOrderEntitlement(
  client: Client,
  route: number,
  orderId: string,
): Promise<Entitlement | null> {
  const row = await entitlementOrder.run(queryClient(client), { route, order_id: orderId });
  return row ? asEntitlement(row) : null;
}
export async function listEntitlements(
  client: Client,
  route: number,
  accountId: string,
  page: { after: string | null; limit: number },
): Promise<Entitlement[]> {
  if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError('Page limit must be a positive integer');
  const rows = await entitlementList.run(queryClient(client), {
    route,
    account_id: accountId,
    after: page.after ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
    limit: Math.min(100, page.limit),
  });
  return rows.map(asEntitlement);
}
function asTransaction(row: Awaited<ReturnType<typeof transactionsRead.run>>[number]): StripeTransaction {
  return {
    ...row,
    amountMinor: Number(row.amountMinor),
    feeMinor: Number(row.feeMinor),
    netMinor: Number(row.netMinor),
    feeDetails: JSON.parse(row.feeDetails) as StripeTransaction['feeDetails'],
    exchangeRate: row.exchangeRate === null ? null : Number(row.exchangeRate),
    created: iso(row.created),
  };
}

/** Immutable source transactions named by one royalty effect, on the buyer's route. */
export async function readNamedOrderTransactions(
  client: Client,
  route: number,
  orderId: string,
  ids: readonly string[],
): Promise<StripeTransaction[]> {
  assertTransactionBound(ids);
  const rows = await transactionsNamed.run(queryClient(client), { route, order_id: orderId, ids: [...ids] });
  return rows.map(asTransaction);
}

export async function readOrderTransactions(
  client: Client,
  route: number,
  orderId: string,
): Promise<StripeTransaction[]> {
  const rows = await transactionsRead.run(queryClient(client), { route, order_id: orderId });
  return rows.map(asTransaction);
}
export async function readSettlementState(
  client: Client,
  route: number,
  orderId: string,
  ids: readonly string[],
): Promise<SettlementState | null> {
  assertTransactionBound(ids);
  const order = await readOrder(client, route, orderId);
  if (!order) return null;
  const entitlement = await readOrderEntitlement(client, route, orderId);
  const transactions = await transactionsProbe.run(queryClient(client), { route, order_id: orderId, ids: [...ids] });
  return {
    order,
    entitlement,
    transactionIds: transactions.map((t) => t.id),
  };
}

export type AppliedCheckoutDecision =
  | { changed: false }
  | {
      changed: true;
      order: Order;
      entitlement: Entitlement | null;
      entitlementAction: Extract<CheckoutDecision, { changed: true }>['entitlement'];
      newTransactions: StripeTransaction[];
    };

/** The caller owns the transaction. Lock the order before checking either expected revision,
 * so a competing decision either completes first or observes a stale revision before any write.
 * The unique fulfilment index also protects against an incorrect second grant.
 */
export async function applyCheckoutDecision(
  client: Client,
  route: number,
  state: SettlementState,
  decision: CheckoutDecision,
  context: WriteContext & { newEntitlementId: string; amountTaxMinor?: number | null },
): Promise<AppliedCheckoutDecision> {
  if (!decision.changed) return { changed: false };
  if (context.amountTaxMinor != null && (!Number.isSafeInteger(context.amountTaxMinor) || context.amountTaxMinor < 0))
    throw new RangeError('Invalid Checkout tax amount');
  const lockedOrder = required(await orderLock.run(queryClient(client), { route, id: state.order.id }));
  if (lockedOrder.revision !== state.order.revision) throw new Error('Commerce order revision changed');
  const currentEntitlement = await entitlementLock.run(queryClient(client), { route, order_id: state.order.id });
  if (currentEntitlement?.id !== state.entitlement?.id || currentEntitlement?.revision !== state.entitlement?.revision)
    throw new Error('Commerce entitlement revision changed');
  const action = decision.entitlement;
  if (
    (action.kind === 'grant' && currentEntitlement) ||
    (action.kind !== 'grant' && action.kind !== 'none' && !currentEntitlement)
  )
    throw new Error('Checkout entitlement action conflicts with current state');
  if (decision.newTransactions.length) {
    const storedTransactions = await transactionsCount.run(queryClient(client), { route, order_id: state.order.id });
    if (storedTransactions.length + decision.newTransactions.length > MAX_ORDER_TRANSACTIONS)
      throw new CheckoutMismatchError('Checkout would exceed the order transaction limit');
  }
  const order = asOrder(
    required(
      await orderDecision.run(queryClient(client), {
        route,
        id: state.order.id,
        revision: state.order.revision,
        settlement: decision.settlement,
        payment_intent_id: decision.paymentIntentId ?? '',
        observed_at: decision.observedAt,
        amount_tax_minor: decision.settlement === 'paid' ? (context.amountTaxMinor ?? -1) : -1,
        ...write(context),
      }),
    ),
  );
  if (decision.newTransactions.length) {
    await transactionsInsert.run(queryClient(client), {
      route,
      order_id: order.id,
      transactions: decision.newTransactions.map((t) => ({
        id: t.id,
        kind: t.kind,
        source_id: t.sourceId,
        currency: t.currency,
        amount_minor: t.amountMinor,
        fee_minor: t.feeMinor,
        net_minor: t.netMinor,
        fee_details: t.feeDetails,
        exchange_rate: t.exchangeRate,
        created: t.created,
      })),
      ...write(context),
    });
  }
  let entitlement = currentEntitlement ? asEntitlement(currentEntitlement) : null;
  if (action.kind === 'grant') {
    entitlement = asEntitlement(
      required(
        await entitlementInsert.run(queryClient(client), {
          route,
          id: context.newEntitlementId,
          account_id: order.buyerAccountId,
          order_id: order.id,
          offer_id: order.offerId,
          target_subject_id: order.targetSubjectId,
          ...write(context),
        }),
      ),
    );
  } else if (action.kind !== 'none') {
    const previous = required(entitlement);
    entitlement = asEntitlement(
      required(
        await entitlementChange.run(queryClient(client), {
          route,
          id: previous.id,
          revision: previous.revision,
          revoked_at:
            action.kind === 'restore' ? '' : action.kind === 'reason' ? required(previous.revokedAt) : context.time,
          revoke_reason: action.kind === 'restore' ? '' : action.reason,
          transaction_id: context.transactionId,
        }),
      ),
    );
  }
  return { changed: true, order, entitlement, entitlementAction: action, newTransactions: decision.newTransactions };
}
