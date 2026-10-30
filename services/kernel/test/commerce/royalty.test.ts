import { expect, test } from 'bun:test';
import type { Order, StripeTransaction } from '../../src/commerce/model.ts';
import { royaltyLines, statementPeriod, statementTotals } from '../../src/commerce/royalty.ts';

const order: Order = {
  id: 'order',
  buyerAccountId: 'buyer',
  offerId: 'offer',
  offerRevision: 1,
  targetSubjectId: 'subject',
  creatorAccountId: 'creator',
  title: 'Book',
  currency: 'usd',
  unitAmountMinor: 1000,
  taxCode: 'txcd_10302000',
  royaltyBasisPoints: 9000,
  settlement: 'paid',
  checkoutSessionId: 'cs_sale',
  checkoutUrl: null,
  checkoutExpiresAt: null,
  observedAt: null,
  createdAt: '2026-01-10T00:00:00Z',
  revision: 1,
};
// Synthetic amounts using Stripe's signed amount, fee breakdown, net and settlement currency fields:
// https://docs.stripe.com/api/balance_transactions/object
const fee = (type: string, amountMinor: number, description: string | null = null) => ({
  type,
  amountMinor,
  description,
});
function transaction(
  id: string,
  kind: StripeTransaction['kind'],
  amountMinor: number,
  feeDetails: StripeTransaction['feeDetails'] = [],
  extra: Partial<StripeTransaction> = {},
): StripeTransaction {
  const feeMinor = feeDetails.reduce((sum, detail) => sum + detail.amountMinor, 0);
  return {
    id,
    kind,
    sourceId: kind === 'charge' ? 'ch_sale' : kind.startsWith('refund') ? 're_sale' : 'du_sale',
    currency: 'usd',
    amountMinor,
    feeMinor,
    netMinor: amountMinor - feeMinor,
    feeDetails,
    exchangeRate: null,
    created: '2026-01-10T00:00:00Z',
    ...extra,
  };
}

test('legacy worked example exposes every deduction once, including tax within Stripe fee', () => {
  // legacy-final:docs/legal/creator-distribution-agreement-outline.md section 4.
  // Managed Payments withholds tax inside fee; pricing adds MoR fees to processing fees:
  // https://docs.stripe.com/payments/managed-payments/how-it-works#reports
  // https://docs.stripe.com/reports/balance ; https://stripe.com/pricing#managed-payments
  const lines = royaltyLines(order, 200, [
    transaction('txn_charge', 'charge', 1200, [
      fee('withheld_tax', 200),
      fee('stripe_fee', 35, 'Processing'),
      fee('stripe_fee', 15, 'Managed Payments'),
    ]),
    // No evidence of a tax credit: some jurisdictions retain the original tax after refunding it.
    // https://docs.stripe.com/payments/managed-payments/how-it-works#refund-support
    transaction('txn_refund', 'refund', -100),
  ]);
  expect(lines).toEqual([
    {
      balanceTransactionId: 'txn_charge',
      orderId: order.id,
      currency: 'usd',
      kind: 'charge',
      created: '2026-01-10T00:00:00Z',
      grossMinor: 1200,
      taxMinor: 200,
      feeMinor: 50,
      disputeFeeMinor: 0,
      netReceiptsMinor: 950,
    },
    {
      balanceTransactionId: 'txn_refund',
      orderId: order.id,
      currency: 'usd',
      kind: 'refund',
      created: '2026-01-10T00:00:00Z',
      grossMinor: -100,
      taxMinor: 0,
      feeMinor: 0,
      disputeFeeMinor: 0,
      netReceiptsMinor: -100,
    },
  ]);
  expect(statementTotals(lines, 9000)).toEqual([
    {
      currency: 'usd',
      grossMinor: 1100,
      taxMinor: 200,
      feeMinor: 50,
      refundsMinor: 100,
      chargebacksMinor: 0,
      disputeFeeMinor: 0,
      netReceiptsMinor: 850,
      creatorShareMinor: 765,
      rezicsShareMinor: 85,
    },
  ]);
});

