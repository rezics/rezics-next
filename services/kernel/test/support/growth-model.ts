import {
  checkedAdd,
  checkedDivide,
  checkedMultiply,
  checkedMultiplyDivide,
  checkedSubtract,
  requireDenseArray,
  requireNonNegativeFiniteNumber,
} from './growth-numeric.ts';

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
  outcome: 'compatible' | 'violation' | 'inconclusive';
  reason?: 'noise';
  bound: GrowthModelBound;
  medians: readonly number[];
  /** Distribution-free confidence interval for each median, using the repetition minimum and maximum. */
  ranges: readonly SeriesInterval[];
  /** Running maximum envelope of the median intervals widened by uncertainty. */
  intervals: readonly SeriesInterval[];
  adjacentDifferences: readonly number[];
  families: Readonly<Record<GrowthFamily, FamilyFit>>;
  /** Cumulative index-level allowance used at each scale (zero at the first scale). */
  staircase: readonly number[];
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
  if (points.length < 3 || points.length > 5)
    throw new TypeError('Growth classification requires three to five scales');
  requireDenseArray(points, 'Growth points');

  let previousScale = 0;
  for (const [index, point] of points.entries()) {
    if (typeof point !== 'object' || point === null) throw new TypeError(`Growth point ${index + 1} must be an object`);
    if (!Number.isFinite(point.scale) || point.scale <= previousScale)
      throw new TypeError('Growth scales must be finite, positive and strictly increasing');
    previousScale = point.scale;
    if (!Array.isArray(point.repetitions) || point.repetitions.length === 0)
      throw new TypeError('Each scale requires at least one repetition');
    requireDenseArray(point.repetitions, `Repetitions at scale ${point.scale}`);
    for (let repetition = 0; repetition < point.repetitions.length; repetition += 1)
      requireNonNegativeFiniteNumber(
        point.repetitions[repetition],
        `Repetition ${repetition + 1} at scale ${point.scale}`,
      );
    requireNonNegativeFiniteNumber(point.uncertainty, `Uncertainty at scale ${point.scale}`);
  }
}

function familyCoordinates(points: readonly SeriesPoint[], family: GrowthFamily): number[] {
  const firstScale = points[0]!.scale;
  let coordinates: number[];
  switch (family) {
    case 'constant':
      coordinates = points.map(() => 0);
      break;
    case 'logarithmic':
      coordinates = points.map(({ scale }) => {
        const difference = scale - firstScale;
        const relativeDifference = difference / firstScale;
        const coordinate =
          Number.isFinite(relativeDifference) && (relativeDifference !== 0 || difference === 0)
            ? Math.log1p(relativeDifference)
            : checkedSubtract(Math.log(scale), Math.log(firstScale), 'Logarithmic scale coordinate');
        if (!Number.isFinite(coordinate)) throw new TypeError('Logarithmic scale coordinate is not finite');
        return coordinate;
      });
      break;
    case 'linear':
      coordinates = points.map(({ scale }) => {
        const ratio = checkedDivide(scale, firstScale, 'Linear scale ratio');
        const coordinate = ratio - 1;
        if (!Number.isFinite(coordinate) || (scale > firstScale && coordinate === 0))
          throw new TypeError('Linear scale coordinate is not representable');
        return coordinate;
      });
      break;
  }
  if (
    family !== 'constant' &&
    coordinates.some((coordinate, index) => index > 0 && coordinate <= coordinates[index - 1]!)
  )
    throw new TypeError(`${family} scale coordinates are not representable as strictly increasing values`);
  return coordinates;
}

function roundingTolerance(left: number, right: number): number {
  return checkedMultiply(
    ROUNDING_ULPS * Number.EPSILON,
    Math.max(1, Math.abs(left), Math.abs(right)),
    'Feasibility rounding tolerance',
  );
}

