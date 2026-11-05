import {
  decodeRecordedMoneyUnit,
  sameMoneyUnit as equalRecordedMoneyUnits,
  validateMinorAmount,
  type RecordedMoneyUnit,
} from '@rezics/money';

/** Adopted Stripe field units; this evidence never admits a sale or qualifies an account. */
export type StripeMoneyUnit = RecordedMoneyUnit<'stripe-api', 0 | 2, 'stripe-money-v1'>;
export type MoneyFieldContext =
  | 'integration_price'
  | 'checkout_integration'
  | 'checkout_presentment'
  | 'balance_transaction';
export type ConfiguredSaleCurrencyRule = Readonly<{
  currency: 'usd' | 'eur';
  unit: StripeMoneyUnit;
  minAmountMinor: number;
  maxAmountMinor: number;
  chargeMultiple: number;
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
  ...'bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'
    .split(' ')
    .map((currency) => Object.freeze({ currency, contexts: chargeContexts, unit: scale0 })),
  ...'isk ugx huf twd'
    .split(' ')
    .map((currency) => Object.freeze({ currency, contexts: chargeContexts, unit: scale2 })),
]);
/** Recognized recorded descriptors are derived from field facts, never from the current currency alone. */
export const stripeRecordedMoneyUnits: readonly StripeMoneyUnit[] = Object.freeze(
  Array.from(
    new Map(
      stripeMoneyFacts.map(({ unit }) => [`${unit.system}:${unit.exponent}:${unit.factsVersion}`, unit] as const),
    ).values(),
  ),
);
export function readStripeMoneyUnit(currency: string, context: MoneyFieldContext): StripeMoneyUnit | null {
  return (
    stripeMoneyFacts.find((row) => row.currency === currency && (row.contexts as readonly string[]).includes(context))
      ?.unit ?? null
  );
}
function currencies(env: Readonly<Record<string, string | undefined>>, name: string): readonly ('usd' | 'eur')[] {
  const values = (env[name] ?? 'usd').split(',');
  if (
    values.length < 1 ||
    values.length > 2 ||
    new Set(values).size !== values.length ||
    values.some((value) => value !== 'usd' && value !== 'eur')
  )
    throw new TypeError(`Invalid ${name}: expected unique usd/eur currencies`);
  return values as ('usd' | 'eur')[];
}
/** Trusted declarations only. Provider approval, product eligibility and live settlement setup remain external. */
export function readCommerceMoneyPolicy(env: Readonly<Record<string, string | undefined>>): CommerceMoneyPolicy {
  const sale = currencies(env, 'COMMERCE_SALE_CURRENCIES');
  const settlement = currencies(env, 'COMMERCE_SETTLEMENT_CURRENCIES');
  for (const name of ['STRIPE_LIVEMODE', 'STRIPE_MANAGED_PAYMENTS'] as const) {
    if (env[name] !== undefined && env[name] !== 'true' && env[name] !== 'false')
      throw new TypeError(`Invalid ${name}`);
    if (sale.includes('eur') && env[name] === undefined)
      throw new TypeError(`Missing ${name} for configured EUR setup`);
  }
  if (sale.some((currency) => !settlement.includes(currency)))
    throw new TypeError(
      'Invalid COMMERCE_SETTLEMENT_CURRENCIES: each sale currency requires declared settlement setup',
    );
  return Object.freeze({
    taxBehavior: 'exclusive',
    configuredSaleCurrencies: Object.freeze(
      sale.map((currency): ConfiguredSaleCurrencyRule =>
        Object.freeze({
          currency,
          unit: scale2,
          minAmountMinor: 50,
          maxAmountMinor: 99999999,
          chargeMultiple: 1,
        }),
      ),
    ),
  });
}
export function validateOfferAmount(
  input: { currency: string; amountMinor: number },
  policy: CommerceMoneyPolicy,
): Readonly<{
  moneyUnit: StripeMoneyUnit;
  taxBehavior: 'exclusive';
}> {
  const rule = policy.configuredSaleCurrencies.find((row) => row.currency === input.currency);
  if ((input.currency !== 'usd' && input.currency !== 'eur') || !rule)
    throw new RangeError('unsupported-currency');
  const amount = validateMinorAmount(input.amountMinor, {
    minimumMinor: rule.minAmountMinor,
    maximumMinor: rule.maxAmountMinor,
    incrementMinor: rule.chargeMultiple,
  });
  if (!amount.ok) throw new RangeError(amount.error.code);
  return Object.freeze({ moneyUnit: scale2, taxBehavior: 'exclusive' });
}

/** Persisted observation contexts, mapped to the canonical field-unit authority below. */
export type StripeMoneyContext = 'checkout.integration' | 'checkout.presentment' | 'balance_transaction';
const evidenceFieldContexts: Readonly<Record<StripeMoneyContext, MoneyFieldContext>> = Object.freeze({
  'checkout.integration': 'checkout_integration',
  'checkout.presentment': 'checkout_presentment',
  balance_transaction: 'balance_transaction',
});
export function stripeEvidenceMoneyUnit(currency: string, context: StripeMoneyContext): StripeMoneyUnit | null {
  return readStripeMoneyUnit(currency, evidenceFieldContexts[context]);
}

export function sameMoneyUnit(a: StripeMoneyUnit | null | undefined, b: StripeMoneyUnit | null | undefined): boolean {
  return !!a && !!b && equalRecordedMoneyUnits(a, b);
}

/** Validates serialized recorded meaning; never fills missing historical metadata. */
export function recordedMoneyUnit(value: unknown): StripeMoneyUnit | null {
  const reading = decodeRecordedMoneyUnit(value, stripeRecordedMoneyUnits);
  return reading.kind === 'known' ? (reading.unit as StripeMoneyUnit) : null;
}

/** Lineage of the actual API operation, excluding credentials, tokens and provider bodies. */
export type StripeMoneyProvenance = Readonly<{
  accountNamespace: string;
  livemode: boolean;
  objectId: string;
  object: 'checkout.session' | 'balance_transaction';
  context: StripeMoneyContext;
  requestApiVersion: string;
  responseApiVersion: string | null;
}>;
