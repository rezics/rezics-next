export const MAX_RATING_STORED_UNITS = 4096;
export const MAX_RATING_HISTOGRAM_BINS = MAX_RATING_STORED_UNITS + 1;
export const MAX_RATING_CHANGE_PAGE = 100;
export const MAX_RATING_POPULATION_DELIVERY_DELTAS = MAX_RATING_CHANGE_PAGE * 2;

export const POSTGRES_BIGINT_MIN = -9_223_372_036_854_775_808n;
export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const MAX_RATING_DELIVERY_COUNT_DELTA = BigInt(MAX_RATING_POPULATION_DELIVERY_DELTAS);
export const MAX_RATING_DELIVERY_SUM_DELTA = BigInt(MAX_RATING_STORED_UNITS) * MAX_RATING_DELIVERY_COUNT_DELTA;

export type RatingQuestionScale = Readonly<{
  minimumUnits: number;
  maximumUnits: number;
  stepUnits: number;
}>;

export function isStoredRatingUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RATING_STORED_UNITS;
}

export function checkedRatingQuestionScale(scale: RatingQuestionScale): RatingQuestionScale & { binCount: number } {
  if (
    !Number.isSafeInteger(scale.minimumUnits) ||
    !Number.isSafeInteger(scale.maximumUnits) ||
    !Number.isSafeInteger(scale.stepUnits) ||
    scale.minimumUnits < 0 ||
    scale.maximumUnits < scale.minimumUnits ||
    scale.maximumUnits > MAX_RATING_STORED_UNITS ||
    scale.stepUnits < 1
  )
    throw new TypeError('Unsupported rating question scale');

  const distance = scale.maximumUnits - scale.minimumUnits;
  if (distance > MAX_RATING_STORED_UNITS || distance % scale.stepUnits !== 0)
    throw new TypeError('Invalid rating question scale');
  const binCount = distance / scale.stepUnits + 1;
  if (!Number.isSafeInteger(binCount) || binCount < 1 || binCount > MAX_RATING_HISTOGRAM_BINS)
    throw new RangeError('Rating question histogram exceeds its bound');
  return { ...scale, binCount };
}

export function ratingQuestionHistogramSize(scale: RatingQuestionScale): number {
  return checkedRatingQuestionScale(scale).binCount;
}

export function ratingQuestionHistogramIndex(scale: RatingQuestionScale, units: unknown): number {
  const checked = checkedRatingQuestionScale(scale);
  if (
    !isStoredRatingUnit(units) ||
    units < checked.minimumUnits ||
    units > checked.maximumUnits ||
    (units - checked.minimumUnits) % checked.stepUnits !== 0
  )
    throw new TypeError('Rating vote is outside its question scale');
  return (units - checked.minimumUnits) / checked.stepUnits;
}

export function assertPostgresBigint(value: bigint): bigint {
  if (value < POSTGRES_BIGINT_MIN || value > POSTGRES_BIGINT_MAX)
    throw new RangeError('Rating arithmetic exceeds PostgreSQL bigint');
  return value;
}

export function assertPopulationDeliveryDelta(count: bigint, sum: bigint): void {
  if (
    count < -MAX_RATING_DELIVERY_COUNT_DELTA ||
    count > MAX_RATING_DELIVERY_COUNT_DELTA ||
    sum < -MAX_RATING_DELIVERY_SUM_DELTA ||
    sum > MAX_RATING_DELIVERY_SUM_DELTA
  )
    throw new RangeError('Rating population delivery exceeds its exact page bound');
}