test('all transaction kinds retain signed tax and actual fee credits; dispute fees are informational', () => {
  // Refund fees are not presumed returned; a recorded negative fee is an actual credit.
  // https://docs.stripe.com/refunds ; https://docs.stripe.com/api/balance_transactions/object?query=fee_details
  // Dispute withdrawal and reinstatement: https://docs.stripe.com/reports/balance-transaction-types
  // Managed Payments still charges received-dispute fees to the account:
  // https://docs.stripe.com/payments/managed-payments/how-it-works#dispute-support
  const lines = royaltyLines(order, 200, [
    transaction('charge', 'charge', 1200, [fee('withheld_tax', 200), fee('stripe_fee', 50)]),
    transaction('refund', 'refund', -240, [fee('withheld_tax', -40), fee('stripe_fee', -5)]),
    transaction('refund_failure', 'refund_reversal', 240, [fee('withheld_tax', 40), fee('stripe_fee', 5)]),
    transaction('dispute', 'dispute', -1200, [fee('stripe_fee', 1500)]),
    transaction('won', 'dispute_reversal', 1200, [fee('stripe_fee', -1500), fee('withheld_tax', 0)]),
  ]);
  expect(
    lines.map((line) => [line.grossMinor, line.taxMinor, line.feeMinor, line.disputeFeeMinor, line.netReceiptsMinor]),
  ).toEqual([
    [1200, 200, 50, 0, 950],
    [-240, -40, -5, 0, -195],
    [240, 40, 5, 0, 195],
    [-1200, 0, 0, 1500, -1200],
    [1200, 0, 0, -1500, 1200],
  ]);
  expect(statementTotals(lines, 9000)[0]).toEqual({
    currency: 'usd',
    grossMinor: 1200,
    taxMinor: 200,
    feeMinor: 50,
    refundsMinor: 0,
    chargebacksMinor: 0,
    disputeFeeMinor: 0,
    netReceiptsMinor: 950,
    creatorShareMinor: 855,
    rezicsShareMinor: 95,
  });
});

test('refund failure returns the original debit in the later period without inventing returned processing fees', () => {
  // failure_balance_transaction returns the failed refund to the balance:
  // https://docs.stripe.com/refunds#handle-failed-refunds ; https://docs.stripe.com/api/refunds/object
  const lines = royaltyLines(order, 0, [
    transaction('refund', 'refund', -100),
    transaction('failure', 'refund_reversal', 100, [], { created: '2026-02-03T00:00:00Z' }),
  ]);
  expect(lines.map((line) => line.netReceiptsMinor)).toEqual([-100, 100]);
  expect(statementPeriod(lines[1]!.created)).toBe('2026-02');
  expect(statementTotals(lines, 9000)[0]!.netReceiptsMinor).toBe(0);
});

test('tax credits need withheld_tax evidence; undocumented positive reversals reserve proportional tax', () => {
  // Tax can remain payable even on refunds; no documented universal reversal tax allocation:
  // https://docs.stripe.com/payments/managed-payments/how-it-works#refund-support
  // Assumption: absent evidence, grant no tax credit, and reserve tax on positive reversals.
  const lines = royaltyLines(order, 200, [
    transaction('refund', 'refund', -240),
    transaction('failure', 'refund_reversal', 240),
    transaction('won', 'dispute_reversal', 240),
  ]);
  expect(lines.map((line) => line.taxMinor)).toEqual([0, 40, 40]);
  expect(lines.map((line) => line.netReceiptsMinor)).toEqual([-240, 200, 200]);
});

