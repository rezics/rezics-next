/** A recorded descriptor is evidence about stored values, not provider or currency policy. */
export type RecordedMoneyUnit<
  System extends string = string,
  Exponent extends number = number,
  FactsVersion extends string = string,
> = Readonly<{
  system: System;
  exponent: Exponent;
  factsVersion: FactsVersion;
}>;

export type UnknownMoneyUnitReason = 'missing' | 'malformed' | 'unsupported';
export type RecordedMoneyUnitReading =
  | Readonly<{ kind: 'known'; unit: RecordedMoneyUnit }>
  | Readonly<{ kind: 'unknown'; reason: UnknownMoneyUnitReason }>;

export type MoneyErrorCode =
  | 'malformed-decimal'
  | 'invalid-exponent'
  | 'unsafe-integer'
  | 'invalid-rule'
  | 'below-minimum'
  | 'above-maximum'
  | 'increment-mismatch'
  | 'unknown-unit'
  | 'incompatible-unit';

export type MoneyError = Readonly<{ code: MoneyErrorCode }>;
export type MoneyResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: MoneyError }>;
export type RecordedMoneyValue = Readonly<{
  amountMinor: number;
  unit: RecordedMoneyUnitReading;
}>;
export type MinorAmountRule = Readonly<{
  minimumMinor: number;
  maximumMinor: number;
  incrementMinor: number;
}>;
export type DecimalParts = Readonly<{
  negative: boolean;
  whole: bigint;
  fraction: bigint;
  exponent: number;
}>;

const unitKeys = Object.freeze(['system', 'exponent', 'factsVersion'] as const);
const exactRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const error = (code: MoneyErrorCode): MoneyResult<never> => ({ ok: false, error: Object.freeze({ code }) });

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isUnitDescriptor(value: unknown): value is RecordedMoneyUnit {
  if (!exactRecord(value) || !hasExactKeys(value, unitKeys)) return false;
  return (
    typeof value.system === 'string' &&
    /^[a-z][a-z0-9.-]{0,63}$/.test(value.system) &&
    typeof value.exponent === 'number' &&
    Number.isSafeInteger(value.exponent) &&
    value.exponent >= 0 &&
    value.exponent <= 18 &&
    typeof value.factsVersion === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.factsVersion)
  );
}

function unknown(reason: UnknownMoneyUnitReason): RecordedMoneyUnitReading {
  return Object.freeze({ kind: 'unknown', reason });
}

/** Decode a bare recorded unit. Callers supply the descriptors they can interpret. */
export function decodeRecordedMoneyUnit(
  value: unknown,
  supportedUnits: readonly RecordedMoneyUnit[],
): RecordedMoneyUnitReading {
  if (value === null || value === undefined) return unknown('missing');
  if (!isUnitDescriptor(value)) return unknown('malformed');
  if (!supportedUnits.some((unit) => sameMoneyUnit(unit, value))) return unknown('unsupported');
  return Object.freeze({
    kind: 'known',
    unit: Object.freeze({ system: value.system, exponent: value.exponent, factsVersion: value.factsVersion }),
  });
}

/** Decode the unit field of a larger response without accepting a bare unit as an envelope. */
export function decodeMoneyUnitEnvelope(
  value: unknown,
  supportedUnits: readonly RecordedMoneyUnit[],
): RecordedMoneyUnitReading {
  if (!exactRecord(value) || !Object.hasOwn(value, 'moneyUnit')) return unknown('missing');
  return decodeRecordedMoneyUnit(value.moneyUnit, supportedUnits);
}

/** A structurally valid descriptor match; adapters decode against their supported set first. */
export function sameMoneyUnit(a: unknown, b: unknown): boolean {
  return (
    isUnitDescriptor(a) &&
    isUnitDescriptor(b) &&
    a.system === b.system &&
    a.exponent === b.exponent &&
    a.factsVersion === b.factsVersion
  );
}

export function isSafeMinorAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/** Parse an ASCII decimal to minor units without floating point or rounding. */
export function parseDecimalAmount(text: unknown, exponent: number): MoneyResult<number> {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 18) return error('invalid-exponent');
  if (typeof text !== 'string' || text.length > 32) return error('malformed-decimal');
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(text);
  if (!match || match[0] !== text || (match[2]?.length ?? 0) > exponent) return error('malformed-decimal');
  const scale = 10n ** BigInt(exponent);
  const whole = BigInt(match[1]!);
  const fractional = BigInt((match[2] ?? '').padEnd(exponent, '0') || '0');
  const minor = whole * scale + fractional;
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return error('unsafe-integer');
  return Object.freeze({ ok: true, value: Number(minor) });
}

