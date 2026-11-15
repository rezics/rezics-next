# `@rezics/bounds`

`@rezics/bounds` holds finite dimensions for describing admitted work. A declaration maps every axis to one
non-negative safe integer. Values carry no dispatch authority. A returned declaration or boolean does not authorize
an API call or complete a business operation.

[Performance](../../docs/goals/performance.md#ownership) owns where a product path must declare work and what each
axis counts. This package checks completeness and composes the numbers.

## Import

`package.json` exports `"."` from `src/index.ts`. Import the public surface from `@rezics/bounds`:

```ts
import {
  BOUND_AXES,
  declareBound,
  isBound,
  repeatBound,
  sumBounds,
  withinCeiling,
  type Bound,
  type BoundAxis,
} from '@rezics/bounds';
```

No subpath is exported. The package lists no runtime dependencies, and `sideEffects` is `false`.

## Axes

`BOUND_AXES` is a frozen array of nine names, in this order:

`candidateKeys`, `nativeRows`, `identityMetadataRows`, `emptySeeks`, `nativePoints`, `witnessKeys`, `statements`,
`bytes`, `engineRequests`.

`BoundAxis` is the union of those strings. `Bound` is `Readonly<Record<BoundAxis, number>>`.

## Declaration

`declareBound(value: unknown): Bound` accepts one complete declaration and returns a new frozen object. The result
has exactly those nine own data properties, in `BOUND_AXES` order. The argument is left unchanged.

The argument must be a non-array object whose prototype is `Object.prototype` or `null`. Its own keys, including
non-enumerable keys, must be exactly the nine axis names. Each axis must be a data property holding a safe integer
from `0` through `Number.MAX_SAFE_INTEGER`. Inherited properties are ignored.

`declareBound` throws `TypeError`:

| Condition | Message |
| --- | --- |
| `null`, a non-object, an array, or any other prototype | `Invalid bound declaration` |
| Own keys are not exactly the nine axis names | `Invalid bound declaration axes` |
| An axis is an accessor, or its value is not a non-negative safe integer | `Invalid bound declaration value: <axis>` |

Values are checked in `BOUND_AXES` order, and the message names the first failing axis. The key set is checked
before any value.

`isBound(value: unknown): value is Bound` returns `true` when `declareBound` accepts the value. When `declareBound`
throws, `isBound` returns `false` and does not rethrow. It does not freeze the argument.

## Composition

`sumBounds(...parts: readonly Bound[]): Bound` validates each argument with `declareBound`, then adds axis by axis.
Arguments are taken in call order, and axes in `BOUND_AXES` order. Validation stops at the first invalid argument,
before any addition. The result is a new frozen declaration. No arguments yields zeros on every axis. A running
total that is not a safe integer throws `TypeError` with message `Bound declaration overflow`.

`repeatBound(bound: Bound, count: number): Bound` validates `bound` first. `count` must then be a non-negative safe
integer; otherwise it throws `TypeError` with message `Invalid bound multiplicity`. The result is `bound` composed
with itself `count` times through `sumBounds`. `count` of `0` still validates `bound` and returns the zero
declaration. A running total outside the safe-integer range throws `TypeError` (`Bound declaration overflow`).

## Ceiling

`withinCeiling(bound: Bound, ceiling: Bound): boolean` validates `bound` and then `ceiling` with `declareBound`. It
returns `true` when every axis of `bound` is less than or equal to the same axis of `ceiling`. Any greater axis
returns `false`. The boolean does not name the axis. An invalid argument throws the `declareBound` error. Equal
axes lie within the ceiling.

## Example

```ts
import { declareBound, repeatBound, sumBounds, withinCeiling } from '@rezics/bounds';

const page = declareBound({
  candidateKeys: 1,
  nativeRows: 2,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 1,
  witnessKeys: 1,
  statements: 2,
  bytes: 100,
  engineRequests: 1,
});

const combined = sumBounds(
  page,
  declareBound({
    candidateKeys: 3,
    nativeRows: 0,
    identityMetadataRows: 1,
    emptySeeks: 2,
    nativePoints: 0,
    witnessKeys: 1,
    statements: 1,
    bytes: 50,
    engineRequests: 0,
  }),
);

combined.statements; // 3
combined.bytes; // 150
repeatBound(page, 2).bytes; // 200
withinCeiling(page, combined); // true
withinCeiling(combined, page); // false
```
