export type StripeMoneyUnit = Readonly<{ system: 'stripe-api'; exponent: 0 | 2; factsVersion: 'stripe-money-v1' }>;
export type MoneyFieldContext = 'integration_price' | 'checkout_integration' | 'checkout_presentment' | 'balance_transaction';
export type ConfiguredSaleCurrencyRule = Readonly<{
    currency: 'usd' | 'eur'; unit: StripeMoneyUnit; minAmountMinor: 50; maxAmountMinor: 99999999; chargeMultiple: 1;
}>;
export type CommerceMoneyPolicy = Readonly<{ configuredSaleCurrencies: readonly ConfiguredSaleCurrencyRule[]; taxBehavior: 'exclusive' }>;
export declare const stripeMoneyFacts: readonly Readonly<{ currency: string; contexts: readonly MoneyFieldContext[]; unit: StripeMoneyUnit }>[];
export declare function readStripeMoneyUnit(currency: string, context: MoneyFieldContext): StripeMoneyUnit | null;
export declare function readCommerceMoneyPolicy(env: Readonly<Record<string, string | undefined>>): CommerceMoneyPolicy;
export declare function validateOfferAmount(input: { currency: string; amountMinor: number }, policy: CommerceMoneyPolicy): Readonly<{ moneyUnit: StripeMoneyUnit; taxBehavior: 'exclusive' }>;