function noGreaterThan(left: number, right: number): boolean {
  return (
    left <= right || checkedSubtract(left, right, 'Feasibility comparison difference') <= roundingTolerance(left, right)
  );
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
      const coefficient = checkedSubtract(upper.x, lower.x, 'Feasibility slope coefficient');
      const available = checkedSubtract(upper.intercept, lower.intercept, 'Feasibility intercept gap');
      if (coefficient === 0) {
        if (!noGreaterThan(0, available)) return false;
      } else if (coefficient > 0) {
        const limit = available / coefficient;
        if (limit === Number.NEGATIVE_INFINITY) return false;
        if (limit !== Number.POSITIVE_INFINITY) {
          if (!Number.isFinite(limit) || (available !== 0 && limit === 0))
            throw new TypeError('Feasibility maximum slope is not representable');
          if (limit < 0 && !noGreaterThan(0, limit)) return false;
          maximumB = Math.min(maximumB, Math.max(0, limit));
        }
      } else {
        const limit = available / coefficient;
        if (
          limit === Number.POSITIVE_INFINITY ||
          (!Number.isFinite(limit) && limit !== Number.NEGATIVE_INFINITY) ||
          (available !== 0 && limit === 0)
        )
          throw new TypeError('Feasibility minimum slope is not representable');
        if (limit !== Number.NEGATIVE_INFINITY) minimumB = Math.max(minimumB, limit);
      }
      if (!noGreaterThan(minimumB, maximumB)) return false;
    }
  }

  // Prefer the interior of a feasible range so rounding at its edge does not reject a valid intercept.
  const b =
    Number.isFinite(maximumB) && maximumB > minimumB
      ? checkedAdd(
          minimumB,
          checkedSubtract(maximumB, minimumB, 'Feasible slope interval width') / 2,
          'Feasible slope midpoint',
        )
      : minimumB;
  const lowerA = Math.max(
    0,
    ...intervals.map(({ lower }, index) =>
      checkedSubtract(
        lower,
        checkedMultiply(b, coordinates[index]!, 'Feasible lower prediction'),
        'Feasible lower intercept',
      ),
    ),
  );
  const upperA = Math.min(
    ...intervals.map(({ upper }, index) =>
      checkedSubtract(
        upper,
        checkedMultiply(b, coordinates[index]!, 'Feasible upper prediction'),
        'Feasible upper intercept',
      ),
    ),
  );
  return noGreaterThan(lowerA, upperA);
}

function expandedIntervals(
  medians: readonly number[],
  uncertainties: readonly number[],
  factor: number,
): SeriesInterval[] {
  return medians.map((median, index) => {
    const allowance = checkedMultiply(uncertainties[index]!, factor, 'Expanded uncertainty interval');
    return {
      lower: Math.max(0, checkedSubtract(median, allowance, 'Expanded uncertainty lower bound')),
      upper: checkedAdd(median, allowance, 'Expanded uncertainty upper bound'),
    };
  });
}

function runningMaximumEnvelope(intervals: readonly SeriesInterval[]): SeriesInterval[] {
  let lower = 0;
  let upper = 0;
  return intervals.map((interval) => {
    lower = Math.max(lower, interval.lower);
    upper = Math.max(upper, interval.upper);
    return { lower, upper };
  });
}