test('settlement conversion uses the balance rate once and rounds uncertain fractional tax upward', () => {
  // 10 EUR becomes 12.34 USD at exchange_rate 1.234:
  // https://docs.stripe.com/api/balance_transactions/object#balance_transaction_object-exchange_rate
  // Checkout total_details.amount_tax is the sum of tax amounts:
  // https://docs.stripe.com/api/checkout/sessions/object?query=total_details
  const eurOrder = { ...order, currency: 'eur', unitAmountMinor: 919 };
  const [line] = royaltyLines(eurOrder, 81, [
    transaction('fx', 'charge', 1234, [fee('stripe_fee', 34)], { exchangeRate: 1.234 }),
  ]);
  // Assumption: the cited API does not prescribe tax allocation rounding; ceiling never overpays.
  expect(line).toMatchObject({
    currency: 'usd',
    grossMinor: 1234,
    taxMinor: 100,
    feeMinor: 34,
    netReceiptsMinor: 1100,
  });
  // An explicit withheld_tax is already in settlement units and takes precedence over the estimate.
  expect(
    royaltyLines(eurOrder, 81, [
      transaction('actual', 'charge', 1234, [fee('withheld_tax', 99), fee('stripe_fee', 34)], { exchangeRate: 1.234 }),
    ])[0]!.taxMinor,
  ).toBe(99);
  // Currency minor units differ: https://docs.stripe.com/currencies#zero-decimal
  expect(
    royaltyLines(order, 200, [transaction('yen', 'charge', 1800, [], { currency: 'jpy', exchangeRate: 150 })])[0]!
      .taxMinor,
  ).toBe(300);
  // Decimal rate arithmetic must not turn an exact 7 cents into 8 through binary floating point.
  expect(
    royaltyLines(eurOrder, 100, [transaction('decimal', 'charge', 71, [], { exchangeRate: 0.07 })])[0]!.taxMinor,
  ).toBe(7);
});

test('Adaptive Pricing session tax uses integration currency, without converting local presentment twice', () => {
  // Session currency/amounts remain integration currency; presentment_details describes local payment:
  // https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted
  // Its example: integration USD 1000, local presentment CAD 1370. No balance conversion is needed.
  expect(
    royaltyLines({ ...order, unitAmountMinor: 900 }, 100, [transaction('adaptive', 'charge', 1000)])[0]!.taxMinor,
  ).toBe(100);
});

test('later refunds and disputes make negative statements without reopening the paid sale month', () => {
  // Balance transactions record each movement when created, rather than rewriting the charge:
  // https://docs.stripe.com/reports/balance-transaction-types ; https://docs.stripe.com/api/balance_transactions/object
  const lines = royaltyLines(order, 200, [
    transaction('paid', 'charge', 1200, [fee('withheld_tax', 200), fee('stripe_fee', 50)]),
    transaction('later_refund', 'refund', -100, [], { created: '2026-02-01T00:00:00Z' }),
    transaction('later_dispute', 'dispute', -300, [fee('stripe_fee', 1500)], { created: '2026-02-15T00:00:00Z' }),
  ]);
  const totals = (month: string) =>
    statementTotals(
      lines.filter((line) => statementPeriod(line.created) === month),
      9000,
    )[0]!;
  expect(totals('2026-01').creatorShareMinor).toBe(855);
  expect(totals('2026-02')).toEqual({
    currency: 'usd',
    grossMinor: -400,
    taxMinor: 0,
    feeMinor: 0,
    refundsMinor: 100,
    chargebacksMinor: 300,
    disputeFeeMinor: 1500,
    netReceiptsMinor: -400,
    creatorShareMinor: -360,
    rezicsShareMinor: -40,
  });
});

test('creator shares round toward zero once over each currency statement with exact integer products', () => {
  // Signed, minor-unit balance amounts: https://docs.stripe.com/api/balance_transactions/object
  // The statement rounding rule is the current task contract, including negative statements.
  const lines = royaltyLines(order, 0, [
    transaction('a', 'charge', 1),
    transaction('b', 'charge', 1),
    transaction('c', 'refund', -1, [], { currency: 'eur' }),
    transaction('d', 'refund', -1, [], { currency: 'eur' }),
  ]);
  expect(
    statementTotals(lines, 5555).map((total) => [total.currency, total.creatorShareMinor, total.rezicsShareMinor]),
  ).toEqual([
    ['usd', 1, 1],
    ['eur', -1, -1],
  ]);
  const big = royaltyLines(order, 0, [transaction('large', 'charge', Number.MAX_SAFE_INTEGER)]);
  expect(statementTotals(big, 9999)[0]!.creatorShareMinor).toBe(9006298534815516);
  expect(statementTotals(big, 0)[0]!.creatorShareMinor).toBe(0);
  expect(statementTotals(big, 10000)[0]!.rezicsShareMinor).toBe(0);
  const canceled = royaltyLines(order, 0, [
    transaction('max1', 'charge', Number.MAX_SAFE_INTEGER),
    transaction('max2', 'charge', Number.MAX_SAFE_INTEGER),
    transaction('minus', 'refund', -Number.MAX_SAFE_INTEGER),
  ]);
  expect(statementTotals(canceled, 9999)[0]!.netReceiptsMinor).toBe(Number.MAX_SAFE_INTEGER);
});

