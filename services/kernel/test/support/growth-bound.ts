import {
  checkedAdd,
  checkedDivide,
  checkedMultiply,
  checkedSubtract,
  requireDenseArray,
  requireNonNegativeFiniteNumber,
} from './growth-numeric.ts';

export type Metric = 'rows' | 'blocks' | 'statements';
export type ByteMetric = 'requestBytes' | 'responseBytes';
export type GrowthMetric = Metric | ByteMetric;
export type Bound = 'constant' | 'logarithmic' | 'linear';
export type Slack = { readonly absolute: number; readonly relative: number };
export const DEFAULT_SLACK: Readonly<Record<Metric, Slack>> = {
  rows: { absolute: 2, relative: 0.1 },
  blocks: { absolute: 4, relative: 0.5 },
  statements: { absolute: 0, relative: 0 },
};
export const DEFAULT_BYTE_SLACK: Readonly<Record<ByteMetric, Slack>> = {
  requestBytes: { absolute: 0, relative: 0.1 },
  responseBytes: { absolute: 0, relative: 0.1 },
};

/** Structural, so the harness's Cost type is assignable without an import. */
export type Measured = Readonly<Record<Metric, number>> & {
  readonly requestBytes?: number;
  readonly responseBytes?: number;
  readonly backgroundStatements?: number;
  readonly backgroundRows?: number;
  readonly backgroundBlocks?: number;
  readonly relations?: Readonly<
    Record<string, { readonly rows: number; readonly blocks: number; readonly sequentialScans?: number }>
  >;
};
export type RelationSize = { readonly reltuples: number; readonly relpages: number };
export type GrowthSample = {
  readonly scale: number;
  readonly cost: Measured;
  readonly repetitions?: readonly (Readonly<Record<Metric, number>> & Partial<Record<ByteMetric, number>>)[];
  readonly relationSizes?: Readonly<Record<string, RelationSize>>;
};
export type Violation = {
  readonly metric: GrowthMetric;
  readonly bound: Bound;
  readonly scales: readonly [number, number, number];
  readonly values: readonly [number, number, number];
  readonly observed: number;
  readonly allowed: number;
};

export class GrowthBoundError extends Error {
  readonly violations: readonly Violation[];
  readonly samples: readonly GrowthSample[];
  readonly byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>;

  constructor(
    violations: readonly Violation[],
    samples: readonly GrowthSample[],
    byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>,
  ) {
    super(formatMessage(violations, samples));
    this.name = 'GrowthBoundError';
    this.violations = violations;
    this.samples = samples;
    if (byteBounds !== undefined) this.byteBounds = byteBounds;
  }
}

export class GrowthEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrowthEvidenceError';
  }
}

const METRICS: readonly Metric[] = ['rows', 'blocks', 'statements'];

