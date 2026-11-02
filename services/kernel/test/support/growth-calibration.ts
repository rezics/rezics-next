import { classifySeries, type GrowthModelBound, type SeriesPoint } from './growth-model.ts';
import { GROWTH_REPETITION_CAPACITY, numericExtent } from './growth-numeric.ts';

/** One scale's measured values. Profile CTE limitation strings stay on the source record and are not fitting inputs. */
export type CalibrationRunPoint = Readonly<{
  scale: number;
  repetitions: readonly number[];
}>;

export type CalibrationCheck = Readonly<{
  check: string;
  runs: readonly (readonly CalibrationRunPoint[])[];
}>;

export type CalibrationOptions = Readonly<{
  coverage?: number;
}>;

export type CalibratedUncertainty = Readonly<{
  absolute: number;
  relative: number;
  exact: boolean;
  points: number;
  heldOutCoverage: number;
  worst: readonly Readonly<{
    check: string;
    run: number;
    scale: number;
    reference: number;
    need: number;
  }>[];
}>;

export type UncertaintyAllowance = Readonly<{
  absolute: number;
  relative: number;
}>;

type RunSummary = Readonly<{
  check: string;
  run: number;
  scale: number;
  value: number;
  spread: number;
}>;

type CalibrationPoint = Readonly<{
  check: string;
  run: number;
  scale: number;
  reference: number;
  need: number;
}>;

type Fit = Readonly<{ absolute: number; relative: number; mean: number }>;

type IndexedCheck = Readonly<{
  check: string;
  runCount: number;
  summaries: readonly RunSummary[];
  points: readonly CalibrationPoint[];
}>;

/** Finite calibration work admitted after profile-byte admission and before fitting. */
export const GROWTH_CALIBRATION_LIMITS = {
  checks: 256,
  runsPerCheck: 32,
  points: 4_096,
  heldOutRuns: 2_048,
  repetitions: GROWTH_REPETITION_CAPACITY,
} as const;

