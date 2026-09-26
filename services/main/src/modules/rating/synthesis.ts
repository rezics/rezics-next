/** Named cross-context synthesis. Components stay separate: raters are never pooled,
 * counts are never summed, and a missing side never falls back to the other. */
export const REALM_GLOBAL_SYNTHESIS_PROFILE = 'realm-global-standing-synthesis-v1';
export const REALM_GLOBAL_SYNTHESIS_POLICY = {
  normalization: 'scale-min-max-unit-interval', weighting: 'equal-context', raterPooling: 'none',
} as const;

interface Fraction { n: bigint; d: bigint }
function fraction(n: bigint, d = 1n): Fraction {
  if (d <= 0n || n < 0n) throw new RangeError('rating fractions are nonnegative with positive denominators');
  let a = n, b = d;
  while (b) [a, b] = [b, a % b];
  return a === 0n ? { n: 0n, d: 1n } : { n: n / a, d: d / a };
}
const encoded = (value: Fraction) => ({ numerator: String(value.n), denominator: String(value.d) });

export interface RatingScale { min: number; max: number }

/** Latest effective values of one standing Context: one per slot, null when withdrawn. */
export function reduceStandingComponent(values: readonly (number | null)[], scale: RatingScale) {
  const histogram = Array.from({ length: scale.max - scale.min + 1 }, () => 0);
  let sum = 0, count = 0;
  for (const value of values) {
    if (value === null) continue;
    if (!Number.isInteger(value) || value < scale.min || value > scale.max) {
      throw new RangeError('rating value lies outside its own scale');
    }
    histogram[value - scale.min] = histogram[value - scale.min]! + 1;
    sum += value; count++;
  }
  const mean = count ? fraction(BigInt(sum), BigInt(count)) : null;
  // (mean − min) / (max − min), computed on the exact sum.
  const unit = count ? fraction(BigInt(sum - scale.min * count), BigInt(count * (scale.max - scale.min))) : null;
  return {
    scale: { min: scale.min, max: scale.max, step: 1 as const },
    population: values.length, count, withdrawnCount: values.length - count, histogram, sum,
    mean: mean ? Number(mean.n) / Number(mean.d) : null,
    precision: mean ? { kind: 'exact-rational' as const, ...encoded(mean) } : { kind: 'no-data' as const },
    unitMean: unit ? encoded(unit) : null,
  };
}

export type StandingComponent = ReturnType<typeof reduceStandingComponent>;

/** Equal Context weight over each component's unit-interval mean. */
export function synthesizeRealmGlobal(realm: StandingComponent, global: StandingComponent) {
  const missing = [...(realm.unitMean ? [] : ['realm' as const]), ...(global.unitMean ? [] : ['global' as const])];
  if (missing.length) return { status: 'partial' as const, missing, value: null, numericValue: null };
  const a = fraction(BigInt(realm.unitMean!.numerator), BigInt(realm.unitMean!.denominator));
  const b = fraction(BigInt(global.unitMean!.numerator), BigInt(global.unitMean!.denominator));
  const value = fraction(a.n * b.d + b.n * a.d, 2n * a.d * b.d);
  return { status: 'complete' as const, missing, value: encoded(value), numericValue: Number(value.n) / Number(value.d) };
}
