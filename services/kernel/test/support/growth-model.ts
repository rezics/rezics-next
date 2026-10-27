export type GrowthModelBound = 'constant' | 'logarithmic' | 'linear';
export type GrowthFamily = GrowthModelBound;

export type SeriesPoint = Readonly<{
  scale: number;
  repetitions: readonly number[];
  uncertainty: number;
}>;

export type SeriesInterval = Readonly<{ lower: number; upper: number }>;

export type FamilyFit = Readonly<{
  /** Ordinary least-squares intercept and slope, reported for diagnosis. */
  a: number;
  b: number;
  /** Observed median minus the fitted prediction at each scale. */
  residuals: readonly number[];
  /** Smallest multiplier t of the declared uncertainties that makes this family feasible. */
  factor: number;
}>;

export type SeriesClassification = Readonly<{
  outcome: 'compatible' | 'violation' | 'insufficient-evidence';
  bound: GrowthModelBound;
  medians: readonly number[];
  intervals: readonly SeriesInterval[];
  adjacentDifferences: readonly number[];
  families: Readonly<Record<GrowthFamily, FamilyFit>>;
}>;

type Line = Readonly<{ intercept: number; x: number }>;

const FAMILIES: readonly GrowthFamily[] = ['constant', 'logarithmic', 'linear'];
const ROUNDING_ULPS = 16;

