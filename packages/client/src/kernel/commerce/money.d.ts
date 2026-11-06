import { type RecordedMoneyUnit } from '@rezics/money';
/** Adopted Stripe field units; this evidence never admits a sale or qualifies an account. */
export type StripeMoneyUnit = RecordedMoneyUnit<'stripe-api', 0 | 2, 'stripe-money-v1'>;
export type MoneyFieldContext = 'integration_price' | 'checkout_integration' | 'checkout_presentment' | 'balance_transaction';
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
/** Stripe currencies#minor-units and #special-cases; Adaptive Pricing reporting establishes CAD presentment.
 * Exceptional charge facts deliberately establish no balance/payout unit. No ISO or default row exists.
 */
export declare const stripeMoneyFacts: readonly (Readonly<{
    currency: "eur" | "usd";
    contexts: readonly ["integration_price", "checkout_integration", "checkout_presentment", "balance_transaction"];
    unit: Readonly<{
        system: "stripe-api";
        exponent: 0 | 2;
        factsVersion: "stripe-money-v1";
    }>;
}> | Readonly<{
    currency: "cad";
    contexts: readonly ["checkout_presentment"];
    unit: Readonly<{
        system: "stripe-api";
        exponent: 0 | 2;
        factsVersion: "stripe-money-v1";
    }>;
}> | Readonly<{
    currency: string;
    contexts: readonly ["integration_price", "checkout_integration", "checkout_presentment"];
    unit: Readonly<{
        system: "stripe-api";
        exponent: 0 | 2;
        factsVersion: "stripe-money-v1";
    }>;
}>)[];
/** Recognized recorded descriptors are derived from field facts, never from the current currency alone. */
export declare const stripeRecordedMoneyUnits: readonly StripeMoneyUnit[];
export declare function readStripeMoneyUnit(currency: string, context: MoneyFieldContext): StripeMoneyUnit | null;
/** Trusted declarations only. Provider approval, product eligibility and live settlement setup remain external. */
export declare function readCommerceMoneyPolicy(env: Readonly<Record<string, string | undefined>>): CommerceMoneyPolicy;
export declare function validateOfferAmount(input: {
    currency: string;
    amountMinor: number;
}, policy: CommerceMoneyPolicy): Readonly<{
    moneyUnit: StripeMoneyUnit;
    taxBehavior: 'exclusive';
}>;
/** Persisted observation contexts, mapped to the canonical field-unit authority below. */
export type StripeMoneyContext = 'checkout.integration' | 'checkout.presentment' | 'balance_transaction';
export declare function stripeEvidenceMoneyUnit(currency: string, context: StripeMoneyContext): StripeMoneyUnit | null;
export declare function sameMoneyUnit(a: StripeMoneyUnit | null | undefined, b: StripeMoneyUnit | null | undefined): boolean;
/** Validates serialized recorded meaning; never fills missing historical metadata. */
export declare function recordedMoneyUnit(value: unknown): StripeMoneyUnit | null;
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