function medianCost(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

function repetitionSpread(values: readonly number[]): number {
  const { min, max } = numericExtent(values);
  return max - min;
}

function validateSeries(series: readonly CalibrationCheck[], coverage: number): void {
  if (series.length === 0) throw new TypeError('Calibration requires at least one check');
  if (!Number.isFinite(coverage) || coverage <= 0 || coverage > 1)
    throw new TypeError('Calibration coverage must be greater than 0 and at most 1');
  if (series.length > GROWTH_CALIBRATION_LIMITS.checks)
    throw new TypeError(
      `Calibration exceeds the ${GROWTH_CALIBRATION_LIMITS.checks} check capacity (${series.length} checks)`,
    );

  const names = new Set<string>();
  let heldOutRuns = 0;
  let points = 0;
  for (const item of series) {
    if (typeof item.check !== 'string' || item.check.length === 0)
      throw new TypeError('Each calibration check requires a name');
    if (names.has(item.check)) throw new TypeError(`Calibration check names must be unique: ${item.check}`);
    names.add(item.check);
    if (item.runs.length < 2) throw new TypeError(`Calibration check ${item.check} requires at least two runs`);
    if (item.runs.length > GROWTH_CALIBRATION_LIMITS.runsPerCheck)
      throw new TypeError(
        `Calibration check ${item.check} exceeds the ${GROWTH_CALIBRATION_LIMITS.runsPerCheck} run capacity (${item.runs.length} runs)`,
      );

    heldOutRuns += item.runs.length;
    if (heldOutRuns > GROWTH_CALIBRATION_LIMITS.heldOutRuns)
      throw new TypeError(
        `Calibration check ${item.check} exceeds the ${GROWTH_CALIBRATION_LIMITS.heldOutRuns} leave-one-run-out capacity (${heldOutRuns} runs)`,
      );

    let checkPoints = 0;
    for (const run of item.runs) {
      if (run.length === 0) throw new TypeError(`Calibration runs for ${item.check} must contain points`);
      checkPoints += run.length;
      if (points + checkPoints > GROWTH_CALIBRATION_LIMITS.points)
        throw new TypeError(
          `Calibration check ${item.check} exceeds the ${GROWTH_CALIBRATION_LIMITS.points} point capacity (${points + checkPoints} check×run×scale points)`,
        );
    }
    points += checkPoints;

    let scales: number[] | undefined;
    for (const run of item.runs) {
      const runScales: number[] = [];
      let previousScale = 0;
      for (const point of run) {
        if (!Number.isFinite(point.scale) || point.scale <= previousScale)
          throw new TypeError('Calibration scales must be finite, positive and strictly increasing');
        previousScale = point.scale;
        runScales.push(point.scale);
        if (point.repetitions.length === 0)
          throw new TypeError('Each calibration point requires at least one repetition');
        if (point.repetitions.length > GROWTH_CALIBRATION_LIMITS.repetitions)
          throw new TypeError(
            `Calibration check ${item.check} exceeds the ${GROWTH_CALIBRATION_LIMITS.repetitions} repetition capacity (${point.repetitions.length} repetitions at scale ${point.scale})`,
          );
        if (point.repetitions.some((value) => !Number.isFinite(value) || value < 0))
          throw new TypeError('Calibration repetitions must be finite and non-negative');
      }
      if (scales && (scales.length !== runScales.length || scales.some((scale, index) => scale !== runScales[index])))
        throw new TypeError(`Calibration runs for ${item.check} must use the same scales`);
      scales ??= runScales;
    }
  }
}

function indexChecks(series: readonly CalibrationCheck[]): readonly IndexedCheck[] {
  return series.map(({ check, runs }) => {
    const summaries = runs.flatMap((run, runIndex) =>
      run.map(({ scale, repetitions }) => ({
        check,
        run: runIndex,
        scale,
        value: medianCost(repetitions),
        spread: repetitionSpread(repetitions),
      })),
    );
    return { check, runCount: runs.length, summaries, points: toCalibrationPoints(summaries) };
  });
}

function trainingPoints(
  indexed: readonly IndexedCheck[],
  omitted: Readonly<{ check: string; run: number }>,
): CalibrationPoint[] {
  return indexed.flatMap((item) => {
    if (item.check !== omitted.check) return item.points;
    return toCalibrationPoints(item.summaries.filter((summary) => summary.run !== omitted.run));
  });
}

function referencesFor(summaries: readonly RunSummary[]): Map<string, number> {
  const grouped = new Map<string, number[]>();
  for (const summary of summaries) {
    const key = referenceKey(summary.check, summary.scale);
    const values = grouped.get(key) ?? [];
    values.push(summary.value);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [key, medianCost(values)]));
}

function referenceKey(check: string, scale: number): string {
  return JSON.stringify([check, scale]);
}

function toCalibrationPoints(summaries: readonly RunSummary[]): CalibrationPoint[] {
  const references = referencesFor(summaries);
  return summaries.map((summary) => {
    const reference = references.get(referenceKey(summary.check, summary.scale))!;
    return {
      check: summary.check,
      run: summary.run,
      scale: summary.scale,
      reference,
      need: Math.max(Math.abs(summary.value - reference), summary.spread / 2),
    };
  });
}

function requiredAbsolute(points: readonly CalibrationPoint[], relative: number, coverage: number): number {
  const required = points
    .map(({ need, reference }) => (need <= relative * reference ? 0 : need))
    .sort((left, right) => left - right);
  const count = Math.ceil(coverage * points.length);
  return required[count - 1]!;
}

function meanAllowance(points: readonly CalibrationPoint[], absolute: number, relative: number): number {
  let scale = absolute;
  for (const { reference } of points) scale = Math.max(scale, relative * reference);
  if (scale === 0) return 0;

  let sum = 0;
  let correction = 0;
  for (const { reference } of points) {
    const normalized = Math.max(absolute, relative * reference) / scale;
    const adjusted = normalized - correction;
    const next = sum + adjusted;
    correction = next - sum - adjusted;
    sum = next;
  }
  const mean = scale * Math.min(1, sum / points.length);
  if (!Number.isFinite(mean))
    throw new TypeError(`Calibration fit objective for ${points.length} points is not finite`);
  if (mean === 0) throw new TypeError(`Calibration fit objective for ${points.length} points is below numeric range`);
  return mean;
}