function medianCost(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

function validatePoints(points: readonly SeriesPoint[], bound: GrowthModelBound): void {
  if (bound !== 'constant' && bound !== 'logarithmic' && bound !== 'linear')
    throw new TypeError(`Unknown growth bound: ${String(bound)}`);
  if (points.length < 3) throw new TypeError('Growth classification requires at least three scales');

  let previousScale = 0;
  for (const point of points) {
    if (!Number.isFinite(point.scale) || point.scale <= previousScale)
      throw new TypeError('Growth scales must be finite, positive and strictly increasing');
    previousScale = point.scale;
    if (point.repetitions.length === 0) throw new TypeError('Each scale requires at least one repetition');
    if (point.repetitions.some((value) => !Number.isFinite(value) || value < 0))
      throw new TypeError('Repetitions must be finite and non-negative');
    if (!Number.isFinite(point.uncertainty) || point.uncertainty < 0)
      throw new TypeError('Uncertainty must be finite and non-negative');
  }
}

function familyCoordinates(points: readonly SeriesPoint[], family: GrowthFamily): number[] {
  const firstScale = points[0]!.scale;
  switch (family) {
    case 'constant':
      return points.map(() => 0);
    case 'logarithmic':
      return points.map(({ scale }) => {
        const relativeDifference = (scale - firstScale) / firstScale;
        return Number.isFinite(relativeDifference)
          ? Math.log1p(relativeDifference)
          : Math.log(scale) - Math.log(firstScale);
      });
    case 'linear':
      return points.map(({ scale }) => (scale - firstScale) / firstScale);
  }
}

function roundingTolerance(left: number, right: number): number {
  return ROUNDING_ULPS * Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function noGreaterThan(left: number, right: number): boolean {
  return left <= right || left - right <= roundingTolerance(left, right);
}

/**
 * For fixed b, an intercept exists exactly when every lower line is below every upper line.
 * Each pair gives one linear constraint on b, so their intersection is a single interval.
 */
function isFeasible(
  coordinates: readonly number[],
  intervals: readonly SeriesInterval[],
  family: GrowthFamily,
): boolean {
  if (intervals.length === 0) return true;
  if (family === 'constant') {
    const lower = Math.max(0, ...intervals.map(({ lower }) => lower));
    const upper = Math.min(...intervals.map(({ upper }) => upper));
    return noGreaterThan(lower, upper);
  }

  const lowerLines: Line[] = [{ intercept: 0, x: 0 }];
  for (let index = 0; index < intervals.length; index += 1)
    lowerLines.push({ intercept: intervals[index]!.lower, x: coordinates[index]! });
  const upperLines: Line[] = intervals.map(({ upper }, index) => ({ intercept: upper, x: coordinates[index]! }));

  let minimumB = 0;
  let maximumB = Number.POSITIVE_INFINITY;
  for (const lower of lowerLines) {
    for (const upper of upperLines) {
      const coefficient = upper.x - lower.x;
      const available = upper.intercept - lower.intercept;
      if (coefficient === 0) {
        if (!noGreaterThan(0, available)) return false;
      } else if (coefficient > 0) {
        const limit = available / coefficient;
        if (limit < 0 && !noGreaterThan(0, limit)) return false;
        maximumB = Math.min(maximumB, Math.max(0, limit));
      } else {
        minimumB = Math.max(minimumB, available / coefficient);
      }
      if (!noGreaterThan(minimumB, maximumB)) return false;
    }
  }

  // Prefer the interior of a feasible range so rounding at its edge does not reject a valid intercept.
  const b = Number.isFinite(maximumB) && maximumB > minimumB ? minimumB + (maximumB - minimumB) / 2 : minimumB;
  const lowerA = Math.max(0, ...intervals.map(({ lower }, index) => lower - b * coordinates[index]!));
  const upperA = Math.min(...intervals.map(({ upper }, index) => upper - b * coordinates[index]!));
  return noGreaterThan(lowerA, upperA);
}

function expandedIntervals(
  medians: readonly number[],
  uncertainties: readonly number[],
  factor: number,
): SeriesInterval[] {
  return medians.map((median, index) => {
    const allowance = uncertainties[index]! * factor;
    return { lower: Math.max(0, median - allowance), upper: median + allowance };
  });
}

function canFitExactly(
  coordinates: readonly number[],
  medians: readonly number[],
  uncertainties: readonly number[],
  family: GrowthFamily,
): boolean {
  const exactIndexes = uncertainties.flatMap((uncertainty, index) => (uncertainty === 0 ? [index] : []));
  const intervals = exactIndexes.map((index) => ({ lower: medians[index]!, upper: medians[index]! }));
  return isFeasible(
    exactIndexes.map((index) => coordinates[index]!),
    intervals,
    family,
  );
}

function uncertaintyFactor(
  coordinates: readonly number[],
  medians: readonly number[],
  uncertainties: readonly number[],
  family: GrowthFamily,
): number {
  if (!canFitExactly(coordinates, medians, uncertainties, family)) return Number.POSITIVE_INFINITY;

  const fitsAt = (factor: number): boolean =>
    isFeasible(coordinates, expandedIntervals(medians, uncertainties, factor), family);
  if (fitsAt(0)) return 0;

  let low = 0;
  let high = 1;
  if (!fitsAt(high)) {
    low = high;
    do {
      high *= 2;
      if (!Number.isFinite(high)) return Number.POSITIVE_INFINITY;
      if (fitsAt(high)) break;
      low = high;
    } while (true);
  }

  while (high - low > 1e-9) {
    const middle = low + (high - low) / 2;
    if (middle === low || middle === high) break;
    if (fitsAt(middle)) high = middle;
    else low = middle;
  }
  return high;
}

function leastSquaresFit(
  coordinates: readonly number[],
  medians: readonly number[],
  family: GrowthFamily,
): {
  a: number;
  b: number;
} {
  const count = medians.length;
  const meanY = medians.reduce((sum, value) => sum + value, 0) / count;
  if (family === 'constant') return { a: meanY, b: 0 };

  const meanX = coordinates.reduce((sum, value) => sum + value, 0) / count;
  let variance = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const x = coordinates[index]!;
    const y = medians[index]!;
    variance += (x - meanX) * (x - meanX);
    covariance += (x - meanX) * (y - meanY);
  }

  const unconstrainedB = covariance / variance;
  const unconstrainedA = meanY - unconstrainedB * meanX;
  return { a: unconstrainedA, b: unconstrainedB };
}

function familyFit(
  family: GrowthFamily,
  coordinates: readonly number[],
  medians: readonly number[],
  uncertainties: readonly number[],
): FamilyFit {
  const { a, b } = leastSquaresFit(coordinates, medians, family);
  return {
    a,
    b,
    residuals: medians.map((median, index) => median - (a + b * coordinates[index]!)),
    factor: uncertaintyFactor(coordinates, medians, uncertainties, family),
  };
}

function allowedFamilies(bound: GrowthModelBound): readonly GrowthFamily[] {
  switch (bound) {
    case 'constant':
      return ['constant'];
    case 'logarithmic':
      return ['constant', 'logarithmic'];
    case 'linear':
      return FAMILIES;
  }
}

export function classifySeries(points: readonly SeriesPoint[], bound: GrowthModelBound): SeriesClassification {
  validatePoints(points, bound);
  const medians = points.map(({ repetitions }) => medianCost(repetitions));
  const uncertainties = points.map(({ uncertainty }) => uncertainty);
  const intervals = expandedIntervals(medians, uncertainties, 1);
  const adjacentDifferences = medians.slice(1).map((median, index) => median - medians[index]!);
  const families = Object.fromEntries(
    FAMILIES.map((family) => {
      const coordinates = familyCoordinates(points, family);
      return [family, familyFit(family, coordinates, medians, uncertainties)];
    }),
  ) as Record<GrowthFamily, FamilyFit>;

  const insufficient = points.some(({ repetitions, uncertainty }) => {
    const spread = Math.max(...repetitions) - Math.min(...repetitions);
    return spread > 2 * uncertainty;
  });
  const compatible = allowedFamilies(bound).some((family) => {
    const coordinates = familyCoordinates(points, family);
    return isFeasible(coordinates, intervals, family);
  });

  return {
    outcome: insufficient ? 'insufficient-evidence' : compatible ? 'compatible' : 'violation',
    bound,
    medians,
    intervals,
    adjacentDifferences,
    families,
  };
}