test('recomputation and duplicate balance transaction IDs preserve identical immutable lines', () => {
  // Balance transaction ID identifies the movement: https://docs.stripe.com/api/balance_transactions/object
  const input = [transaction('id', 'charge', 1200, [fee('withheld_tax', 200), fee('stripe_fee', 50)])];
  const before = structuredClone(input);
  const lines = royaltyLines(order, 200, input);
  expect(royaltyLines(order, 200, input)).toEqual(lines);
  expect(royaltyLines(order, 200, [...input, structuredClone(input[0]!)])).toEqual(lines);
  expect(statementTotals([...lines, ...lines], 9000)).toEqual(statementTotals(lines, 9000));
  expect(input).toEqual(before);
  expect(royaltyLines(order, 0, [])).toEqual([]);
  expect(statementTotals([], 9000)).toEqual([]);
});

test('incomplete fee evidence, conflicting IDs and unsafe arithmetic fail instead of overpaying', () => {
  // fee_details breaks down fee; net = amount - fee:
  // https://docs.stripe.com/api/balance_transactions/object
  expect(() =>
    royaltyLines(order, 0, [transaction('bad', 'charge', 100, [], { feeMinor: 10, netMinor: 90 })]),
  ).toThrow();
  expect(() => royaltyLines(order, 0, [transaction('bad', 'charge', 100, [fee('unknown', 10)])])).toThrow();
  expect(() => royaltyLines(order, 0, [transaction('bad', 'charge', 100, [], { netMinor: 99 })])).toThrow();
  expect(() => royaltyLines(order, 0, [transaction('same', 'charge', 1), transaction('same', 'charge', 2)])).toThrow();
  expect(() => royaltyLines(order, null, [transaction('unknown_tax', 'charge', 100)])).toThrow();
  expect(() =>
    royaltyLines(order, 10, [transaction('missing_rate', 'charge', 100, [], { currency: 'eur' })]),
  ).toThrow();
  expect(() => royaltyLines(order, 0, [transaction('unsafe', 'charge', Number.MAX_SAFE_INTEGER + 1)])).toThrow();
  const lines = royaltyLines(order, 0, [transaction('one', 'charge', 1)]);
  for (const rate of [-1, 10001, 0.5, NaN]) expect(() => statementTotals(lines, rate)).toThrow();
});

test('statement periods are UTC calendar months, including offset boundaries and invalid dates', () => {
  // created is the movement timestamp: https://docs.stripe.com/api/balance_transactions/object
  expect(statementPeriod('2026-02-01T00:30:00+01:00')).toBe('2026-01');
  expect(statementPeriod('2026-12-31T23:30:00-01:00')).toBe('2027-01');
  expect(statementPeriod(new Date('2024-02-29T23:59:59Z'))).toBe('2024-02');
  expect(() => statementPeriod('invalid')).toThrow();
});

test('fee detail order and mutable descriptions do not create conflicting royalty copies', () => {
  const movement = transaction('stable', 'charge', 1200, [fee('withheld_tax', 200), fee('stripe_fee', 50)]);
  const replay = {
    ...movement,
    feeDetails: [...movement.feeDetails].reverse().map((detail) => ({ ...detail, description: 'changed' })),
  };
  expect(royaltyLines(order, 200, [movement, replay])).toEqual(royaltyLines(order, 200, [movement]));
});