function validateSamples(samples: readonly GrowthSample[]): void {
  requireDenseArray(samples, 'Growth samples');
  if (samples.length < 3 || samples.length > 5) throw new TypeError('Growth checks require three to five samples');
  const scales = samples.map(({ scale }) => scale);
  if (
    scales.some((scale, index) => !Number.isFinite(scale) || scale <= 0 || (index > 0 && scale <= scales[index - 1]!))
  ) {
    throw new TypeError('Growth scales must be finite, positive and strictly increasing');
  }
  if (scales.at(-1)! > 4096) throw new TypeError('The largest growth scale must be no greater than 4096');
  const firstRatio = checkedDivide(scales[1]!, scales[0]!, 'Growth scale ratio');
  if (!Number.isFinite(firstRatio)) throw new TypeError('Growth scale ratios must be finite');
  if (
    firstRatio < 4 ||
    scales.slice(2).some((scale, index) => {
      const ratio = checkedDivide(scale, scales[index + 1]!, 'Growth scale ratio');
      if (!Number.isFinite(ratio)) throw new TypeError('Growth scale ratios must be finite');
      const difference = Math.abs(checkedSubtract(firstRatio, ratio, 'Growth scale ratio difference'));
      return checkedDivide(difference, Math.max(firstRatio, ratio), 'Relative growth scale ratio difference') >= 1e-9;
    })
  ) {
    throw new TypeError('Growth scales must have equal ratios of at least four');
  }
  for (const sample of samples) {
    if (typeof sample.cost !== 'object' || sample.cost === null)
      throw new TypeError('Growth cost evidence must be an object');
    for (const metric of METRICS) {
      requireNonNegativeFiniteNumber(sample.cost[metric], `Growth value for ${metric}`);
    }
    for (const metric of ['requestBytes', 'responseBytes'] as const)
      if (sample.cost[metric] !== undefined)
        requireNonNegativeFiniteNumber(sample.cost[metric], `Growth value for ${metric}`);
    if (sample.cost.relations !== undefined) {
      if (typeof sample.cost.relations !== 'object' || sample.cost.relations === null)
        throw new TypeError('Growth relation evidence must be an object');
      for (const [name, relation] of Object.entries(sample.cost.relations)) {
        if (typeof relation !== 'object' || relation === null)
          throw new TypeError(`Growth relation ${name} must be an object`);
        requireNonNegativeFiniteNumber(relation.rows, `Growth relation ${name} rows`);
        requireNonNegativeFiniteNumber(relation.blocks, `Growth relation ${name} blocks`);
        if (relation.sequentialScans !== undefined)
          requireNonNegativeFiniteNumber(relation.sequentialScans, `Growth relation ${name} sequential scans`);
      }
    }
    if (sample.repetitions !== undefined) {
      if (!Array.isArray(sample.repetitions)) throw new TypeError('Growth repetitions must be an array');
      requireDenseArray(sample.repetitions, 'Growth repetitions');
      sample.repetitions.forEach((repetition, index) => {
        if (typeof repetition !== 'object' || repetition === null)
          throw new TypeError(`Growth repetition ${index} must be an object`);
        for (const metric of METRICS)
          requireNonNegativeFiniteNumber(repetition[metric], `Growth repetition ${index} ${metric}`);
        for (const metric of ['requestBytes', 'responseBytes'] as const)
          if (repetition[metric] !== undefined)
            requireNonNegativeFiniteNumber(repetition[metric], `Growth repetition ${index} ${metric}`);
      });
    }
    if (sample.relationSizes !== undefined) {
      if (typeof sample.relationSizes !== 'object' || sample.relationSizes === null)
        throw new TypeError('Growth relation sizes must be an object');
      for (const [name, size] of Object.entries(sample.relationSizes)) {
        if (typeof size !== 'object' || size === null)
          throw new TypeError(`Growth relation size ${name} must be an object`);
        requireNonNegativeFiniteNumber(size.reltuples, `Growth relation ${name} reltuples`);
        requireNonNegativeFiniteNumber(size.relpages, `Growth relation ${name} relpages`);
      }
    }
  }
}

export function validateGrowthBound(bound: unknown, metric: string): asserts bound is Bound {
  if (bound !== 'constant' && bound !== 'logarithmic' && bound !== 'linear')
    throw new TypeError(`Unknown growth bound for ${metric}`);
}

export function validateGrowthSlack(slack: Slack, metric: GrowthMetric): void {
  if (
    !Number.isFinite(slack.absolute) ||
    slack.absolute < 0 ||
    !Number.isFinite(slack.relative) ||
    slack.relative < 0
  ) {
    throw new TypeError(`Slack for ${metric} must be finite and non-negative`);
  }
}