function fit(points: readonly CalibrationPoint[], coverage: number): Fit {
  let best: Fit | undefined;
  for (let step = 0; step <= 100; step += 1) {
    const relative = step / 100;
    const absolute = requiredAbsolute(points, relative, coverage);
    const mean = meanAllowance(points, absolute, relative);
    if (!best || mean < best.mean) best = { absolute, relative, mean };
  }
  return best!;
}

function allowance(point: CalibrationPoint, fitted: Pick<Fit, 'absolute' | 'relative'>): number {
  return Math.max(fitted.absolute, fitted.relative * point.reference);
}

/** Calibrate one metric's absolute and relative uncertainty from repeated unchanged-code runs. */
export function calibrateUncertainty(
  series: readonly CalibrationCheck[],
  options: CalibrationOptions = {},
): CalibratedUncertainty {
  const coverage = options.coverage ?? 1;
  validateSeries(series, coverage);

  const indexed = indexChecks(series);
  const calibrationPoints = indexed.flatMap((item) => item.points);
  const selected = fit(calibrationPoints, coverage);
  const heldOut: { need: number; allowance: number }[] = [];

  for (const item of indexed) {
    for (let run = 0; run < item.runCount; run += 1) {
      const trained = fit(trainingPoints(indexed, { check: item.check, run }), coverage);
      const remaining = item.summaries.filter((summary) => summary.run !== run);
      const references = referencesFor(remaining);
      for (const summary of item.summaries) {
        if (summary.run !== run) continue;
        const reference = references.get(referenceKey(item.check, summary.scale));
        // Every check has at least two runs, so leave-one-run-out always leaves a reference.
        if (reference === undefined)
          throw new TypeError(`No held-out reference for ${item.check} at scale ${summary.scale}`);
        heldOut.push({
          need: Math.max(Math.abs(summary.value - reference), summary.spread / 2),
          allowance: Math.max(trained.absolute, trained.relative * reference),
        });
      }
    }
  }

  const worst = calibrationPoints
    .map((point) => {
      const allowed = allowance(point, selected);
      const ratio = allowed === 0 ? (point.need === 0 ? 0 : Number.POSITIVE_INFINITY) : point.need / allowed;
      return { ...point, ratio };
    })
    .toSorted(
      (left, right) =>
        right.ratio - left.ratio ||
        right.need - left.need ||
        left.check.localeCompare(right.check) ||
        left.run - right.run ||
        left.scale - right.scale,
    )
    .slice(0, 5)
    .map(({ check, run, scale, reference, need }) => ({ check, run, scale, reference, need }));

  return {
    absolute: selected.absolute,
    relative: selected.relative,
    exact: calibrationPoints.every(({ need }) => need === 0),
    points: calibrationPoints.length,
    heldOutCoverage: heldOut.filter(({ need, allowance: allowed }) => need <= allowed).length / heldOut.length,
    worst,
  };
}

