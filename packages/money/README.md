# `@rezics/money`

Helpers for recorded money values: unit descriptors, exact minor-unit decimals, one caller-supplied amount rule, and addition, subtraction and comparison of two recorded values.

A `RecordedMoneyUnit` records stored `system`, `exponent` and `factsVersion` fields. Callers supply every descriptor they can interpret and every numeric rule. Provider, currency, tax, settlement and receipt policy stay in the [Commerce owner](../../docs/commerce.md#recorded-money-presentation). A `MoneyResult` or a `known` reading is the helper's local outcome. It does not authorize an API call or complete a charge, refund or other business operation.

The only public import path is `@rezics/money`.

## Units

```ts
decodeRecordedMoneyUnit(value: unknown, supportedUnits: readonly RecordedMoneyUnit[]): RecordedMoneyUnitReading
decodeMoneyUnitEnvelope(value: unknown, supportedUnits: readonly RecordedMoneyUnit[]): RecordedMoneyUnitReading
sameMoneyUnit(a: unknown, b: unknown): boolean
```

`RecordedMoneyUnit` has exactly `system`, `exponent` and `factsVersion`. Its type parameters default to `string`, `number` and `string`. `decodeRecordedMoneyUnit` reads a bare descriptor. `decodeMoneyUnitEnvelope` reads the own `moneyUnit` field of a non-array object and ignores that object's other fields, then uses the same rules. A bare descriptor has no `moneyUnit` field, so the envelope decoder returns `missing`.

| Reading | When |
| --- | --- |
| `{ kind: 'known', unit }` | The descriptor matches the bounds below and `sameMoneyUnit` finds it in `supportedUnits`. `unit` is a frozen copy of the three fields. |
| `{ kind: 'unknown', reason: 'missing' }` | Bare `null` or `undefined`. An envelope that is not a non-array object, lacks an own `moneyUnit`, or has `moneyUnit` of `null` or `undefined`. |
| `{ kind: 'unknown', reason: 'malformed' }` | Any other bare value that fails the descriptor bounds, including an extra field. The envelope returns this when `moneyUnit` itself is malformed. |
| `{ kind: 'unknown', reason: 'unsupported' }` | A valid descriptor that matches nothing in `supportedUnits`. |

`sameMoneyUnit` is field equality of two values that each pass the descriptor bounds. `UnknownMoneyUnitReason` is `missing`, `malformed` or `unsupported`. Those readings stay on `RecordedMoneyUnitReading`.

Descriptor bounds:

- `system` matches `^[a-z][a-z0-9.-]{0,63}$`.
- `exponent` is a safe integer from 0 through 18.
- `factsVersion` matches `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`.

## Amounts

```ts
isSafeMinorAmount(value: unknown): value is number
parseDecimalAmount(text: unknown, exponent: number): MoneyResult<number>
validateMinorAmount(amountMinor: unknown, rule: MinorAmountRule): MoneyResult<number>
decimalParts(amountMinor: unknown, exponent: number): MoneyResult<DecimalParts>
```

`isSafeMinorAmount` is true for a safe integer, including zero and negatives.

`parseDecimalAmount` converts an ASCII decimal to a non-negative minor integer with integer arithmetic. It checks `exponent` first: a safe integer from 0 through 18. `text` must then be a string of at most 32 characters matching `^(0|[1-9][0-9]*)(?:\.([0-9]+))?$`, with no more fractional digits than `exponent`. A shorter fraction is padded with zeros. The minor value is `whole * 10^exponent + fraction`. A result above `Number.MAX_SAFE_INTEGER` is `unsafe-integer`.

`MinorAmountRule` is `{ minimumMinor, maximumMinor, incrementMinor }`. All three must be safe integers, `minimumMinor >= 0`, `maximumMinor >= minimumMinor`, and `incrementMinor >= 1`. The amount must then be a safe integer in that inclusive range and an exact multiple of `incrementMinor`.

`decimalParts` splits one signed safe minor integer. It checks `exponent` before the amount, on the same 0..18 domain. `DecimalParts` is `{ negative, whole, fraction, exponent }`; `whole` and `fraction` are `bigint`, and `fraction` is `abs(amountMinor) % 10^exponent`. Locale formatting, including `Intl`, stays with the caller.

## Arithmetic

```ts
addRecordedMoney(left: RecordedMoneyValue, right: RecordedMoneyValue): MoneyResult<RecordedMoneyValue>
subtractRecordedMoney(left: RecordedMoneyValue, right: RecordedMoneyValue): MoneyResult<RecordedMoneyValue>
compareRecordedMoney(left: RecordedMoneyValue, right: RecordedMoneyValue): MoneyResult<-1 | 0 | 1>
```

`RecordedMoneyValue` is `{ amountMinor: number, unit: RecordedMoneyUnitReading }`. For each side, in left-then-right order, the reading must be `kind: 'known'`, its descriptor must still pass the bounds above, and `amountMinor` must be a safe integer. The descriptors must then be equal. Addition and subtraction return the left reading with the new minor integer. Subtraction may be negative. The result must stay inside the safe-integer range. Comparison returns `-1`, `0` or `1`.

## Errors and bounds

`MoneyResult<T>` is `{ ok: true, value: T }` or `{ ok: false, error: MoneyError }`. `MoneyError` is `{ code: MoneyErrorCode }` only.

| Code | When |
| --- | --- |
| `invalid-exponent` | Exponent is outside the safe integer range 0..18. |
| `malformed-decimal` | Decimal text misses the length or grammar above. |
| `invalid-rule` | A rule field breaks the minimum, maximum or increment bounds. Checked before the amount. |
| `unsafe-integer` | An amount is not a safe integer; a parsed minor is above `Number.MAX_SAFE_INTEGER`; a sum or difference leaves the safe-integer range. |
| `below-minimum` | Amount is under `minimumMinor`. |
| `above-maximum` | Amount is over `maximumMinor`. |
| `increment-mismatch` | Amount is not a multiple of `incrementMinor`. |
| `unknown-unit` | A side used by arithmetic or comparison is not a known, still-valid descriptor. |
| `incompatible-unit` | Both sides are usable and their descriptors differ. |

`validateMinorAmount` reports `invalid-rule`, then `unsafe-integer`, `below-minimum`, `above-maximum`, then `increment-mismatch`.

Successful results, decoded readings and `{ code }` objects are frozen. Decode scans `supportedUnits` until it finds a match; the caller chooses that array's length. Each call only reads its arguments and returns a value.

## Examples

The descriptor strings are arguments from the caller. This package has no built-in currency list.

```ts
import { decimalParts, parseDecimalAmount, validateMinorAmount } from '@rezics/money';

parseDecimalAmount('12.09', 2);
// { ok: true, value: 1209 }

parseDecimalAmount('12.0', 0);
// { ok: false, error: { code: 'malformed-decimal' } }

validateMinorAmount(50, { minimumMinor: 50, maximumMinor: 100, incrementMinor: 5 });
// { ok: true, value: 50 }

decimalParts(-1, 2);
// { ok: true, value: { negative: true, whole: 0n, fraction: 1n, exponent: 2 } }
```

```ts
import { addRecordedMoney, decodeMoneyUnitEnvelope, type RecordedMoneyUnit } from '@rezics/money';

const unit: RecordedMoneyUnit = {
  system: 'stripe-api',
  exponent: 2,
  factsVersion: 'stripe-money-v1',
};
const reading = decodeMoneyUnitEnvelope({ moneyUnit: unit }, [unit]);
// { kind: 'known', unit: { system: 'stripe-api', exponent: 2, factsVersion: 'stripe-money-v1' } }

if (reading.kind === 'known') {
  addRecordedMoney({ amountMinor: 70, unit: reading }, { amountMinor: 19, unit: reading });
  // { ok: true, value: { amountMinor: 89, unit: reading } }
}
```
