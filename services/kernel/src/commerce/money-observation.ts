import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { decodeRecordedMoneyUnit, sameMoneyUnit } from '@rezics/money';
import type { CheckoutSnapshot, Order, StripeTransaction } from './model.ts';
import { StripeUnavailableError } from './model.ts';
import { assertTransactionBound, movementEconomics } from './settlement.ts';
import {
  stripeRecordedMoneyUnits,
  stripeEvidenceMoneyUnit,
  type StripeMoneyContext,
  type StripeMoneyProvenance,
  type StripeMoneyUnit,
} from './money.ts';
import insert from './money-observation-insert.sql';
import read from './money-observation-read.sql';
import erasurePage from './erasure-money-observation-page.sql';
import erasureDelete from './erasure-money-observation-delete.sql';

type Client = Pick<PoolClient, 'query'>;
const queryClient = (client: Client): Client => ({ query: client.query.bind(client) });
export const moneyEconomicsHash = (value: string): string => createHash('sha256').update(value).digest('hex');

function recordedStripeUnit(value: unknown): StripeMoneyUnit | null {
  const reading = decodeRecordedMoneyUnit(value, stripeRecordedMoneyUnits);
  return reading.kind === 'known' ? (reading.unit as StripeMoneyUnit) : null;
}

/** Exact native financial-owner inventory. No receipt, body, URL, token or fee-description mirror.
 * The financial participant owns the fence and the pending financial retention decision;
 * these bounded buyer-home queries supply its minimization and probe surface, not an acknowledgement.
 */
export const moneyObservationOwnership: Readonly<{
  participant: 'commerce';
  store: 'commerce.money_observation';
  ownerKeys: readonly ['route', 'buyer_account_id'];
  page: typeof erasurePage;
  minimize: typeof erasureDelete;
  retainedFields: readonly [];
}> = Object.freeze({
  participant: 'commerce',
  store: 'commerce.money_observation',
  ownerKeys: ['route', 'buyer_account_id'] as const,
  page: erasurePage,
  minimize: erasureDelete,
  retainedFields: [] as const,
});

export type MoneyObservation = Readonly<{
  object_id: string;
  context: StripeMoneyContext;
  namespace: string;
  livemode: boolean;
  api_version: string;
  request_version: string;
  response_version: string | null;
  unit: StripeMoneyUnit | null;
  economics_hash: string;
  amounts: Readonly<Record<string, number | string | null>>;
}>;

function observation(
  provenance: StripeMoneyProvenance | null | undefined,
  objectId: string,
  context: StripeMoneyContext,
  currency: string,
  captured: StripeMoneyUnit | null | undefined,
  amounts: MoneyObservation['amounts'],
  economics: string,
): MoneyObservation | null {
  // Missing lineage is historical unknown. A unit alone is never an authority to interpret raw history.
  if (!provenance) return null;
  if (
    provenance.objectId !== objectId ||
    provenance.context !== context ||
    provenance.object !== (context === 'balance_transaction' ? 'balance_transaction' : 'checkout.session') ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(provenance.accountNamespace) ||
    typeof provenance.livemode !== 'boolean' ||
    !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(provenance.requestApiVersion) ||
    (provenance.responseApiVersion !== null && !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/.test(provenance.responseApiVersion))
  )
    throw new StripeUnavailableError('Money observation lineage is incomplete');
  const unit = recordedStripeUnit(captured);
  if (captured != null && (!unit || !sameMoneyUnit(unit, stripeEvidenceMoneyUnit(currency, context))))
    throw new StripeUnavailableError('Money observation unit context is unavailable');
  return {
    object_id: objectId,
    context,
    namespace: provenance.accountNamespace,
    livemode: provenance.livemode,
    api_version: provenance.responseApiVersion ?? provenance.requestApiVersion,
    request_version: provenance.requestApiVersion,
    response_version: provenance.responseApiVersion,
    unit,
    amounts,
    economics_hash: moneyEconomicsHash(economics),
  };
}

