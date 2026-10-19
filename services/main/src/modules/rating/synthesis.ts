import { judgmentScale, onJudgmentScale, ratingUnits, unitsNumber, RATING_UNITS } from './scale.ts';
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

export interface RatingScale { min: number; max: number; step?: number }

/** Latest effective values of one standing Context: one per slot, null when withdrawn. */
export function reduceStandingComponent(values: readonly (number | null)[], scale: RatingScale) {
  const counts = new Map<number, number>();
  for (const value of values) if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  return reduceStandingCounts(values.length, counts, scale);
}

/** The same reduction over sealed additive figures. Cost depends on the Context's
 * bounded scale (at most 1001 bins), never on its number of raters. */
export function reduceStandingCounts(population: number, counts: ReadonlyMap<number, number>, scale: RatingScale) {
  if (!Number.isSafeInteger(population) || population < 0) throw new RangeError('invalid rating population');
  const grid = judgmentScale({ ...scale, step: scale.step ?? 1 });
  const min = ratingUnits(grid.min), max = ratingUnits(grid.max), step = ratingUnits(grid.step);
  const histogram = Array.from({ length: Number((max - min) / step) + 1 }, () => 0);
  let exactSum = 0n, count = 0;
  for (const [value, frequency] of counts) {
    if (!onJudgmentScale(value, grid) || !Number.isSafeInteger(frequency) || frequency < 0) {
      throw new RangeError('rating value lies outside its own scale');
    }
    const index = Number((ratingUnits(value) - min) / step);
    histogram[index] = histogram[index]! + frequency;
    exactSum += ratingUnits(value) * BigInt(frequency); count += frequency;
  }
  if (!Number.isSafeInteger(count) || count > population) throw new RangeError('rating counts exceed population');
  const mean = count ? fraction(exactSum, BigInt(count) * RATING_UNITS) : null;
  // (mean − min) / (max − min), computed on the exact sum.
  const unit = count ? fraction(exactSum - min * BigInt(count), BigInt(count) * (max - min)) : null;
  return {
    scale: grid,
    population, count, withdrawnCount: population - count, histogram, sum: unitsNumber(exactSum),
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