/** Validate a safe integer against one explicitly supplied policy rule. */
export function validateMinorAmount(amountMinor: unknown, rule: MinorAmountRule): MoneyResult<number> {
  if (
    !isSafeMinorAmount(rule.minimumMinor) ||
    !isSafeMinorAmount(rule.maximumMinor) ||
    !isSafeMinorAmount(rule.incrementMinor) ||
    rule.minimumMinor < 0 ||
    rule.maximumMinor < rule.minimumMinor ||
    rule.incrementMinor < 1
  )
    return error('invalid-rule');
  if (!isSafeMinorAmount(amountMinor)) return error('unsafe-integer');
  if (amountMinor < rule.minimumMinor) return error('below-minimum');
  if (amountMinor > rule.maximumMinor) return error('above-maximum');
  if (BigInt(amountMinor) % BigInt(rule.incrementMinor) !== 0n) return error('increment-mismatch');
  return Object.freeze({ ok: true, value: amountMinor });
}

/** Split an exact signed minor-unit integer for presentation; Intl remains an adapter concern. */
export function decimalParts(amountMinor: unknown, exponent: number): MoneyResult<DecimalParts> {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 18) return error('invalid-exponent');
  if (!isSafeMinorAmount(amountMinor)) return error('unsafe-integer');
  const amount = BigInt(amountMinor);
  const absolute = amount < 0n ? -amount : amount;
  const scale = 10n ** BigInt(exponent);
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      negative: amount < 0n,
      whole: absolute / scale,
      fraction: absolute % scale,
      exponent,
    }),
  });
}

type KnownRecordedMoneyValue = Readonly<{
  amountMinor: number;
  unit: Extract<RecordedMoneyUnitReading, { kind: 'known' }>;
}>;

function knownValue(value: RecordedMoneyValue): MoneyResult<KnownRecordedMoneyValue> {
  const unit = value.unit;
  if (unit.kind !== 'known') return error('unknown-unit');
  if (!isUnitDescriptor(unit.unit)) return error('unknown-unit');
  if (!isSafeMinorAmount(value.amountMinor)) return error('unsafe-integer');
  return Object.freeze({
    ok: true,
    value: Object.freeze({ amountMinor: value.amountMinor, unit }),
  });
}

function compatiblePair(
  left: RecordedMoneyValue,
  right: RecordedMoneyValue,
): MoneyResult<Readonly<{ left: KnownRecordedMoneyValue; right: KnownRecordedMoneyValue }>> {
  const a = knownValue(left);
  if (!a.ok) return a;
  const b = knownValue(right);
  if (!b.ok) return b;
  if (!sameMoneyUnit(a.value.unit.unit, b.value.unit.unit)) return error('incompatible-unit');
  return Object.freeze({ ok: true, value: Object.freeze({ left: a.value, right: b.value }) });
}

function arithmetic(
  left: RecordedMoneyValue,
  right: RecordedMoneyValue,
  subtract: boolean,
): MoneyResult<RecordedMoneyValue> {
  const pair = compatiblePair(left, right);
  if (!pair.ok) return pair;
  const a = BigInt(pair.value.left.amountMinor);
  const b = BigInt(pair.value.right.amountMinor);
  const result = subtract ? a - b : a + b;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER))
    return error('unsafe-integer');
  return Object.freeze({
    ok: true,
    value: Object.freeze({ amountMinor: Number(result), unit: pair.value.left.unit }),
  });
}

export function addRecordedMoney(left: RecordedMoneyValue, right: RecordedMoneyValue): MoneyResult<RecordedMoneyValue> {
  return arithmetic(left, right, false);
}

export function subtractRecordedMoney(
  left: RecordedMoneyValue,
  right: RecordedMoneyValue,
): MoneyResult<RecordedMoneyValue> {
  return arithmetic(left, right, true);
}

export function compareRecordedMoney(left: RecordedMoneyValue, right: RecordedMoneyValue): MoneyResult<-1 | 0 | 1> {
  const pair = compatiblePair(left, right);
  if (!pair.ok) return pair;
  const a = pair.value.left.amountMinor;
  const b = pair.value.right.amountMinor;
  return Object.freeze({ ok: true, value: a < b ? -1 : a > b ? 1 : 0 });
}
