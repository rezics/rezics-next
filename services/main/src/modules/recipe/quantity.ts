// Exact recipe quantities. The graph stores reduced non-negative rationals
// (recipe-structure-v1 rv:amountNumerator/rv:amountDenominator) beside the
// source lexical form; nothing is converted through floating point.

export const QUANTITY_BOUND = 1_000_000_000_000n;

export interface ExactRational { numerator: bigint; denominator: bigint }

export class InexactQuantity extends Error {}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

/** Reduce and bound one quantity; a stored quantity must already equal its reduced form. */
export function exactRational(numerator: bigint, denominator: bigint): ExactRational {
  if (numerator < 0n || denominator < 1n) throw new InexactQuantity('quantity must be non-negative');
  const divisor = numerator === 0n ? denominator : gcd(numerator, denominator);
  const reduced = { numerator: numerator / divisor, denominator: denominator / divisor };
  if (reduced.numerator > QUANTITY_BOUND || reduced.denominator > QUANTITY_BOUND) {
    throw new InexactQuantity('quantity exceeds the exact storage bound');
  }
  return reduced;
}

/** Scale by a declared exact factor; non-linear or non-scalable lines are not scaled here. */
export function scaleExact(quantity: ExactRational, factor: ExactRational): ExactRational {
  return exactRational(quantity.numerator * factor.numerator, quantity.denominator * factor.denominator);
}
