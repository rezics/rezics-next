import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { parseCreatorPrice, validateCreatorPrice } from '../src/checkout/creator-price';
import { formatMinorAmount } from '../src/checkout/money';
import { parseMoneySchema, recordedMoneyUnit } from '../src/checkout/money-schema';
import { configuredPriceExample, configuredUsdRule, recordedStripeUnit } from '../src/kernel/fake/creator-offers';

const locales = ['en', 'de', 'fr', 'es', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
describe('Actual creator offer editor plus exact recorded money display', () => {
  test('price intent and actual routes keep separate canonical stories with shared width, locale and theme globals', async () => {
    const story = await readFile(new URL('../src/stories/creator-offer-editor.stories.tsx', import.meta.url), 'utf8');
    expect([...story.matchAll(/export const (\w+): Story/g)].map((match) => match[1])).toEqual([
      'PriceIntent',
      'ActualRoute',
      'ActualOwnedOffers',
    ]);
    expect(story).toContain('play: priceIntent');
    expect(story).toContain('play: pageReady');
    expect(story).not.toMatch(/viewport|maxWidth/);
    const preview = await readFile(new URL('../.storybook/preview.tsx', import.meta.url), 'utf8');
    expect(preview).toContain("phone390: { name: 'Phone 390', styles: { width: '390px'");
    expect(preview).toContain("desktop1280: { name: 'Desktop 1280', styles: { width: '1280px'");
    expect(preview).toContain("['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']");
    expect(preview).toContain("items: ['light', 'dark']");
  });
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
  test('price feedback distinguishes malformed input, currency policy, bounds and increments', () => {
    expect(validateCreatorPrice('12.990', configuredUsdRule)).toEqual({ kind: 'invalid', issue: 'malformed-decimal' });
    expect(validateCreatorPrice('12.99')).toEqual({ kind: 'invalid', issue: 'unsupported-currency' });
    expect(validateCreatorPrice('12.99', { ...configuredUsdRule, chargeMultiple: 0 })).toEqual({
      kind: 'invalid',
      issue: 'policy-unavailable',
    });
    expect(validateCreatorPrice('0.49', configuredUsdRule)).toEqual({ kind: 'invalid', issue: 'minimum' });
    expect(validateCreatorPrice('1000000', configuredUsdRule)).toEqual({ kind: 'invalid', issue: 'maximum' });
    const stepped = { ...configuredUsdRule, chargeMultiple: 5 };
    expect(validateCreatorPrice('12.99', stepped)).toEqual({ kind: 'invalid', issue: 'increment' });
    expect(validateCreatorPrice('13.00', stepped)).toEqual({ kind: 'valid', amountMinor: 1300 });
  });
  test('schema is closed configuration, not Intl recognition or an enable-all currency list', () => {
    expect(parseMoneySchema(configuredPriceExample)).toEqual(configuredPriceExample);
    expect(
      parseMoneySchema({
        ...configuredPriceExample,
        configuredSaleCurrencies: [
          { ...configuredUsdRule, minAmountMinor: 100, maxAmountMinor: 250000, chargeMultiple: 5 },
        ],
      }),
    ).not.toBeNull();
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
          expect(formatMinorAmount(locale, currency, raw, recordedStripeUnit)).toContain(
            new Intl.NumberFormat(locale, {
              style: 'currency',
              currency,
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(major),
          );
        for (const [currency, raw] of [
          ['usd', 1299],
          ['eur', 1299],
          ['usd', 0],
        ] as const)
          expect(formatMinorAmount(locale, currency, raw, recordedStripeUnit)).toContain(
            `${raw} ${currency.toUpperCase()} minor units (exponent 2)`,
          );
      }
    expect(formatMinorAmount('en', 'usd', Number.MAX_SAFE_INTEGER, recordedStripeUnit)).toContain(
      '$90,071,992,547,409.91',
    );
    expect(formatMinorAmount('en', 'eur', -Number.MAX_SAFE_INTEGER, recordedStripeUnit)).toContain(
      '-€90,071,992,547,409.91',
    );
  });
  test('numeric negative zero displays as zero while a real negative cent keeps its sign in every released locale', () => {
    for (const locale of locales)
      for (const currency of ['usd', 'eur']) {
        const formatter = new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        expect(formatMinorAmount(locale, currency, -0, recordedStripeUnit)).toContain(formatter.format(0));
        expect(formatMinorAmount(locale, currency, -1, recordedStripeUnit)).toContain(formatter.format(-0.01));
      }
  });
  test('recorded values keep zero exponents, signed adjustments and raw unknown units intelligible', () => {
    expect(formatMinorAmount('en', 'mga', 500, { ...recordedStripeUnit, exponent: 0 })).toContain('MGA\u00a0500');
    expect(formatMinorAmount('en', 'mga', 500, { ...recordedStripeUnit, exponent: 0 })).toContain(
      '500 MGA minor units (exponent 0)',
    );
    expect(formatMinorAmount('en', 'isk', 500, recordedStripeUnit)).toContain('ISK\u00a05.00');
    expect(formatMinorAmount('en', 'isk', 500, recordedStripeUnit)).toContain('500 ISK minor units (exponent 2)');
    expect(formatMinorAmount('en', 'usd', 70)).toBe('Recorded amount 70 USD; unit meaning is unknown.');
    expect(formatMinorAmount('en', 'usd', -70)).toBe('Recorded amount -70 USD; unit meaning is unknown.');
    expect(recordedMoneyUnit({ currency: 'usd', unitAmountMinor: 70 })).toBeNull();
    expect(formatMinorAmount('en', 'zzz', 70, recordedStripeUnit)).toBe('Recorded 70 minor units of ZZZ (exponent 2).');
    expect(formatMinorAmount('en', 'kwd', 70, { ...recordedStripeUnit, exponent: 3 })).toBe(
      'Recorded amount 70 KWD; unit meaning is unknown.',
    );
    expect(formatMinorAmount('en', 'usd', Number.MAX_SAFE_INTEGER + 1, recordedStripeUnit)).toBeNull();
    expect(formatMinorAmount('en', 'usd', 70, { ...recordedStripeUnit, factsVersion: 'unproved' })).toBe(
      'Recorded amount 70 USD; unit meaning is unknown.',
    );
  });
});
