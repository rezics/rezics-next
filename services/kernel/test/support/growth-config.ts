import { GROWTH_BASELINE } from './growth-baseline.ts';
import {
  validateGrowthBound,
  validateGrowthSlack,
  type Bound,
  type ByteMetric,
  type GrowthMetric,
  type Metric,
  type Slack,
} from './growth-bound.ts';
import { validateCountedConfig, type CountedCheck } from './growth-counters.ts';

const METRICS = ['rows', 'blocks', 'statements'] as const;
const BYTE_METRICS = ['requestBytes', 'responseBytes'] as const;

type GrowthScales =
  | readonly [number, number, number]
  | readonly [number, number, number, number]
  | readonly [number, number, number, number, number];

export type GrowthCheckConfiguration = {
  readonly name: string;
  readonly scales?: GrowthScales;
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>;
  readonly rule?: 'step' | 'series';
  readonly slack?: Partial<Record<GrowthMetric, Slack>>;
  readonly indexProbes?: number;
  readonly counted?: CountedCheck;
  readonly attempts?: { readonly commands: number };
  readonly repetitions?: number;
  readonly warmups?: number;
};

export type AdmittedGrowthCheck = {
  readonly name: string;
  readonly scales: GrowthScales;
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>;
  readonly rule: 'step' | 'series';
  readonly slack?: Readonly<Partial<Record<GrowthMetric, Slack>>>;
  readonly indexProbes?: number;
  readonly counted?: CountedCheck;
  readonly attempts?: { readonly commands: number };
  readonly repetitions: number;
  readonly warmups: number;
};

function freezeSlack(slack: Slack): Slack {
  return Object.freeze({ absolute: slack.absolute, relative: slack.relative });
}

function wrap(name: string, field: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new TypeError(`${name}: ${field}: ${message}`);
}

/** Snapshot a complete growth-check configuration before grow, warmup or operation. */
export function admitGrowthCheck(check: GrowthCheckConfiguration): AdmittedGrowthCheck {
  const growthRule = process.env.GROWTH_RULE;
  if (growthRule !== undefined && growthRule !== 'series')
    throw new TypeError(`${check.name}: GROWTH_RULE must be 'series' when set`);
  const listed = GROWTH_BASELINE.some(({ name }) => name === check.name);
  if (listed && check.rule !== undefined)
    throw new TypeError(`${check.name}: listed checks must not set rule in growth-baseline.ts`);
  const rule = check.rule ?? (growthRule === 'series' || !listed ? 'series' : 'step');
  const scales = check.scales ?? [1, 8, 64];
  const repetitions = check.repetitions ?? 5;
  const warmups = check.warmups ?? 1;
  if (check.attempts) {
    if (!Number.isSafeInteger(check.attempts.commands) || check.attempts.commands <= 0)
      throw new TypeError(`${check.name}: attempts.commands must be a positive safe integer`);
  }
  if (check.indexProbes !== undefined) {
    if (!Number.isSafeInteger(check.indexProbes) || check.indexProbes <= 0)
      throw new TypeError(`${check.name}: indexProbes must be a positive safe integer`);
    if (check.bounds.blocks === 'constant')
      throw new TypeError(`${check.name}: indexProbes cannot be used with a constant blocks bound`);
  }
  if (check.counted) {
    try {
      validateCountedConfig(check.counted);
    } catch (error) {
      wrap(check.name, 'counted', error);
    }
  }
  if (scales.length < 3 || scales.length > 5)
    throw new TypeError(`${check.name}: scales: Growth checks require three to five scales`);
  const [first, second] = scales;
  const firstRatio = second / first;
  if (
    scales.some(
      (scale, index) =>
        !Number.isFinite(scale) || scale <= 0 || scale > 4096 || (index > 0 && scale <= scales[index - 1]!),
    ) ||
    firstRatio < 4 ||
    scales.slice(2).some((scale, index) => {
      const ratio = scale / scales[index + 1]!;
      return Math.abs(firstRatio - ratio) / Math.max(firstRatio, ratio) >= 1e-9;
    })
  ) {
    throw new TypeError(
      `${check.name}: scales: Growth scales must be positive, increasing and equally spaced by a ratio of at least four, with a largest scale no greater than 4096`,
    );
  }
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new RangeError(`${check.name}: repetitions: Growth repetitions must be a positive safe integer`);
  if (!Number.isSafeInteger(warmups) || warmups < 1)
    throw new RangeError(
      `${check.name}: warmups: Growth warmups must be a positive safe integer; use the warmup hook for consumable state`,
    );

  const bounds = {} as Record<Metric, Bound>;
  for (const metric of METRICS) {
    try {
      validateGrowthBound(check.bounds[metric], metric);
    } catch (error) {
      wrap(check.name, `bounds.${metric}`, error);
    }
    bounds[metric] = check.bounds[metric];
  }

  let byteBounds: Partial<Record<ByteMetric, Bound>> | undefined;
  if (check.byteBounds !== undefined) {
    if (typeof check.byteBounds !== 'object' || check.byteBounds === null)
      throw new TypeError(`${check.name}: byteBounds: optional byte bounds must be an object`);
    byteBounds = {};
    for (const key of Object.keys(check.byteBounds)) {
      if (!BYTE_METRICS.includes(key as ByteMetric))
        wrap(check.name, `byteBounds.${key}`, new TypeError(`Unknown growth bound for ${key}`));
    }
    for (const metric of BYTE_METRICS) {
      const bound = check.byteBounds[metric];
      if (bound === undefined) continue;
      try {
        validateGrowthBound(bound, metric);
      } catch (error) {
        wrap(check.name, `byteBounds.${metric}`, error);
      }
      byteBounds[metric] = bound;
    }
  }

  let slack: Partial<Record<GrowthMetric, Slack>> | undefined;
  if (check.slack !== undefined) {
    if (typeof check.slack !== 'object' || check.slack === null)
      throw new TypeError(`${check.name}: slack: Slack must be an object`);
    slack = {};
    for (const metric of [...METRICS, ...BYTE_METRICS]) {
      const value = check.slack[metric];
      if (value === undefined) continue;
      try {
        validateGrowthSlack(value, metric);
      } catch (error) {
        wrap(check.name, `slack.${metric}`, error);
      }
      slack[metric] = freezeSlack(value);
    }
  }

  return Object.freeze({
    name: check.name,
    scales: Object.freeze(scales.slice()) as unknown as GrowthScales,
    bounds: Object.freeze(bounds),
    rule,
    repetitions,
    warmups,
    ...(byteBounds === undefined ? {} : { byteBounds: Object.freeze(byteBounds) }),
    ...(slack === undefined ? {} : { slack: Object.freeze(slack) }),
    ...(check.indexProbes === undefined ? {} : { indexProbes: check.indexProbes }),
    ...(check.counted === undefined
      ? {}
      : {
          counted: Object.freeze({
            read: check.counted.read,
            ...(check.counted.limits === undefined ? {} : { limits: Object.freeze({ ...check.counted.limits }) }),
            ...(check.counted.bounds === undefined ? {} : { bounds: Object.freeze({ ...check.counted.bounds }) }),
            ...(check.counted.slack === undefined
              ? {}
              : {
                  slack: Object.freeze(
                    Object.fromEntries(
                      Object.entries(check.counted.slack).map(([name, value]) => [name, freezeSlack(value)]),
                    ),
                  ),
                }),
          }),
        }),
    ...(check.attempts === undefined ? {} : { attempts: Object.freeze({ commands: check.attempts.commands }) }),
  });
}