export function growthViolations(
  samples: readonly GrowthSample[],
  bounds: Readonly<Record<Metric, Bound>>,
  slack: Partial<Record<GrowthMetric, Slack>> = {},
): Violation[] {
  validateSamples(samples);
  const violations: Violation[] = [];
  for (const metric of METRICS) {
    const bound = bounds[metric];
    validateGrowthBound(bound, metric);
    const tolerance = slack[metric] ?? DEFAULT_SLACK[metric];
    validateGrowthSlack(tolerance, metric);
    for (let index = 0; index < samples.length - 2; index++) {
      const triple = samples.slice(index, index + 3);
      const scales = triple.map(({ scale }) => scale) as [number, number, number];
      const ratio = checkedDivide(scales[1], scales[0], 'Growth scale ratio');
      const values = triple.map(({ cost }) => cost[metric]) as [number, number, number];
      const firstStep = checkedSubtract(values[1], values[0], `First ${metric} growth step`);
      const secondStep = checkedSubtract(values[2], values[1], `Second ${metric} growth step`);
      const allowance = Math.max(
        tolerance.absolute,
        checkedMultiply(tolerance.relative, values[0], `Relative ${metric} growth slack`),
      );
      const observed =
        bound === 'constant'
          ? checkedSubtract(Math.max(values[1], values[2]), values[0], `Observed ${metric} growth`)
          : secondStep;
      const allowanceForStep =
        bound === 'constant'
          ? allowance
          : checkedAdd(
              checkedMultiply(
                bound === 'logarithmic' ? 2 : checkedMultiply(1.5, ratio, `${metric} linear scale allowance`),
                Math.max(firstStep, 0),
                `${metric} growth allowance`,
              ),
              allowance,
              `Total ${metric} growth allowance`,
            );
      const allowed = allowanceForStep;
      if (observed > allowed) violations.push({ metric, bound, scales, values, observed, allowed });
    }
  }
  return violations;
}

export function growthByteViolations(
  samples: readonly GrowthSample[],
  bounds: Readonly<Partial<Record<ByteMetric, Bound>>>,
  slack: Partial<Record<GrowthMetric, Slack>> = {},
): Violation[] {
  const metrics = (Object.keys(bounds) as ByteMetric[]).filter((metric) => bounds[metric] !== undefined);
  if (metrics.length === 0) return [];
  validateSamples(samples);
  const violations: Violation[] = [];
  for (const metric of metrics) {
    const bound = bounds[metric]!;
    validateGrowthBound(bound, metric);
    const tolerance = slack[metric] ?? DEFAULT_BYTE_SLACK[metric];
    validateGrowthSlack(tolerance, metric);
    for (const sample of samples)
      if (!Number.isFinite(sample.cost[metric]) || sample.cost[metric]! < 0)
        throw new TypeError(`Growth value for ${metric} must be finite and non-negative`);

    for (let index = 0; index < samples.length - 2; index++) {
      const triple = samples.slice(index, index + 3);
      const scales = triple.map(({ scale }) => scale) as [number, number, number];
      const ratio = checkedDivide(scales[1], scales[0], 'Growth scale ratio');
      const values = triple.map(({ cost }) => cost[metric]!) as [number, number, number];
      const firstStep = checkedSubtract(values[1], values[0], `First ${metric} growth step`);
      const secondStep = checkedSubtract(values[2], values[1], `Second ${metric} growth step`);
      const allowance = Math.max(
        tolerance.absolute,
        checkedMultiply(tolerance.relative, values[0], `Relative ${metric} growth slack`),
      );
      const observed =
        bound === 'constant'
          ? checkedSubtract(Math.max(values[1], values[2]), values[0], `Observed ${metric} growth`)
          : secondStep;
      const allowed =
        bound === 'constant'
          ? allowance
          : checkedAdd(
              checkedMultiply(
                bound === 'logarithmic' ? 2 : checkedMultiply(1.5, ratio, `${metric} linear scale allowance`),
                Math.max(firstStep, 0),
                `${metric} growth allowance`,
              ),
              allowance,
              `Total ${metric} growth allowance`,
            );
      if (observed > allowed) violations.push({ metric, bound, scales, values, observed, allowed });
    }
  }
  return violations;
}

export type AffineEnvelope = Readonly<{
  intercept: number;
  slope: number;
  predicted: readonly number[];
  residuals: readonly number[];
  maxResidual: number;
}>;

export type EngineWorkClass = 'affine' | 'packing' | 'plan-transition' | 'background';

export type EngineWorkClassification = Readonly<{
  envelope: AffineEnvelope;
  packing: readonly string[];
  planTransitions: readonly string[];
  backgroundGrew: boolean;
  class: EngineWorkClass;
  samples: readonly GrowthSample[];
}>;