function uncertaintyFactor(
  coordinates: readonly number[],
  medians: readonly number[],
  uncertainties: readonly number[],
  family: GrowthFamily,
): number {
  const fitsAt = (factor: number): boolean => {
    try {
      return isFeasible(coordinates, runningMaximumEnvelope(expandedIntervals(medians, uncertainties, factor)), family);
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  };
  if (fitsAt(0)) return 0;
  if (uncertainties.every((uncertainty) => uncertainty === 0)) return Number.POSITIVE_INFINITY;

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
    const middle = checkedAdd(
      low,
      checkedSubtract(high, low, 'Uncertainty factor search width') / 2,
      'Uncertainty factor midpoint',
    );
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
  const mean = (values: readonly number[], label: string): number => {
    let total = 0;
    let ordinary = true;
    for (const value of values) {
      const next = total + value;
      if (!Number.isFinite(next) || (value !== 0 && next === total)) {
        ordinary = false;
        break;
      }
      total = next;
    }
    if (ordinary) return total / count;

    let average = values[0]!;
    for (let index = 1; index < values.length; index += 1) {
      const difference = checkedSubtract(values[index]!, average, `${label} mean difference`);
      average = checkedAdd(average, checkedDivide(difference, index + 1, `${label} incremental mean`), `${label} mean`);
    }
    return average;
  };
  const meanY = mean(medians, 'Median');
  if (family === 'constant') return { a: meanY, b: 0 };

  const meanX = mean(coordinates, 'Coordinate');
  const xDifferences = coordinates.map((x) => checkedSubtract(x, meanX, 'Regression coordinate difference'));
  const yDifferences = medians.map((y) => checkedSubtract(y, meanY, 'Regression median difference'));
  const xScale = Math.max(...xDifferences.map(Math.abs));
  const yScale = Math.max(...yDifferences.map(Math.abs));
  if (xScale === 0) throw new TypeError('Regression coordinates have no representable spread');
  let variance = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const x = checkedDivide(xDifferences[index]!, xScale, 'Normalized regression coordinate');
    const y = yScale === 0 ? 0 : checkedDivide(yDifferences[index]!, yScale, 'Normalized regression median');
    variance = checkedAdd(
      variance,
      checkedMultiply(x, x, 'Normalized regression variance term'),
      'Regression variance',
    );
    covariance = checkedAdd(
      covariance,
      checkedMultiply(x, y, 'Normalized regression covariance term'),
      'Regression covariance',
    );
  }

  const normalizedB = checkedDivide(covariance, variance, 'Normalized regression slope');
  const unconstrainedB = yScale === 0 ? 0 : checkedMultiplyDivide(normalizedB, yScale, xScale, 'Regression slope');
  const fittedMean = checkedMultiply(unconstrainedB, meanX, 'Regression fitted mean');
  const unconstrainedA = checkedSubtract(meanY, fittedMean, 'Regression intercept');
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
    residuals: medians.map((median, index) =>
      checkedSubtract(
        median,
        checkedAdd(a, checkedMultiply(b, coordinates[index]!, 'Regression fitted value'), 'Regression prediction'),
        'Regression residual',
      ),
    ),
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

type Inequality = Readonly<{ coefficients: readonly number[]; limit: number }>;

/** Fourier-Motzkin elimination gives exact linear feasibility for the small (at most five scale) model. */
function staircaseFit(
  points: readonly SeriesPoint[],
  intervals: readonly SeriesInterval[],
  coordinates: readonly number[],
  family: GrowthFamily,
  probes: number,
): readonly number[] | undefined {
  const count = points.length;
  // Variables are intercept, family slope, then cumulative staircase values after the first scale.
  const variables = count + 1;
  let inequalities: Inequality[] = [];
  const add = (terms: readonly (readonly [number, number])[], limit: number): void => {
    const coefficients = Array<number>(variables).fill(0);
    for (const [variable, value] of terms) {
      if (!Number.isFinite(value)) throw new TypeError('Staircase coefficient must be finite');
      coefficients[variable] = value;
    }
    if (!Number.isFinite(limit)) throw new TypeError('Staircase constraint limit must be finite');
    inequalities.push({ coefficients, limit });
  };
  add([[0, -1]], 0); // intercept >= 0
  if (family !== 'constant') add([[1, -1]], 0); // slope >= 0
  for (let index = 0; index < count; index += 1) {
    const staircaseVariable = index + 1;
    const xTerm = family === 'constant' ? [] : ([[1, coordinates[index]!]] as const);
    const sTerm = index === 0 ? [] : ([[staircaseVariable, 1]] as const);
    const { lower, upper } = intervals[index]!;
    add([[0, -1], ...xTerm.map(([i, n]) => [i, -n] as const), ...sTerm.map(([i, n]) => [i, -n] as const)], -lower);
    add([[0, 1], ...xTerm, ...sTerm], upper);
    if (index > 0) {
      const previous = index === 1 ? [] : ([[staircaseVariable - 1, -1]] as const);
      add([...sTerm, ...previous.map(([i, n]) => [i, -n] as const)], probes);
      add([...sTerm.map(([i, n]) => [i, -n] as const), ...previous], 0);
    }
  }

  const stages: Inequality[][] = [inequalities];
  for (let variable = variables - 1; variable >= 0; variable -= 1) {
    const positive: Inequality[] = [];
    const negative: Inequality[] = [];
    const zero: Inequality[] = [];
    for (const inequality of inequalities) {
      const coefficient = inequality.coefficients[variable]!;
      if (coefficient > 0) positive.push(inequality);
      else if (coefficient < 0) negative.push(inequality);
      else zero.push(inequality);
    }
    const reduced: Inequality[] = zero.map(({ coefficients, limit }) => ({
      coefficients: coefficients.filter((_, index) => index !== variable),
      limit,
    }));
    for (const upper of positive)
      for (const lower of negative) {
        const up = upper.coefficients[variable]!;
        const down = -lower.coefficients[variable]!;
        reduced.push({
          coefficients: upper.coefficients.flatMap((value, index) =>
            index === variable
              ? []
              : [
                  checkedAdd(
                    checkedDivide(value, up, 'Staircase upper elimination coefficient'),
                    checkedDivide(lower.coefficients[index]!, down, 'Staircase lower elimination coefficient'),
                    'Staircase eliminated coefficient',
                  ),
                ],
          ),
          limit: checkedAdd(
            checkedDivide(upper.limit, up, 'Staircase upper elimination limit'),
            checkedDivide(lower.limit, down, 'Staircase lower elimination limit'),
            'Staircase eliminated limit',
          ),
        });
      }
    inequalities = reduced;
    stages.push(inequalities);
    if (inequalities.some(({ coefficients, limit }) => coefficients.every((value) => value === 0) && limit < -1e-9))
      return undefined;
  }

  const solution = Array<number>(variables).fill(0);
  for (let variable = 0; variable < variables; variable += 1) {
    let lower = Number.NEGATIVE_INFINITY;
    let upper = Number.POSITIVE_INFINITY;
    for (const inequality of stages[variables - variable - 1]!) {
      const coefficient = inequality.coefficients[variable]!;
      const rest = inequality.coefficients.reduce(
        (sum, value, index) =>
          index === variable
            ? sum
            : checkedAdd(
                sum,
                checkedMultiply(value, solution[index]!, 'Staircase constraint term'),
                'Staircase constraint sum',
              ),
        0,
      );
      if (coefficient > 0)
        upper = Math.min(
          upper,
          checkedDivide(
            checkedSubtract(inequality.limit, rest, 'Staircase upper bound numerator'),
            coefficient,
            'Staircase upper bound',
          ),
        );
      else if (coefficient < 0)
        lower = Math.max(
          lower,
          checkedDivide(
            checkedSubtract(inequality.limit, rest, 'Staircase lower bound numerator'),
            coefficient,
            'Staircase lower bound',
          ),
        );
      else if (rest > inequality.limit && checkedSubtract(rest, inequality.limit, 'Staircase feasibility gap') > 1e-8)
        return undefined;
    }
    if (lower > upper && checkedSubtract(lower, upper, 'Staircase variable range') > 1e-8) return undefined;
    solution[variable] =
      Number.isFinite(lower) && Number.isFinite(upper)
        ? checkedAdd(
            lower,
            checkedSubtract(upper, lower, 'Staircase variable interval') / 2,
            'Staircase variable midpoint',
          )
        : Number.isFinite(lower)
          ? lower
          : Number.isFinite(upper)
            ? upper
            : 0;
  }
  return [0, ...solution.slice(2)];
}

export function classifySeries(
  points: readonly SeriesPoint[],
  bound: GrowthModelBound,
  indexProbes = 0,
): SeriesClassification {
  validatePoints(points, bound);
  if (!Number.isSafeInteger(indexProbes) || indexProbes < 0)
    throw new TypeError('Index probes must be a non-negative safe integer');
  const medians = points.map(({ repetitions }) => medianCost(repetitions));
  const uncertainties = points.map(({ uncertainty }) => uncertainty);
  const ranges = points.map(({ repetitions }) => ({
    lower: Math.min(...repetitions),
    upper: Math.max(...repetitions),
  }));
  const intervals = runningMaximumEnvelope(expandedIntervals(medians, uncertainties, 1));
  const adjacentDifferences = medians
    .slice(1)
    .map((median, index) => checkedSubtract(median, medians[index]!, 'Adjacent median difference'));
  const families = Object.fromEntries(
    FAMILIES.map((family) => {
      const coordinates = familyCoordinates(points, family);
      return [family, familyFit(family, coordinates, medians, uncertainties)];
    }),
  ) as Record<GrowthFamily, FamilyFit>;

  const ordinaryCompatible = (candidate: readonly SeriesInterval[]): boolean =>
    allowedFamilies(bound).some((family) => {
      const coordinates = familyCoordinates(points, family);
      return isFeasible(coordinates, candidate, family);
    });
  let compatible = ordinaryCompatible(intervals);
  let staircase: readonly number[] = points.map(() => 0);
  if (!compatible && indexProbes > 0) {
    for (const family of allowedFamilies(bound)) {
      const fit = staircaseFit(points, intervals, familyCoordinates(points, family), family, indexProbes);
      if (fit) {
        staircase = fit;
        compatible = true;
        break;
      }
    }
  }

  const confidenceIntervals = runningMaximumEnvelope(
    ranges.map(({ lower, upper }, index) => ({
      lower: Math.max(0, checkedSubtract(lower, uncertainties[index]!, 'Confidence interval lower bound')),
      upper: checkedAdd(upper, uncertainties[index]!, 'Confidence interval upper bound'),
    })),
  );
  let evidenceFits = ordinaryCompatible(confidenceIntervals);
  if (!evidenceFits && indexProbes > 0)
    evidenceFits = allowedFamilies(bound).some(
      (family) =>
        staircaseFit(points, confidenceIntervals, familyCoordinates(points, family), family, indexProbes) !== undefined,
    );
  const outcome = compatible ? 'compatible' : evidenceFits ? 'inconclusive' : 'violation';

  return {
    outcome,
    ...(outcome === 'inconclusive' ? { reason: 'noise' as const } : {}),
    bound,
    medians,
    ranges,
    intervals,
    adjacentDifferences,
    families,
    staircase,
  };
}
