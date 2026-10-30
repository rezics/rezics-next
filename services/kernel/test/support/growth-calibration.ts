import { classifySeries, type GrowthModelBound, type SeriesPoint } from './growth-model.ts';

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

function medianCost(values: readonly number[]): number {
  return [...values].sort((left, right) => left - right)[(values.length - 1) >> 1]!;
}

function validateSeries(series: readonly CalibrationCheck[], coverage: number): void {
  if (series.length === 0) throw new TypeError('Calibration requires at least one check');
  if (!Number.isFinite(coverage) || coverage <= 0 || coverage > 1)
    throw new TypeError('Calibration coverage must be greater than 0 and at most 1');

  const names = new Set<string>();
  for (const item of series) {
    if (typeof item.check !== 'string' || item.check.length === 0)
      throw new TypeError('Each calibration check requires a name');
    if (names.has(item.check)) throw new TypeError(`Calibration check names must be unique: ${item.check}`);
    names.add(item.check);
    if (item.runs.length < 2) throw new TypeError(`Calibration check ${item.check} requires at least two runs`);

    let scales: number[] | undefined;
    for (const run of item.runs) {
      if (run.length === 0) throw new TypeError(`Calibration runs for ${item.check} must contain points`);
      const runScales: number[] = [];
      let previousScale = 0;
      for (const point of run) {
        if (!Number.isFinite(point.scale) || point.scale <= previousScale)
          throw new TypeError('Calibration scales must be finite, positive and strictly increasing');
        previousScale = point.scale;
        runScales.push(point.scale);
        if (point.repetitions.length === 0)
          throw new TypeError('Each calibration point requires at least one repetition');
        if (point.repetitions.some((value) => !Number.isFinite(value) || value < 0))
          throw new TypeError('Calibration repetitions must be finite and non-negative');
      }
      if (scales && (scales.length !== runScales.length || scales.some((scale, index) => scale !== runScales[index])))
        throw new TypeError(`Calibration runs for ${item.check} must use the same scales`);
      scales ??= runScales;
    }
  }
}

function summarizeRuns(
  series: readonly CalibrationCheck[],
  omitted?: Readonly<{ check: string; run: number }>,
): RunSummary[] {
  return series.flatMap(({ check, runs }) =>
    runs.flatMap((run, runIndex) => {
      if (omitted?.check === check && omitted.run === runIndex) return [];
      return run.map(({ scale, repetitions }) => ({
        check,
        run: runIndex,
        scale,
        value: medianCost(repetitions),
        spread: Math.max(...repetitions) - Math.min(...repetitions),
      }));
    }),
  );
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

function fit(points: readonly CalibrationPoint[], coverage: number): Fit {
  let best: Fit | undefined;
  for (let step = 0; step <= 100; step += 1) {
    const relative = step / 100;
    const absolute = requiredAbsolute(points, relative, coverage);
    const mean =
      points.reduce((sum, { reference }) => sum + Math.max(absolute, relative * reference), 0) / points.length;
    if (!best || mean < best.mean) best = { absolute, relative, mean };
  }
  return best!;
}

function needsFor(
  series: readonly CalibrationCheck[],
  omitted?: Readonly<{ check: string; run: number }>,
): CalibrationPoint[] {
  return toCalibrationPoints(summarizeRuns(series, omitted));
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

  const calibrationPoints = needsFor(series);
  const selected = fit(calibrationPoints, coverage);
  const heldOut: { need: number; allowance: number }[] = [];

  for (const { check, runs } of series) {
    for (let run = 0; run < runs.length; run += 1) {
      const trainingPoints = needsFor(series, { check, run });
      const trained = fit(trainingPoints, coverage);
      const heldOutSummaries = summarizeRuns(series, { check, run });
      const references = referencesFor(heldOutSummaries);
      const heldOutRun = runs[run]!;
      for (const { scale, repetitions } of heldOutRun) {
        const reference = references.get(referenceKey(check, scale));
        // Every check has at least two runs, so leave-one-run-out always leaves a reference.
        if (reference === undefined) throw new TypeError(`No held-out reference for ${check} at scale ${scale}`);
        const value = medianCost(repetitions);
        const need = Math.max(Math.abs(value - reference), (Math.max(...repetitions) - Math.min(...repetitions)) / 2);
        heldOut.push({ need, allowance: Math.max(trained.absolute, trained.relative * reference) });
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

  const outcomeAt = (slope: number): string => {
    const points: SeriesPoint[] = [];
    for (const scale of scales) {
      const value = base + slope * (scale / firstScale - 1);
      if (!Number.isFinite(value) || value < 0) return 'violation';
      points.push({
        scale,
        repetitions: [value, value, value],
        uncertainty: Math.max(uncertainty.absolute, uncertainty.relative * value),
      });
    }
    return classifySeries(points, bound).outcome;
  };

  const maximum = 1e9;
  const breakpoints = new Set([0, maximum]);
  const addBreakpoint = (target: number, x: number): void => {
    if (x === 0 || !Number.isFinite(target)) return;
    const slope = (target - base) / x;
    if (slope > 0 && slope < maximum) breakpoints.add(slope);
  };
  for (const scale of scales) {
    const x = scale / firstScale - 1;
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