/** Find the first linear increase that classifySeries rejects under the requested growth bound. */
export function detectableSlope(
  scales: readonly number[],
  uncertainty: UncertaintyAllowance,
  bound: Extract<GrowthModelBound, 'constant' | 'logarithmic'>,
  base = 1,
): number {
  if (scales.length < 3) throw new TypeError('Detectable slope requires at least three scales');
  if (!Number.isFinite(base) || base < 0) throw new TypeError('Slope base must be finite and non-negative');
  if (
    !Number.isFinite(uncertainty.absolute) ||
    uncertainty.absolute < 0 ||
    !Number.isFinite(uncertainty.relative) ||
    uncertainty.relative < 0
  )
    throw new TypeError('Uncertainty components must be finite and non-negative');

  const firstScale = scales[0]!;
  let previousScale = 0;
  for (const scale of scales) {
    if (!Number.isFinite(scale) || scale <= previousScale)
      throw new TypeError('Growth scales must be finite, positive and strictly increasing');
    previousScale = scale;
  }
  if (firstScale <= 0) throw new TypeError('Growth scales must be positive');

  const coordinates = scales.map((scale) => {
    const ratio = scale / firstScale;
    const coordinate = ratio - 1;
    if (!Number.isFinite(ratio) || !Number.isFinite(coordinate) || (scale > firstScale && coordinate === 0))
      throw new TypeError(`Growth scale coordinate at scale ${scale} is not representable`);
    return coordinate;
  });

  const outcomeAt = (slope: number): string => {
    const direct: SeriesPoint[] = [];
    let directIsRepresentable = true;
    for (const [index, scale] of scales.entries()) {
      const value = base + slope * coordinates[index]!;
      const pointUncertainty = Math.max(uncertainty.absolute, uncertainty.relative * value);
      if (!Number.isFinite(value) || !Number.isFinite(pointUncertainty)) {
        directIsRepresentable = false;
        break;
      }
      direct.push({ scale, repetitions: [value, value, value], uncertainty: pointUncertainty });
    }

    if (directIsRepresentable) {
      try {
        return classifySeries(direct, bound).outcome;
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
      }
    }

    const logOf = (value: number): number => (value === 0 ? Number.NEGATIVE_INFINITY : Math.log(value));
    const addLogs = (left: number, right: number): number => {
      if (left === Number.NEGATIVE_INFINITY) return right;
      if (right === Number.NEGATIVE_INFINITY) return left;
      const high = Math.max(left, right);
      return high + Math.log1p(Math.exp(Math.min(left, right) - high));
    };
    const valueLogs = coordinates.map((coordinate) =>
      addLogs(
        logOf(base),
        slope === 0 || coordinate === 0 ? Number.NEGATIVE_INFINITY : logOf(slope) + logOf(coordinate),
      ),
    );
    const uncertaintyLogs = valueLogs.map((valueLog) =>
      Math.max(
        logOf(uncertainty.absolute),
        uncertainty.relative === 0 ? Number.NEGATIVE_INFINITY : logOf(uncertainty.relative) + valueLog,
      ),
    );
    const scaleLog = Math.max(0, ...valueLogs, ...uncertaintyLogs);
    const fromLog = (valueLog: number): number =>
      valueLog === Number.NEGATIVE_INFINITY ? 0 : Math.exp(valueLog - scaleLog);
    const scaled = scales.map((scale, index) => {
      const value = fromLog(valueLogs[index]!);
      return {
        scale,
        repetitions: [value, value, value],
        uncertainty: fromLog(uncertaintyLogs[index]!),
      };
    });
    try {
      return classifySeries(scaled, bound).outcome;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw new TypeError(`Cannot classify slope ${slope} under the ${bound} growth bound: ${error.message}`, {
        cause: error,
      });
    }
  };

  const maximum = Number.MAX_VALUE;
  const breakpoints = new Set([0, maximum]);
  const addBreakpoint = (target: number, x: number): void => {
    if (x === 0 || !Number.isFinite(target)) return;
    const slope = (target - base) / x;
    if (slope > 0 && slope < maximum) breakpoints.add(slope);
  };
  for (const [index, scale] of scales.entries()) {
    const x = coordinates[index]!;
    // The pointwise envelope changes slope when the absolute and relative terms cross.
    if (uncertainty.relative > 0) addBreakpoint(uncertainty.absolute / uncertainty.relative, x);
    // The lower interval is clipped at zero while the absolute term dominates.
    addBreakpoint(uncertainty.absolute, x);
  }

  const boundaries = [...breakpoints].toSorted((left, right) => left - right);
  const firstRejectedIn = (safe: number, rejected: number): number => {
    let low = safe;
    let high = rejected;
    for (let iteration = 0; iteration < 256; iteration += 1) {
      const middle = low + (high - low) / 2;
      if (middle === low || middle === high) break;
      if (outcomeAt(middle) !== 'compatible') high = middle;
      else low = middle;
      if (low > 0 && high - low <= Math.abs(high) * 1e-6) break;
    }
    return high;
  };

  // Within each piece the uncertainty bounds are affine in the candidate slope. Feasibility
  // for either allowed family is therefore an interval, so its midpoint detects any interior
  // rejection even when relative uncertainty makes the full range non-monotonic.
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const low = boundaries[index]!;
    const high = boundaries[index + 1]!;
    const middle = low + (high - low) / 2;
    if (outcomeAt(middle) !== 'compatible') return firstRejectedIn(low, middle);
    if (outcomeAt(high) !== 'compatible') return firstRejectedIn(middle, high);
  }
  return Number.POSITIVE_INFINITY;
}
