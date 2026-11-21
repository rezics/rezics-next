import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import type { StripeTransaction, TransactionKind } from './model.ts';
import { interpretedTransactions, moneyEconomicsHash } from './money-observation.ts';
import { recordedMoneyUnit, sameMoneyUnit, stripeEvidenceMoneyUnit, type StripeMoneyUnit } from './money.ts';
import { movementEconomics } from './settlement.ts';
import namedTransactions from './store-transactions-named.sql';
import { readOrder } from './store.ts';

export type CommerceTestMoney = Readonly<{
  namespace: string;
  mode: 'test';
  currency: string;
  unit: StripeMoneyUnit;
}>;

export type CommerceFinancialEvidence = Readonly<{
  orderId: string;
  creatorId: string;
  offerId: string;
  statementId: string;
  movementId: string;
  sourceId: string;
  kind: TransactionKind;
  currency: string;
  unit: StripeMoneyUnit;
  amountMinor: string;
  feeMinor: string;
  netMinor: string;
  economicDigest: string;
}>;

export function isCommerceTestMoney(binding: CommerceTestMoney): boolean {
  return (
    binding.mode === 'test' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(binding.namespace) &&
    sameMoneyUnit(recordedMoneyUnit(binding.unit), stripeEvidenceMoneyUnit(binding.currency, 'balance_transaction'))
  );
}

type SourceResult =
  | Readonly<{ kind: 'ok'; value: CommerceFinancialEvidence }>
  | Readonly<{ kind: 'unresolved' | 'invalid_operation' | 'operation_conflict' }>;

type Attribution = Readonly<{
  orderId: string;
  creatorId: string;
  offerId: string;
  statementId: string;
  kind: TransactionKind;
  currency: string;
  unit: unknown;
  grossMinor: string;
  taxMinor: string;
  feeMinor: string;
  disputeFeeMinor: string;
  netReceiptsMinor: string;
  basisPoints: number;
  created: string;
}>;

/** Named read of native facts. The buyer's movement and creator's attribution are immutable in their own routes. */
export async function readCreatorFinancialSource(
  client: Pick<PoolClient, 'query'>,
  binding: CommerceTestMoney,
  { orderId, movementId }: Readonly<{ orderId: string; movementId: string }>,
): Promise<SourceResult> {
  const buyerRoute = routeOf(orderId);
  if (!isCommerceTestMoney(binding) || buyerRoute === null || !/^txn_[A-Za-z0-9]{1,250}$/.test(movementId))
    return { kind: 'invalid_operation' };
  const order = await readOrder(client, buyerRoute, orderId);
  if (!order) return { kind: 'unresolved' };
  const [retained] = await namedTransactions.run(
    { query: client.query.bind(client) },
    { route: buyerRoute, ids: [movementId] },
  );
  if (!retained) return { kind: 'unresolved' };
  if (retained.orderId !== order.id) return { kind: 'operation_conflict' };
  const amountMinor = Number(retained.amountMinor);
  const feeMinor = Number(retained.feeMinor);
  const netMinor = Number(retained.netMinor);
  const exchangeRate = retained.exchangeRate === null ? null : Number(retained.exchangeRate);
  const feeDetails = JSON.parse(retained.feeDetails) as StripeTransaction['feeDetails'];
  if (
    ![amountMinor, feeMinor, netMinor].every(Number.isSafeInteger) ||
    (exchangeRate !== null && (!Number.isFinite(exchangeRate) || exchangeRate <= 0)) ||
    !Array.isArray(feeDetails) ||
    !feeDetails.every(
      (detail) => detail && typeof detail.type === 'string' && Number.isSafeInteger(detail.amountMinor),
    ) ||
    !retained.sourceId ||
    retained.sourceId.length > 255
  )
    return { kind: 'unresolved' };
  const [movement] = await interpretedTransactions(client, buyerRoute, order.id, [
    {
      id: retained.id,
      kind: retained.kind,
      sourceId: retained.sourceId,
      currency: retained.currency,
      amountMinor,
      feeMinor,
      netMinor,
      feeDetails,
      exchangeRate,
      created: new Date(retained.created).toISOString(),
    },
  ]);
  const creatorRoute = routeOf(order.creatorAccountId);
  if (
    creatorRoute === null ||
    !movement ||
    movement.moneyProvenance?.livemode !== false ||
    movement.moneyProvenance.accountNamespace !== binding.namespace ||
    movement.currency !== binding.currency ||
    !sameMoneyUnit(movement.moneyUnit, binding.unit)
  )
    return { kind: 'unresolved' };

  const { rows } = await client.query<Attribution>(
    `SELECT order_id AS "orderId", creator_account_id AS "creatorId", offer_id AS "offerId",
              statement_id AS "statementId", kind, currency, money_unit AS unit, gross_minor::text AS "grossMinor",
              tax_minor::text AS "taxMinor", fee_minor::text AS "feeMinor", dispute_fee_minor::text AS "disputeFeeMinor",
              net_receipts_minor::text AS "netReceiptsMinor", royalty_basis_points AS "basisPoints",
              to_char(stripe_created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created
       FROM commerce.royalty_line WHERE route = $1 AND balance_transaction_id = $2`,
    [creatorRoute, movementId],
  );
  const line = rows[0];
  if (!line || !sameMoneyUnit(recordedMoneyUnit(line.unit), binding.unit)) return { kind: 'unresolved' };
  if (
    line.orderId !== order.id ||
    line.creatorId !== order.creatorAccountId ||
    line.offerId !== order.offerId ||
    line.kind !== movement.kind ||
    line.currency !== movement.currency ||
    line.grossMinor !== retained.amountMinor ||
    line.basisPoints !== order.royaltyBasisPoints ||
    line.created !== movement.created.replace(/Z$/, '000Z')
  )
    return { kind: 'operation_conflict' };

  const economicDigest = moneyEconomicsHash(
    JSON.stringify([
      movementEconomics(movement),
      retained.exchangeRate,
      line.grossMinor,
      line.taxMinor,
      line.feeMinor,
      line.disputeFeeMinor,
      line.netReceiptsMinor,
      line.basisPoints,
    ]),
  );
  return {
    kind: 'ok',
    value: {
      orderId: order.id,
      creatorId: line.creatorId,
      offerId: line.offerId,
      statementId: line.statementId,
      movementId,
      sourceId: movement.sourceId,
      kind: movement.kind,
      currency: movement.currency,
      unit: binding.unit,
      amountMinor: retained.amountMinor,
      feeMinor: retained.feeMinor,
      netMinor: retained.netMinor,
      economicDigest,
    },
  };
}
