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
  readonly relations?: Readonly<Record<string, { readonly rows: number; readonly blocks: number }>>;
};
export type GrowthSample = { readonly scale: number; readonly cost: Measured };
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

const METRICS: readonly Metric[] = ['rows', 'blocks', 'statements'];

function validateSamples(
  samples: readonly GrowthSample[],
): asserts samples is readonly [GrowthSample, GrowthSample, GrowthSample] {
  if (samples.length !== 3) throw new TypeError('Growth checks require exactly three samples');
  const [first, second, third] = samples;
  if (!first || !second || !third) throw new TypeError('Growth checks require exactly three samples');
  const scales = [first.scale, second.scale, third.scale];
  if (
    scales.some((scale) => !Number.isFinite(scale) || scale <= 0) ||
    !(scales[0]! < scales[1]! && scales[1]! < scales[2]!)
  ) {
    throw new TypeError('Growth scales must be finite, positive and strictly increasing');
  }
  const firstRatio = scales[1]! / scales[0]!;
  const secondRatio = scales[2]! / scales[1]!;
  if (firstRatio < 4 || Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio) >= 1e-9) {
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
  const scales = samples.map(({ scale }) => scale) as [number, number, number];
  const ratio = scales[1] / scales[0];
  const violations: Violation[] = [];
  for (const metric of METRICS) {
    const bound = bounds[metric];
    if (bound !== 'constant' && bound !== 'logarithmic' && bound !== 'linear')
      throw new TypeError(`Unknown growth bound for ${metric}`);
    const tolerance = slack[metric] ?? DEFAULT_SLACK[metric];
    validateSlack(tolerance, metric);
    const values = samples.map(({ cost }) => cost[metric]) as [number, number, number];
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
  return violations;
}

function formatRelations(samples: readonly GrowthSample[]): string[] {
  const relations = samples[2]?.cost.relations;
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
  return lines;
}

function formatMessage(violations: readonly Violation[], samples: readonly GrowthSample[]): string {
  const lines = violations.map(
    ({ metric, bound, scales, values, observed, allowed }) =>
      `${metric} grows beyond ${bound}: ${values.join(', ')} at scales ${scales.join(', ')}; second step +${observed} exceeds allowed +${allowed}`,
  );
  return [...lines, ...formatRelations(samples)].join('\n');
}

export function assertGrowth(
  samples: readonly GrowthSample[],
  bounds: Readonly<Record<Metric, Bound>>,
  slack?: Partial<Record<Metric, Slack>>,
): void {
  const violations = growthViolations(samples, bounds, slack);
  if (violations.length > 0) throw new GrowthBoundError(violations, samples);
}
