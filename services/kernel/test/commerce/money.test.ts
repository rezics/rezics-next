import { assertCheckoutEvidence } from '../../src/commerce/settlement.ts';
import { expect, test } from 'bun:test';
import {
  readCommerceMoneyPolicy,
  readStripeMoneyUnit,
  stripeMoneyFacts,
  validateOfferAmount,
} from '../../src/commerce/money.ts';

const usd = { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' } as const;

test('Native versioned money policy, captured price and explicit tax: raw boundaries and unknown currency', () => {
  const policy = readCommerceMoneyPolicy({});
  expect(policy).toEqual({
    taxBehavior: 'exclusive',
    configuredSaleCurrencies: [
      {
        currency: 'usd',
        unit: usd,
        minAmountMinor: 50,
        maxAmountMinor: 99999999,
        chargeMultiple: 1,
      },
    ],
  });
  for (const amountMinor of [50, 51, 99999999])
    expect(validateOfferAmount({ currency: 'usd', amountMinor }, policy)).toEqual({
      moneyUnit: usd,
      taxBehavior: 'exclusive',
    });
  for (const amountMinor of [0, -1, 49, 100000000, 50.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => validateOfferAmount({ currency: 'usd', amountMinor }, policy)).toThrow(RangeError);
  expect(() => validateOfferAmount({ currency: 'usd', amountMinor: 49 }, policy)).toThrow('below-minimum');
  expect(() => validateOfferAmount({ currency: 'usd', amountMinor: 100000000 }, policy)).toThrow('above-maximum');
  const steppedPolicy = {
    ...policy,
    configuredSaleCurrencies: policy.configuredSaleCurrencies.map((rule) => ({ ...rule, chargeMultiple: 5 })),
  };
  expect(() => validateOfferAmount({ currency: 'usd', amountMinor: 51 }, steppedPolicy)).toThrow('increment-mismatch');
  for (const currency of ['USD', 'eur', 'jpy', 'xxx', '__proto__', 'bhd'])
    expect(() => validateOfferAmount({ currency, amountMinor: 1200 }, policy)).toThrow(RangeError);
  expect(() => validateOfferAmount({ currency: 'jpy', amountMinor: 1200 }, policy)).toThrow('unsupported-currency');
});

test('context evidence has no fallback and never enables a sale; all fact rows are immutable', () => {
  expect(readStripeMoneyUnit('usd', 'balance_transaction')).toEqual(usd);
  expect(readStripeMoneyUnit('eur', 'integration_price')).toEqual(usd);
  expect(readStripeMoneyUnit('cad', 'checkout_presentment')).toEqual(usd);
  expect(readStripeMoneyUnit('cad', 'integration_price')).toBeNull();
  for (const currency of ['isk', 'ugx', 'huf', 'twd']) {
    expect(readStripeMoneyUnit(currency, 'integration_price')).toEqual(usd);
    expect(readStripeMoneyUnit(currency, 'balance_transaction')).toBeNull();
  }
  expect(readStripeMoneyUnit('mga', 'checkout_presentment')?.exponent).toBe(0);
  for (const currency of ['xxx', 'USD', 'bhd']) expect(readStripeMoneyUnit(currency, 'integration_price')).toBeNull();
  expect(Object.isFrozen(stripeMoneyFacts)).toBe(true);
  expect(
    stripeMoneyFacts.every((row) => Object.isFrozen(row) && Object.isFrozen(row.unit) && Object.isFrozen(row.contexts)),
  ).toBe(true);
});

test('EUR requires trusted settlement and explicit mode declarations without claiming live qualification', () => {
  const env = {
    COMMERCE_SALE_CURRENCIES: 'usd,eur',
    COMMERCE_SETTLEMENT_CURRENCIES: 'usd,eur',
    STRIPE_LIVEMODE: 'false',
    STRIPE_MANAGED_PAYMENTS: 'false',
  };
  const policy = readCommerceMoneyPolicy(env);
  expect(validateOfferAmount({ currency: 'eur', amountMinor: 50 }, policy)).toEqual({
    moneyUnit: usd,
    taxBehavior: 'exclusive',
  });
  expect(Object.isFrozen(policy)).toBe(true);
  expect(Object.isFrozen(policy.configuredSaleCurrencies)).toBe(true);
  expect(policy.configuredSaleCurrencies.every(Object.isFrozen)).toBe(true);
  for (const override of [
    { COMMERCE_SETTLEMENT_CURRENCIES: 'usd' },
    { STRIPE_LIVEMODE: undefined },
    { STRIPE_MANAGED_PAYMENTS: undefined },
    { STRIPE_MANAGED_PAYMENTS: 'TRUE' },
    ...['', 'USD', 'usd,usd', 'usd, eur', 'cad', 'usd,eur,usd'].map((COMMERCE_SALE_CURRENCIES) => ({
      COMMERCE_SALE_CURRENCIES,
    })),
  ])
    expect(() => readCommerceMoneyPolicy({ ...env, ...override })).toThrow();
});

test('a genuine paid total above the application base cap remains valid exact payment evidence', () => {
  expect(() =>
    assertCheckoutEvidence(
      {
        sessionId: 'cs_test_taxed',
        clientReferenceId: 'order',
        metadataOrderId: 'order',
        livemode: false,
        status: 'complete',
        paymentStatus: 'paid',
        currency: 'usd',
        amountSubtotalMinor: 99999999,
        amountTaxMinor: 10000000,
        amountTotalMinor: 109999999,
        paymentIntentId: 'pi_taxed',
        paymentIntentStatus: 'succeeded',
        chargeId: 'ch_taxed',
        chargeAmountMinor: 109999999,
        refunds: [],
        disputes: [],
        transactions: [],
        observedAt: '2026-10-31T00:00:00.000Z',
      },
      true,
    ),
  ).not.toThrow();
});
