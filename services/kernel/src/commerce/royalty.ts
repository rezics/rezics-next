import type { Order, StripeTransaction, TransactionKind } from './model.ts';
import { movementEconomics, MovementIntegrityError } from './settlement.ts';
import { recordedMoneyUnit, sameMoneyUnit, type StripeMoneyUnit } from './money.ts';

export class MoneyInterpretationUnavailable extends Error {
  constructor() {
    super('Royalty money interpretation unavailable');
    this.name = 'MoneyInterpretationUnavailable';
  }
}

export type RoyaltyLine = {
  moneyUnit?: StripeMoneyUnit | null;
  balanceTransactionId: string;
  orderId: string;
  currency: string;
  kind: TransactionKind;
  created: string;
  grossMinor: number;
  taxMinor: number;
  feeMinor: number;
  disputeFeeMinor: number;
  netReceiptsMinor: number;
};

export type StatementTotal = Pick<
  RoyaltyLine,
  'currency' | 'moneyUnit' | 'grossMinor' | 'taxMinor' | 'feeMinor' | 'disputeFeeMinor' | 'netReceiptsMinor'
> & {
  /** Signed deductions: reversals reduce these subtotals. Already included in grossMinor. */
  refundsMinor: number;
  chargebacksMinor: number;
  creatorShareMinor: number;
  rezicsShareMinor: number;
};

function integer(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new RangeError('Amounts must be safe integers');
  return BigInt(value);
}

function minor(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Statement amount exceeds safe integer range');
  return result;
}