/** Called only with a fresh verified snapshot, after native movement integrity and claim fencing. */
export function checkoutMoneyObservations(snapshot: CheckoutSnapshot, order: Order): MoneyObservation[] {
  assertTransactionBound(snapshot.transactions);
  if (!snapshot.moneyProvenance && snapshot.transactions.every((t) => !t.moneyProvenance)) return [];
  if (
    snapshot.sessionId !== order.checkoutSessionId ||
    snapshot.clientReferenceId !== order.id ||
    snapshot.metadataOrderId !== order.id ||
    snapshot.currency !== order.currency ||
    snapshot.amountSubtotalMinor !== order.unitAmountMinor
  )
    throw new StripeUnavailableError('Money observation order association is inconsistent');
  const result: MoneyObservation[] = [];
  const add = (item: MoneyObservation | null) => {
    if (item) result.push(item);
  };
  const amounts = {
    currency: snapshot.currency,
    amount_subtotal: snapshot.amountSubtotalMinor,
    'total_details.amount_tax': snapshot.amountTaxMinor,
    amount_total: snapshot.amountTotalMinor,
  };
  add(
    observation(
      snapshot.moneyProvenance,
      snapshot.sessionId,
      'checkout.integration',
      order.currency,
      snapshot.integrationMoneyUnit,
      amounts,
      JSON.stringify(amounts),
    ),
  );
  if (snapshot.moneyProvenance?.livemode !== undefined && snapshot.moneyProvenance.livemode !== snapshot.livemode)
    throw new StripeUnavailableError('Money observation provider mode is inconsistent');
  if (snapshot.presentment) {
    const local = snapshot.presentment;
    if (!/^[a-z]{3}$/.test(local.currency) || !Number.isSafeInteger(local.amountMinor) || local.amountMinor < 0)
      throw new StripeUnavailableError('Money observation presentment is inconsistent');
    const amounts = { presentment_currency: local.currency, presentment_amount: local.amountMinor };
    add(
      observation(
        snapshot.moneyProvenance ? { ...snapshot.moneyProvenance, context: 'checkout.presentment' } : null,
        snapshot.sessionId,
        'checkout.presentment',
        local.currency,
        local.moneyUnit,
        amounts,
        JSON.stringify(amounts),
      ),
    );
  }
  for (const transaction of snapshot.transactions) {
    const provenance = transaction.moneyProvenance;
    if (
      provenance &&
      (!snapshot.moneyProvenance ||
        provenance.accountNamespace !== snapshot.moneyProvenance.accountNamespace ||
        provenance.livemode !== snapshot.livemode)
    )
      throw new StripeUnavailableError('Money observation provider namespace is inconsistent');
    add(
      observation(
        provenance,
        transaction.id,
        'balance_transaction',
        transaction.currency,
        transaction.moneyUnit,
        {
          currency: transaction.currency,
          amount: transaction.amountMinor,
          fee: transaction.feeMinor,
          net: transaction.netMinor,
        },
        movementEconomics(transaction),
      ),
    );
  }
  return result;
}

export async function appendCheckoutMoneyObservations(
  client: Client,
  route: number,
  order: Order,
  snapshot: CheckoutSnapshot,
  command: { time: string; transactionId: string },
) {
  const observations = checkoutMoneyObservations(snapshot, order);
  if (!observations.length) return [];
  return insert.run(queryClient(client), {
    route,
    order_id: order.id,
    buyer: order.buyerAccountId,
    observations,
    observed_at: snapshot.observedAt,
    at: command.time,
    transaction_id: command.transactionId,
  });
}

export async function interpretedTransactions(
  client: Client,
  route: number,
  orderId: string,
  transactions: readonly StripeTransaction[],
): Promise<StripeTransaction[]> {
  assertTransactionBound(transactions);
  if (!transactions.length) return [];
  const rows = await read.run(queryClient(client), {
    route,
    order_id: orderId,
    objects: transactions.map(({ id }) => ({ id, context: 'balance_transaction' })),
  });
  return transactions.map((transaction) => {
    const row = rows.find(
      (row) =>
        row.objectId === transaction.id && row.economicsHash === moneyEconomicsHash(movementEconomics(transaction)),
    );
    if (!row) return { ...transaction, moneyUnit: null, providerApiVersion: null, moneyProvenance: null };
    return {
      ...transaction,
      moneyUnit: recordedStripeUnit(JSON.parse(row.unit!)),
      providerApiVersion: row.providerApiVersion,
      moneyProvenance: {
        objectId: transaction.id,
        object: 'balance_transaction',
        context: 'balance_transaction',
        accountNamespace: row.accountNamespace,
        livemode: row.livemode,
        requestApiVersion: row.requestApiVersion,
        responseApiVersion: row.responseApiVersion,
      },
    };
  });
}

export async function checkoutIntegrationMoney(
  client: Client,
  route: number,
  order: Order,
): Promise<Readonly<{
  moneyUnit: StripeMoneyUnit;
  amountTaxMinor: number;
}> | null> {
  if (!order.checkoutSessionId) return null;
  const rows = await read.run(queryClient(client), {
    route,
    order_id: order.id,
    objects: [{ id: order.checkoutSessionId, context: 'checkout.integration' }],
  });
  const row = rows[0];
  if (!row) return null;
  const amounts = JSON.parse(row.amounts) as Record<string, unknown>;
  if (
    amounts.currency !== order.currency ||
    amounts.amount_subtotal !== order.unitAmountMinor ||
    (order.amountTaxMinor != null && amounts['total_details.amount_tax'] !== order.amountTaxMinor)
  )
    return null;
  const moneyUnit = recordedStripeUnit(JSON.parse(row.unit!));
  const tax = amounts['total_details.amount_tax'];
  if (!moneyUnit || typeof tax !== 'number' || !Number.isSafeInteger(tax) || tax < 0) return null;
  return { moneyUnit, amountTaxMinor: tax };
}

export async function integrationMoneyUnit(
  client: Client,
  route: number,
  order: Order,
): Promise<StripeMoneyUnit | null> {
  return (await checkoutIntegrationMoney(client, route, order))?.moneyUnit ?? null;
}