function packingDiagnostics(samples: readonly GrowthSample[]): string[] {
  const first = samples[0];
  const last = samples.at(-1);
  const firstSizes = first?.relationSizes;
  const lastSizes = last?.relationSizes;
  if (!first || !last || !firstSizes || !lastSizes) return [];
  return Object.entries(firstSizes)
    .flatMap(([name, size]) => {
      const lastSize = lastSizes[name];
      if (!lastSize || size.relpages <= 0 || lastSize.relpages <= 0) return [];
      const firstDensity = size.reltuples / size.relpages;
      const lastDensity = lastSize.reltuples / lastSize.relpages;
      if (!(lastDensity > firstDensity * 1.25) && !(firstDensity > lastDensity * 1.25)) return [];
      return [
        `${formatRelationName(name)} ${lastDensity > firstDensity ? 'heap packing' : 'page expansion'} (${firstDensity.toFixed(1)} to ${lastDensity.toFixed(1)} tuples/page)`,
      ];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function planTransitionDiagnostics(samples: readonly GrowthSample[]): string[] {
  return samples.flatMap(({ scale, cost }, index) => {
    if (index === 0) return [];
    const previous = samples[index - 1]!;
    return Object.entries(cost.relations ?? {}).flatMap(([name, relation]) => {
      const before = previous.cost.relations?.[name]?.sequentialScans ?? 0;
      const after = relation.sequentialScans ?? 0;
      if (before === after) return [];
      return [
        `${formatRelationName(name)} sequential scans ${before} at scale ${previous.scale} to ${after} at scale ${scale}`,
      ];
    });
  });
}

function backgroundGrew(samples: readonly GrowthSample[]): boolean {
  if (samples.length === 0) return false;
  const firstStatements = samples[0]!.cost.backgroundStatements ?? 0;
  return samples.slice(1).some((sample) => (sample.cost.backgroundStatements ?? 0) > firstStatements);
}

/**
 * Fit intercept+slope without changing the linear family. Packing, plan transitions and
 * background growth stay visible diagnostics; they do not reprice rows or statements.
 */
export function classifyEngineWork(
  samples: readonly GrowthSample[],
  metric: Metric = 'blocks',
): EngineWorkClassification {
  validateSamples(samples);
  const scales = samples.map((sample) => sample.scale);
  const values = samples.map((sample) => sample.cost[metric]);
  const envelope = affineEnvelope(scales, values);
  const packing = packingDiagnostics(samples);
  const planTransitions = planTransitionDiagnostics(samples);
  const background = backgroundGrew(samples);
  const className: EngineWorkClass = background
    ? 'background'
    : planTransitions.length > 0
      ? 'plan-transition'
      : packing.length > 0 && envelope.maxResidual > 0
        ? 'packing'
        : 'affine';
  return {
    envelope,
    packing,
    planTransitions,
    backgroundGrew: background,
    class: className,
    samples,
  };
}

/** Least-squares a + b·x envelope with a ≥ 0, b ≥ 0. Packing or a plan floor shows up as a residual, not a new family. */
export function affineEnvelope(scales: readonly number[], values: readonly number[]): AffineEnvelope {
  requireDenseArray(scales, 'Affine envelope scales');
  requireDenseArray(values, 'Affine envelope values');
  if (scales.length !== values.length || scales.length < 2)
    throw new TypeError('Affine envelope needs paired scales and values');
  for (const [index, scale] of scales.entries()) {
    requireNonNegativeFiniteNumber(scale, `Affine envelope scale ${index}`);
    requireNonNegativeFiniteNumber(values[index]!, `Affine envelope value ${index}`);
  }
  const count = scales.length;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < count; index += 1) {
    sumX = checkedAdd(sumX, scales[index]!, 'Affine envelope scale total');
    sumY = checkedAdd(sumY, values[index]!, 'Affine envelope value total');
  }
  const meanX = checkedDivide(sumX, count, 'Affine envelope mean scale');
  const meanY = checkedDivide(sumY, count, 'Affine envelope mean value');
  let variance = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = checkedSubtract(scales[index]!, meanX, 'Affine envelope scale difference');
    const dy = checkedSubtract(values[index]!, meanY, 'Affine envelope value difference');
    variance = checkedAdd(variance, checkedMultiply(dx, dx, 'Affine envelope variance term'), 'Affine envelope variance');
    covariance = checkedAdd(
      covariance,
      checkedMultiply(dx, dy, 'Affine envelope covariance term'),
      'Affine envelope covariance',
    );
  }
  const slope = variance === 0 ? 0 : Math.max(0, checkedDivide(covariance, variance, 'Affine envelope slope'));
  const intercept = Math.max(
    0,
    checkedSubtract(meanY, checkedMultiply(slope, meanX, 'Affine envelope fitted mean'), 'Affine envelope intercept'),
  );
  const predicted = scales.map((scale) =>
    checkedAdd(intercept, checkedMultiply(slope, scale, 'Affine envelope prediction term'), 'Affine envelope prediction'),
  );
  const residuals = values.map((value, index) =>
    checkedSubtract(value, predicted[index]!, 'Affine envelope residual'),
  );
  return {
    intercept,
    slope,
    predicted,
    residuals,
    maxResidual: Math.max(0, ...residuals.map(Math.abs)),
  };
}

const MAX_DIAGNOSTIC_ITEMS = 5;
const MAX_DIAGNOSTIC_VIOLATIONS = 15;
const MAX_RELATION_NAME_LENGTH = 80;

function formatLimited(items: readonly string[]): string {
  const shown = items.slice(0, MAX_DIAGNOSTIC_ITEMS);
  const omitted = items.length - shown.length;
  return `${shown.join(', ')}${omitted > 0 ? `, ${omitted} more omitted` : ''}`;
}

function formatRelationName(name: string): string {
  const safeName = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  return safeName.length > MAX_RELATION_NAME_LENGTH ? `${safeName.slice(0, MAX_RELATION_NAME_LENGTH - 1)}…` : safeName;
}

function formatRelationContext(samples: readonly GrowthSample[]): string[] {
  const lines = samples.flatMap(({ scale, cost }) => {
    const entries = Object.entries(cost.relations ?? {});
    if (entries.length === 0) return [];
    const rows = entries.toSorted((left, right) => right[1].rows - left[1].rows);
    const blocks = entries.toSorted((left, right) => right[1].blocks - left[1].blocks);
    const sequentialScans = entries
      .filter(([, relation]) => (relation.sequentialScans ?? 0) > 0)
      .toSorted((left, right) => right[1].rows - left[1].rows);
    return [
      `Scale ${scale} largest relations by rows: ${formatLimited(rows.map(([name, relation]) => `${formatRelationName(name)} (${relation.rows} rows)`))}`,
      `Scale ${scale} largest relations by blocks: ${formatLimited(blocks.map(([name, relation]) => `${formatRelationName(name)} (${relation.blocks} blocks)`))}`,
      ...(sequentialScans.length > 0
        ? [
            `Scale ${scale} Sequential scans: ${formatLimited(sequentialScans.map(([name, relation]) => `${formatRelationName(name)} (${relation.rows} rows)`))} (a sequential scan may be a planner's choice for a small relation; use measured relation pages for the path guard; the growth bounds still apply)`,
          ]
        : []),
    ];
  });

  const first = samples[0];
  const last = samples.at(-1);
  const firstSizes = first?.relationSizes;
  const lastSizes = last?.relationSizes;
  if (!first || !last || !firstSizes || !lastSizes) return lines;
  const nonGrowing = Object.entries(firstSizes)
    .flatMap(([name, size]) => {
      const lastSize = lastSizes[name];
      return lastSize && lastSize.reltuples <= size.reltuples
        ? [[name, size.reltuples, lastSize.reltuples] as const]
        : [];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (nonGrowing.length > 0)
    lines.push(
      `Relations whose reltuples did not grow from scale ${first.scale} to ${last.scale}: ${formatLimited(nonGrowing.map(([name, initial, final]) => `${formatRelationName(name)} (${initial} to ${final})`))}`,
    );
  const packing = Object.entries(firstSizes)
    .flatMap(([name, size]) => {
      const lastSize = lastSizes[name];
      if (!lastSize || size.relpages <= 0 || lastSize.relpages <= 0) return [];
      const firstDensity = size.reltuples / size.relpages;
      const lastDensity = lastSize.reltuples / lastSize.relpages;
      if (!(lastDensity > firstDensity * 1.25) && !(firstDensity > lastDensity * 1.25)) return [];
      return [
        [
          name,
          firstDensity,
          lastDensity,
          lastDensity > firstDensity ? 'heap packing' : 'page expansion',
        ] as const,
      ];
    })
    .toSorted(([left], [right]) => left.localeCompare(right));
  if (packing.length > 0)
    lines.push(
      `Physical packing from scale ${first.scale} to ${last.scale}: ${formatLimited(packing.map(([name, firstDensity, lastDensity, kind]) => `${formatRelationName(name)} ${kind} (${firstDensity.toFixed(1)} to ${lastDensity.toFixed(1)} tuples/page)`))}`,
    );
  const planTransitions = samples.flatMap(({ scale, cost }, index) => {
    if (index === 0) return [];
    const previous = samples[index - 1]!;
    return Object.entries(cost.relations ?? {}).flatMap(([name, relation]) => {
      const before = previous.cost.relations?.[name]?.sequentialScans ?? 0;
      const after = relation.sequentialScans ?? 0;
      if (before === after) return [];
      return [
        `${formatRelationName(name)} sequential scans ${before} at scale ${previous.scale} to ${after} at scale ${scale}`,
      ];
    });
  });
  if (planTransitions.length > 0)
    lines.push(`Plan transitions: ${formatLimited(planTransitions)} (the growth bounds still apply)`);
  return lines;
}

function formatRepetitionContext(metric: GrowthMetric, samples: readonly GrowthSample[]): string[] {
  if (!samples.some(({ repetitions }) => repetitions !== undefined)) return [];
  return samples.map(({ scale, repetitions }) => {
    if (repetitions === undefined) return `Scale ${scale} ${metric} repetitions: not recorded`;
    const shown = repetitions.slice(0, MAX_DIAGNOSTIC_ITEMS).map((cost) => String(cost[metric] ?? 'n/a'));
    const omitted = repetitions.length - shown.length;
    return `Scale ${scale} ${metric} repetitions: [${shown.join(', ')}${omitted > 0 ? `, ${omitted} more omitted` : ''}]`;
  });
}

function formatGrowthValue(value: number): string {
  return `${value >= 0 ? '+' : ''}${value}`;
}

function formatViolation({ metric, bound, scales, values, observed, allowed }: Violation): string {
  const window = `window scales ${scales.join(', ')} values ${values.join(', ')}`;
  if (bound === 'constant') {
    const peak = Math.max(values[1], values[2]);
    const peakScales = [values[1] === peak ? scales[1] : undefined, values[2] === peak ? scales[2] : undefined]
      .filter((scale): scale is number => scale !== undefined)
      .join(' and ');
    return `${metric} constant bound failed in ${window}: maximum ${peak} at scale ${peakScales} minus baseline ${values[0]}; observed ${formatGrowthValue(observed)} exceeds allowed ${formatGrowthValue(allowed)}`;
  }
  return `${metric} ${bound} bound failed in ${window}: second step from scale ${scales[1]} to ${scales[2]}; observed ${formatGrowthValue(observed)} exceeds allowed ${formatGrowthValue(allowed)}`;
}

function formatMessage(violations: readonly Violation[], samples: readonly GrowthSample[]): string {
  const visible = violations.slice(0, MAX_DIAGNOSTIC_VIOLATIONS);
  const blocks = visible.map((violation) => {
    const window = violation.scales.flatMap((scale) => {
      const sample = samples.find((candidate) => candidate.scale === scale);
      return sample ? [sample] : [];
    });
    return [
      formatViolation(violation),
      ...formatRepetitionContext(violation.metric, window),
      ...formatRelationContext(window),
    ].join('\n');
  });
  const omitted = violations.length - visible.length;
  if (omitted > 0) blocks.push(`${omitted} additional growth violations omitted`);
  return blocks.join('\n\n');
}

export function assertGrowth(
  samples: readonly GrowthSample[],
  bounds: Readonly<Record<Metric, Bound>>,
  slack?: Partial<Record<GrowthMetric, Slack>>,
): void {
  const violations = growthViolations(samples, bounds, slack);
  if (violations.length > 0) throw new GrowthBoundError(violations, samples);
}
