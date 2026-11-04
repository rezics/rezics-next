import { describe, expect, test } from 'bun:test';
import {
  addRecordedMoney,
  compareRecordedMoney,
  decodeMoneyUnitEnvelope,
  decodeRecordedMoneyUnit,
  decimalParts,
  parseDecimalAmount,
  sameMoneyUnit,
  subtractRecordedMoney,
  validateMinorAmount,
  type RecordedMoneyUnit,
  type RecordedMoneyValue,
} from '../src/index.ts';

const zeroExponent: RecordedMoneyUnit<'stripe-api', 0, 'stripe-money-v1'> = {
  system: 'stripe-api',
  exponent: 0,
  factsVersion: 'stripe-money-v1',
};
const twoExponent: RecordedMoneyUnit<'stripe-api', 2, 'stripe-money-v1'> = {
  system: 'stripe-api',
  exponent: 2,
  factsVersion: 'stripe-money-v1',
};
const supported = [zeroExponent, twoExponent] as const;
const value = (amountMinor: number, unit: RecordedMoneyUnit): RecordedMoneyValue => ({
  amountMinor,
  unit: { kind: 'known', unit },
});

describe('recorded money values', () => {
  test('bare and envelope unit decoding is closed and keeps historical meaning unknown', () => {
    expect(decodeRecordedMoneyUnit(twoExponent, supported)).toEqual({ kind: 'known', unit: twoExponent });
    expect(decodeMoneyUnitEnvelope({ moneyUnit: twoExponent }, supported)).toEqual({
      kind: 'known',
      unit: twoExponent,
    });
    expect(decodeMoneyUnitEnvelope(twoExponent, supported)).toEqual({ kind: 'unknown', reason: 'missing' });
    expect(decodeRecordedMoneyUnit({ ...twoExponent, currency: 'usd' }, supported)).toEqual({
      kind: 'unknown',
      reason: 'malformed',
    });
    expect(decodeRecordedMoneyUnit(undefined, supported)).toEqual({ kind: 'unknown', reason: 'missing' });
    expect(
      decodeRecordedMoneyUnit({ ...twoExponent, factsVersion: 'stripe-money-v2' }, supported),
    ).toEqual({ kind: 'unknown', reason: 'unsupported' });
  });

  test('compatible values use exact signed arithmetic and reject unknown or incompatible units', () => {
    const cents = value(70, twoExponent);
    const next = value(19, twoExponent);
    const sum = addRecordedMoney(cents, next);
    expect(sum.ok && sum.value.amountMinor).toBe(89);
    expect(compareRecordedMoney(cents, next)).toEqual({ ok: true, value: 1 });
    const adjustment = subtractRecordedMoney(value(1, twoExponent), value(2, twoExponent));
    expect(adjustment.ok && adjustment.value.amountMinor).toBe(-1);
    expect(sameMoneyUnit(twoExponent, zeroExponent)).toBe(false);
    expect(addRecordedMoney(cents, value(1, zeroExponent))).toEqual({
      ok: false,
      error: { code: 'incompatible-unit' },
    });
    expect(
      compareRecordedMoney(cents, { amountMinor: 1, unit: { kind: 'unknown', reason: 'missing' } }),
    ).toEqual({ ok: false, error: { code: 'unknown-unit' } });
  });

  test('decimal input, range, increment, zero exponent and signed display parts stay exact', () => {
    expect(parseDecimalAmount('12.09', 2)).toEqual({ ok: true, value: 1209 });
    expect(parseDecimalAmount('12', 0)).toEqual({ ok: true, value: 12 });
    expect(parseDecimalAmount('12.0', 0)).toEqual({ ok: false, error: { code: 'malformed-decimal' } });
    expect(parseDecimalAmount('90071992547410', 2)).toEqual({ ok: false, error: { code: 'unsafe-integer' } });
    expect(validateMinorAmount(40, { minimumMinor: 50, maximumMinor: 100, incrementMinor: 5 })).toEqual({
      ok: false,
      error: { code: 'below-minimum' },
    });
    expect(validateMinorAmount(60, { minimumMinor: 50, maximumMinor: 100, incrementMinor: 7 })).toEqual({
      ok: false,
      error: { code: 'increment-mismatch' },
    });
    expect(validateMinorAmount(101, { minimumMinor: 50, maximumMinor: 100, incrementMinor: 1 })).toEqual({
      ok: false,
      error: { code: 'above-maximum' },
    });
    expect(decimalParts(1200, 0)).toEqual({ ok: true, value: { negative: false, whole: 1200n, fraction: 0n, exponent: 0 } });
    expect(decimalParts(-1, 2)).toEqual({ ok: true, value: { negative: true, whole: 0n, fraction: 1n, exponent: 2 } });
  });
});
