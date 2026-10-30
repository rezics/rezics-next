import { describe, expect, test } from 'bun:test';
import { parseCreatorPrice } from '../src/checkout/creator-price';
import { formatMinorAmount } from '../src/checkout/money';
import { parseMoneySchema, recordedMoneyUnit } from '../src/checkout/money-schema';
import { configuredPriceExample, configuredUsdRule, recordedStripeUnit } from '../src/kernel/fake/creator-offers';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
describe('Actual creator offer editor plus exact recorded money display', () => {
  test('ASCII price intent scales exactly and rejects ambiguous or excessive precision without rounding', () => {
    for (const [input, raw] of [
      ['12.99', 1299],
      ['12.9', 1290],
      ['12', 1200],
      ['0.50', 50],
      ['999999.99', 99999999],
    ] as const)
      expect(parseCreatorPrice(input, configuredUsdRule)).toBe(raw);
    for (const input of [
      '',
      '0',
      '0.49',
      '1000000',
      '12.990',
      '0.500',
      ' 12.99',
      '12.99 ',
      '12.99\n',
      '+12.99',
      '-1',
      '01',
      '.50',
      '1.',
      '1e2',
      '1,299',
      '12,99',
      '１２.９９',
      '١٢.٩٩',
      '1_000',
      '9'.repeat(33),
      '9007199254740991',
    ])
      expect(() => parseCreatorPrice(input, configuredUsdRule)).toThrow(RangeError);
  });
  test('schema is closed configuration, not Intl recognition or an enable-all currency list', () => {
    expect(parseMoneySchema(configuredPriceExample)).toEqual(configuredPriceExample);
    expect(parseMoneySchema({ ...configuredPriceExample, qualified: true })).toBeNull();
    for (const currency of ['jpy', 'kwd', 'zzz'])
      expect(
        parseMoneySchema({ ...configuredPriceExample, configuredSaleCurrencies: [{ ...configuredUsdRule, currency }] }),
      ).toBeNull();
    expect(
      parseMoneySchema({ ...configuredPriceExample, configuredSaleCurrencies: [configuredUsdRule, configuredUsdRule] }),
    ).toBeNull();
    expect(parseMoneySchema({ ...configuredPriceExample, taxBehavior: 'inclusive' })).toBeNull();
    expect(
      parseMoneySchema({ ...configuredPriceExample, configuredSaleCurrencies: [{ ...configuredUsdRule, unit: null }] }),
    ).toBeNull();
  });
  test('recorded USD/EUR signed cents stay exact in every released locale, including the 70-cent correction', () => {
    for (const locale of locales)
      for (const currency of ['usd', 'eur']) {
        for (const [raw, major] of [
          [70, 0.7],
          [-70, -0.7],
          [-1, -0.01],
          [1299, 12.99],
          [0, 0],
        ] as const)
          expect(formatMinorAmount(locale, currency, raw, recordedStripeUnit)).toBe(
            new Intl.NumberFormat(locale, {
              style: 'currency',
              currency,
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(major),
          );
      }
    expect(formatMinorAmount('en', 'usd', Number.MAX_SAFE_INTEGER, recordedStripeUnit)).toBe('$90,071,992,547,409.91');
    expect(formatMinorAmount('en', 'eur', -Number.MAX_SAFE_INTEGER, recordedStripeUnit)).toBe(
      '-€90,071,992,547,409.91',
    );
  });
  test('recorded units override Intl digits, while absent historical metadata remains unknown', () => {
    expect(formatMinorAmount('en', 'mga', 500, { ...recordedStripeUnit, exponent: 0 })).toBe('MGA\u00a0500');
    expect(formatMinorAmount('en', 'isk', 500, recordedStripeUnit)).toBe('ISK\u00a05.00');
    expect(formatMinorAmount('en', 'usd', 70)).toBeNull();
    expect(recordedMoneyUnit({ currency: 'usd', unitAmountMinor: 70 })).toBeNull();
    expect(formatMinorAmount('en', 'zzz', 70, recordedStripeUnit)).toBeNull();
    expect(formatMinorAmount('en', 'kwd', 70, { ...recordedStripeUnit, exponent: 3 })).toBeNull();
    expect(formatMinorAmount('en', 'usd', Number.MAX_SAFE_INTEGER + 1, recordedStripeUnit)).toBeNull();
    expect(formatMinorAmount('en', 'usd', 70, { ...recordedStripeUnit, factsVersion: 'unproved' })).toBeNull();
  });
});
