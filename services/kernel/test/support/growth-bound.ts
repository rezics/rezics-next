export type Metric = 'rows' | 'blocks' | 'statements';
export type Bound = 'constant' | 'logarithmic' | 'linear';
export type Slack = { readonly absolute: number; readonly relative: number };
export const DEFAULT_SLACK: Readonly<Record<Metric, Slack>> = {
  rows: { absolute: 2, relative: 0.1 },
  blocks: { absolute: 4, relative: 0.5 },
  statements: { absolute: 0, relative: 0 },
};

/** Structural, so the harness's Cost type is assignable without an import. */
export type Measured = Readonly<Record<Metric, number>> & {
  readonly relations?: Readonly<
    Record<string, { readonly rows: number; readonly blocks: number; readonly sequentialScans?: number }>
  >;
};
export type RelationSize = { readonly reltuples: number; readonly relpages: number };
export type GrowthSample = {
  readonly scale: number;
  readonly cost: Measured;
  readonly repetitions?: readonly Readonly<Record<Metric, number>>[];
  readonly relationSizes?: Readonly<Record<string, RelationSize>>;
};
export type Violation = {
  readonly metric: Metric;
  readonly bound: Bound;
  readonly scales: readonly [number, number, number];
  readonly values: readonly [number, number, number];
  readonly observed: number;
  readonly allowed: number;
};

export class GrowthBoundError extends Error {
  readonly violations: readonly Violation[];
  readonly samples: readonly GrowthSample[];

  constructor(violations: readonly Violation[], samples: readonly GrowthSample[]) {
    super(formatMessage(violations, samples));
    this.name = 'GrowthBoundError';
    this.violations = violations;
    this.samples = samples;
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
  if (samples.length < 3 || samples.length > 5) throw new TypeError('Growth checks require three to five samples');
  const scales = samples.map(({ scale }) => scale);
  if (
    scales.some((scale, index) => !Number.isFinite(scale) || scale <= 0 || (index > 0 && scale <= scales[index - 1]!))
  ) {
    throw new TypeError('Growth scales must be finite, positive and strictly increasing');
  }
  if (scales.at(-1)! > 4096) throw new TypeError('The largest growth scale must be no greater than 4096');
  const firstRatio = scales[1]! / scales[0]!;
  if (
    firstRatio < 4 ||
    scales.slice(2).some((scale, index) => {
      const ratio = scale / scales[index + 1]!;
      return Math.abs(firstRatio - ratio) / Math.max(firstRatio, ratio) >= 1e-9;
    })
  ) {
    throw new TypeError('Growth scales must have equal ratios of at least four');
  }
  for (const sample of samples) {
    for (const metric of METRICS) {
      if (!Number.isFinite(sample.cost[metric])) throw new TypeError(`Growth value for ${metric} must be finite`);
    }
  }
}

function validateSlack(slack: Slack, metric: Metric): void {
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
  slack: Partial<Record<Metric, Slack>> = {},
): Violation[] {
  validateSamples(samples);
  const violations: Violation[] = [];
  for (const metric of METRICS) {
    const bound = bounds[metric];
    if (bound !== 'constant' && bound !== 'logarithmic' && bound !== 'linear')
      throw new TypeError(`Unknown growth bound for ${metric}`);
    const tolerance = slack[metric] ?? DEFAULT_SLACK[metric];
    validateSlack(tolerance, metric);
    for (let index = 0; index < samples.length - 2; index++) {
      const triple = samples.slice(index, index + 3);
      const scales = triple.map(({ scale }) => scale) as [number, number, number];
      const ratio = scales[1] / scales[0];
      const values = triple.map(({ cost }) => cost[metric]) as [number, number, number];
      const firstStep = values[1] - values[0];
      const secondStep = values[2] - values[1];
      const allowance = Math.max(tolerance.absolute, tolerance.relative * values[0]);
      const observed = bound === 'constant' ? Math.max(values[1], values[2]) - values[0] : secondStep;
      const allowed =
        bound === 'constant'
          ? allowance
          : (bound === 'logarithmic' ? 2 : 1.5 * ratio) * Math.max(firstStep, 0) + allowance;
      if (observed > allowed) violations.push({ metric, bound, scales, values, observed, allowed });
    }
  }
  return violations;
}

function formatRelations(samples: readonly GrowthSample[]): string[] {
  const relations = samples.at(-1)?.cost.relations;
  if (!relations) return [];
  const entries = Object.entries(relations);
  const rows = entries.toSorted((left, right) => right[1].rows - left[1].rows).slice(0, 5);
  const blocks = entries.toSorted((left, right) => right[1].blocks - left[1].blocks).slice(0, 5);
  const lines: string[] = [];
  if (rows.length > 0)
    lines.push(`Largest relations by rows: ${rows.map(([name, cost]) => `${name} (${cost.rows} rows)`).join(', ')}`);
  if (blocks.length > 0)
    lines.push(
      `Largest relations by blocks: ${blocks.map(([name, cost]) => `${name} (${cost.blocks} blocks)`).join(', ')}`,
    );
  const sequentialScans = entries
    .filter(([, cost]) => (cost.sequentialScans ?? 0) > 0)
    .toSorted((left, right) => right[1].rows - left[1].rows);
  if (sequentialScans.length > 0)
    lines.push(
      `Sequential scans: ${sequentialScans.map(([name, cost]) => `${name} (${cost.rows} rows)`).join(', ')} (a sequential scan of a small relation is the planner's choice; seed every relation the operation reads to thousands of rows at the smallest scale)`,
    );
  const firstSizes = samples[0]?.relationSizes;
  const lastSizes = samples.at(-1)?.relationSizes;
  if (firstSizes && lastSizes) {
    const nonGrowing = Object.entries(firstSizes)
      .flatMap(([name, first]) => {
        const last = lastSizes[name];
        return last && last.reltuples <= first.reltuples ? [[name, first.reltuples, last.reltuples] as const] : [];
      })
      .toSorted(([left], [right]) => left.localeCompare(right));
    if (nonGrowing.length > 0)
      lines.push(
        `Relations whose reltuples did not grow: ${nonGrowing.map(([name, first, last]) => `${name} (${first} to ${last})`).join(', ')}`,
      );
  }
  return lines;
}

function formatMessage(violations: readonly Violation[], samples: readonly GrowthSample[]): string {
  const lines = violations.map(
    ({ metric, bound, scales, values, observed, allowed }) =>
      `${metric} grows beyond ${bound}: ${values.join(', ')} at scales ${scales.join(', ')}; second step +${observed} exceeds allowed +${allowed}`,
  );
  const repetitionLines = violations.flatMap(({ metric }) => {
    if (!samples.some(({ repetitions }) => repetitions !== undefined)) return [];
    const byScale = samples.map(
      ({ scale, repetitions }) => `${scale} [${repetitions?.map((cost) => cost[metric]).join(', ') ?? ''}]`,
    );
    return [`${metric} repetitions by scale: ${byScale.join(', ')}`];
  });
  return [...lines, ...repetitionLines, ...formatRelations(samples)].join('\n');
}

export function assertGrowth(
  samples: readonly GrowthSample[],
  bounds: Readonly<Record<Metric, Bound>>,
  slack?: Partial<Record<Metric, Slack>>,
): void {
  const violations = growthViolations(samples, bounds, slack);
  if (violations.length > 0) throw new GrowthBoundError(violations, samples);
}