function ceiling(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function convertedTax(
  tax: bigint,
  from: string,
  fromUnit: StripeMoneyUnit | null | undefined,
  transaction: StripeTransaction,
): bigint {
  if (tax === 0n) return tax;
  if (!recordedMoneyUnit(fromUnit) || !recordedMoneyUnit(transaction.moneyUnit))
    throw new MoneyInterpretationUnavailable();
  if (from === transaction.currency) {
    if (!sameMoneyUnit(fromUnit, transaction.moneyUnit)) throw new MoneyInterpretationUnavailable();
    return tax;
  }
  const rate = transaction.exchangeRate;
  if (rate === null || !Number.isFinite(rate) || rate <= 0)
    throw new RangeError('Missing valid settlement exchange rate');
  // exchange_rate multiplies charge currency into balance currency. Stripe's example is EUR 10 → USD 12.34:
  // https://docs.stripe.com/api/balance_transactions/object#balance_transaction_object-exchange_rate
  // Parse the supplied decimal exactly; binary multiplication can invent a fractional minor unit.
  const [coefficient, exponent = '0'] = String(rate).toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient!.split('.');
  const power = Number(exponent) - fraction.length;
  const numerator = BigInt(whole! + fraction) * 10n ** BigInt(Math.max(0, power));
  const denominator = 10n ** BigInt(Math.max(0, -power));
  // Assumption: the API above defines the rate, not rounding for an allocated tax component.
  // Reserve the next whole settlement minor unit so rounding cannot overpay the creator.
  return ceiling(
    tax * numerator * 10n ** BigInt(transaction.moneyUnit!.exponent),
    denominator * 10n ** BigInt(fromUnit!.exponent),
  );
}

/** snapshotTax is Checkout total_details.amount_tax, in the Session's integration currency. */
export function royaltyLines(
  order: Order,
  snapshotTax: number | null,
  transactions: readonly StripeTransaction[],
  integrationUnit?: StripeMoneyUnit | null,
): RoyaltyLine[] {
  // amount_tax sums Session taxes:
  // https://docs.stripe.com/api/checkout/sessions/object?query=total_details
  // Adaptive Pricing keeps Session amounts in integration currency; presentment_details is the
  // customer's local amount. Do not convert that amount or apply its rate a second time:
  // https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted
  const tax = snapshotTax === null ? null : integer(snapshotTax);
  const subtotal = integer(order.unitAmountMinor);
  if ((tax !== null && tax < 0n) || subtotal < 0n) throw new RangeError('Sale amounts must be nonnegative');
  const lines = new Map<string, { signature: string; line: RoyaltyLine }>();
  for (const transaction of transactions) {
    const moneyUnit = recordedMoneyUnit(transaction.moneyUnit);
    if (!moneyUnit) throw new MoneyInterpretationUnavailable();
    const gross = integer(transaction.amountMinor);
    const stripeFee = integer(transaction.feeMinor);
    // amount is signed gross, including collected tax. fee includes withheld tax, and only net
    // reaches the balance: net = amount - fee. Separate withheld tax rather than deducting fee again.
    // https://docs.stripe.com/api/balance_transactions/object
    // https://docs.stripe.com/payments/managed-payments/how-it-works#reports
    // https://docs.stripe.com/reports/balance (withheld_tax and fee_net_of_withheld_tax columns)
    if (gross - stripeFee !== integer(transaction.netMinor)) throw new Error('Inconsistent Stripe net');
    const dispute = transaction.kind === 'dispute' || transaction.kind === 'dispute_reversal';
    const debit = transaction.kind === 'refund' || transaction.kind === 'dispute';
    if (debit ? gross > 0n : gross < 0n) throw new Error('Transaction kind disagrees with amount sign');
    let documentedFees = 0n,
      fees = 0n,
      disputeFees = 0n;
    let withheld: bigint | null = null;
    for (const detail of transaction.feeDetails) {
      const amount = integer(detail.amountMinor);
      documentedFees += amount;
      // These are fee_details.type values, not balance transaction types:
      // https://docs.stripe.com/api/balance_transactions/object?query=fee_details
      if (detail.type === 'withheld_tax') {
        withheld = (withheld ?? 0n) + amount;
      } else if (
        detail.type === 'stripe_fee' ||
        detail.type === 'payment_method_passthrough_fee' ||
        detail.type === 'tax'
      ) {
        // Managed Payments pricing adds its fee to Payments fees; use actual details, never a price estimate:
        // https://stripe.com/pricing#managed-payments
        // Assumptions: the fee enum above does not distinguish a MoR fee from other stripe_fee entries,
        // nor explain tax versus withheld_tax. Treat tax as tax on fees and include it in feeMinor.
        // On a dispute movement, treat all non-withheld fee details as dispute fees. The API supplies
        // no separate dispute fee type; never infer classification from the arbitrary description.
        // Managed Payments manages disputes but charges received-dispute fees to this account:
        // https://docs.stripe.com/payments/managed-payments/how-it-works#dispute-support
        if (dispute) disputeFees += amount;
        else fees += amount;
      } else {
        // Unknown/incomplete fee evidence cannot safely authorize a payout. Connect application fees
        // aren't part of Managed Payments: https://docs.stripe.com/payments/managed-payments
        throw new Error(`Unsupported fee type: ${detail.type}`);
      }
    }
    if (documentedFees !== stripeFee) throw new Error('Incomplete Stripe fee breakdown');
    let lineTax = withheld;
    if (lineTax === null) {
      // Refunds include the customer's tax, but some jurisdictions retain and remit the original tax:
      // https://docs.stripe.com/payments/managed-payments/how-it-works#refund-support
      // Assumption: without a recorded withheld_tax credit, grant no tax credit on refunds/disputes.
      lineTax = 0n;
      if (!debit) {
        if (tax === null) throw new Error('Missing Checkout tax evidence');
        if (transaction.kind === 'charge') lineTax = convertedTax(tax, order.currency, integrationUnit, transaction);
        else if (tax > 0n) {
          // Refund failures return funds, and won disputes reinstate funds:
          // https://docs.stripe.com/refunds#handle-failed-refunds
          // https://docs.stripe.com/reports/balance-transaction-types
          // Assumption: those pages do not define re-withheld tax. Without explicit evidence, reserve
          // the original tax proportion on positive reversals, rounded upward, even if a prior debit
          // had no tax credit. Currency units cancel in the tax / original total ratio.
          lineTax = ceiling(gross * tax, subtotal + tax);
        }
      }
    }
    // Stripe doesn't normally return processing fees on refunds. Credit only actual negative details:
    // https://docs.stripe.com/refunds
    const line: RoyaltyLine = {
      moneyUnit,
      balanceTransactionId: transaction.id,
      orderId: order.id,
      currency: transaction.currency,
      kind: transaction.kind,
      created: transaction.created,
      grossMinor: minor(gross),
      taxMinor: minor(lineTax),
      feeMinor: minor(fees),
      disputeFeeMinor: minor(disputeFees),
      netReceiptsMinor: minor(gross - lineTax - fees),
    };
    const signature = movementEconomics(transaction);
    const previous = lines.get(transaction.id);
    if (previous && previous.signature !== signature) throw new MovementIntegrityError();
    if (!previous) lines.set(transaction.id, { signature, line });
  }
  return Array.from(lines.values(), (entry) => entry.line);
}

const amountFields = ['grossMinor', 'taxMinor', 'feeMinor', 'disputeFeeMinor', 'netReceiptsMinor'] as const;

/** Each deduction is included once in net; refund/chargeback subtotals describe movements already in gross. */
export function statementTotals(
  lines: readonly (RoyaltyLine & { royaltyBasisPoints?: number })[],
  royaltyBasisPoints?: number,
): StatementTotal[] {
  function rate(value: number): bigint {
    const result = integer(value);
    if (result < 0n || result > 10000n) throw new RangeError('Invalid royalty basis points');
    return result;
  }
  if (royaltyBasisPoints !== undefined) rate(royaltyBasisPoints);
  const currencies = new Map<
    string,
    Record<(typeof amountFields)[number] | 'refundsMinor' | 'chargebacksMinor' | 'weightedNetMinor', bigint>
  >();
  const seen = new Map<string, string>();
  const units = new Map<string, StripeMoneyUnit>();
  for (const line of lines) {
    const unit = recordedMoneyUnit(line.moneyUnit);
    if (!unit || (units.has(line.currency) && !sameMoneyUnit(units.get(line.currency), unit)))
      throw new MoneyInterpretationUnavailable();
    units.set(line.currency, unit);
    const basisPoints = rate(line.royaltyBasisPoints ?? royaltyBasisPoints!);
    const amounts = amountFields.map((field) => integer(line[field]));
    const signature = JSON.stringify([
      line.orderId,
      line.kind,
      line.created,
      line.currency,
      unit,
      ...amountFields.map((field) => line[field]),
      String(basisPoints),
    ]);
    const previous = seen.get(line.balanceTransactionId);
    if (previous !== undefined) {
      if (previous !== signature) throw new Error('Conflicting royalty line ID');
      continue;
    }
    seen.set(line.balanceTransactionId, signature);
    if (amounts[0]! - amounts[1]! - amounts[2]! !== amounts[4]!) throw new Error('Inconsistent Net Receipts');
    let total = currencies.get(line.currency);
    if (!total) {
      total = {
        grossMinor: 0n,
        taxMinor: 0n,
        feeMinor: 0n,
        disputeFeeMinor: 0n,
        netReceiptsMinor: 0n,
        refundsMinor: 0n,
        chargebacksMinor: 0n,
        weightedNetMinor: 0n,
      };
      currencies.set(line.currency, total);
    }
    for (const [index, field] of amountFields.entries()) total[field] += amounts[index]!;
    total.weightedNetMinor += amounts[4]! * basisPoints;
    if (line.kind === 'refund' || line.kind === 'refund_reversal') total.refundsMinor -= amounts[0]!;
    if (line.kind === 'dispute' || line.kind === 'dispute_reversal') total.chargebacksMinor -= amounts[0]!;
  }
  return Array.from(currencies, ([currency, total]) => {
    // BigInt division truncates toward zero, after summing the entire currency statement.
    const creator = total.weightedNetMinor / 10000n;
    return {
      currency,
      moneyUnit: units.get(currency)!,
      grossMinor: minor(total.grossMinor),
      taxMinor: minor(total.taxMinor),
      feeMinor: minor(total.feeMinor),
      disputeFeeMinor: minor(total.disputeFeeMinor),
      refundsMinor: minor(total.refundsMinor),
      chargebacksMinor: minor(total.chargebacksMinor),
      netReceiptsMinor: minor(total.netReceiptsMinor),
      creatorShareMinor: minor(creator),
      rezicsShareMinor: minor(total.netReceiptsMinor - creator),
    };
  });
}

/** A later debit belongs to its own UTC month even if the original sale's statement has been paid. */
export function statementPeriod(time: string | number | Date): string {
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid statement time');
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
