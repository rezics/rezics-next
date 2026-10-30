/** Adopted Stripe field units; this evidence never admits a sale or qualifies an account. */
export type StripeMoneyUnit = Readonly<{
  system: 'stripe-api';
  exponent: 0 | 2;
  factsVersion: 'stripe-money-v1';
}>;
export type MoneyFieldContext =
  | 'integration_price'
  | 'checkout_integration'
  | 'checkout_presentment'
  | 'balance_transaction';
export type ConfiguredSaleCurrencyRule = Readonly<{
  currency: 'usd' | 'eur';
  unit: StripeMoneyUnit;
  minAmountMinor: 50;
  maxAmountMinor: 99999999;
  chargeMultiple: 1;
}>;
export type CommerceMoneyPolicy = Readonly<{
  configuredSaleCurrencies: readonly ConfiguredSaleCurrencyRule[];
  taxBehavior: 'exclusive';
}>;
const scale2: StripeMoneyUnit = Object.freeze({ system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' });
const scale0: StripeMoneyUnit = Object.freeze({ system: 'stripe-api', exponent: 0, factsVersion: 'stripe-money-v1' });
const chargeContexts = Object.freeze(['integration_price', 'checkout_integration', 'checkout_presentment'] as const);
const allContexts = Object.freeze([...chargeContexts, 'balance_transaction'] as const);
/** Stripe currencies#minor-units and #special-cases; Adaptive Pricing reporting establishes CAD presentment.
 * Exceptional charge facts deliberately establish no balance/payout unit. No ISO or default row exists.
 */
export const stripeMoneyFacts = Object.freeze([
  ...(['usd', 'eur'] as const).map((currency) => Object.freeze({ currency, contexts: allContexts, unit: scale2 })),
  Object.freeze({ currency: 'cad', contexts: Object.freeze(['checkout_presentment'] as const), unit: scale2 }),
  ...'bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'.split(' ').map((currency) =>
    Object.freeze({ currency, contexts: chargeContexts, unit: scale0 })),
  ...'isk ugx huf twd'.split(' ').map((currency) =>
    Object.freeze({ currency, contexts: chargeContexts, unit: scale2 })),
]);
export function readStripeMoneyUnit(currency: string, context: MoneyFieldContext): StripeMoneyUnit | null {
  return stripeMoneyFacts.find((row) => row.currency === currency && (row.contexts as readonly string[]).includes(context))?.unit ?? null;
}
function currencies(env: Readonly<Record<string, string | undefined>>, name: string): readonly ('usd' | 'eur')[] {
  const values = (env[name] ?? 'usd').split(',');
  if (values.length < 1 || values.length > 2 || new Set(values).size !== values.length ||
      values.some((value) => value !== 'usd' && value !== 'eur')) throw new TypeError(`Invalid ${name}: expected unique usd/eur currencies`);
  return values as ('usd' | 'eur')[];
}
/** Trusted declarations only. Provider approval, product eligibility and live settlement setup remain external. */
export function readCommerceMoneyPolicy(env: Readonly<Record<string, string | undefined>>): CommerceMoneyPolicy {
  const sale = currencies(env, 'COMMERCE_SALE_CURRENCIES');
  const settlement = currencies(env, 'COMMERCE_SETTLEMENT_CURRENCIES');
  for (const name of ['STRIPE_LIVEMODE', 'STRIPE_MANAGED_PAYMENTS'] as const) {
    if (env[name] !== undefined && env[name] !== 'true' && env[name] !== 'false') throw new TypeError(`Invalid ${name}`);
    if (sale.includes('eur') && env[name] === undefined) throw new TypeError(`Missing ${name} for configured EUR setup`);
  }
  if (sale.some((currency) => !settlement.includes(currency)))
    throw new TypeError('Invalid COMMERCE_SETTLEMENT_CURRENCIES: each sale currency requires declared settlement setup');
  return Object.freeze({
    taxBehavior: 'exclusive',
    configuredSaleCurrencies: Object.freeze(sale.map((currency): ConfiguredSaleCurrencyRule => Object.freeze({
      currency, unit: scale2, minAmountMinor: 50, maxAmountMinor: 99999999, chargeMultiple: 1,
    }))),
  });
}
export function validateOfferAmount(input: { currency: string; amountMinor: number }, policy: CommerceMoneyPolicy): Readonly<{
  moneyUnit: StripeMoneyUnit; taxBehavior: 'exclusive';
}> {
  const rule = policy.configuredSaleCurrencies.find((row) => row.currency === input.currency);
  if ((input.currency !== 'usd' && input.currency !== 'eur') || !rule || !Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 ||
      input.amountMinor < rule.minAmountMinor || input.amountMinor > rule.maxAmountMinor || input.amountMinor % rule.chargeMultiple !== 0)
    throw new RangeError('Invalid configured sale amount');
  return Object.freeze({ moneyUnit: scale2, taxBehavior: 'exclusive' });
}
