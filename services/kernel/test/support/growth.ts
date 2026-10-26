import { assertGrowth, GrowthBoundError, type Bound, type Metric, type Slack } from './growth-bound.ts';
import { capture, type GrowthDatabase } from './growth-capture.ts';
import { catalogStatementBound, costOf, medianCost, type Cost } from './growth-cost.ts';

export * from './growth-cost.ts';
export * from './growth-bound.ts';
export { openGrowthDatabase, capture, type GrowthDatabase } from './growth-capture.ts';
export * from './growth-seed.ts';

export function measure<T>(db: GrowthDatabase, operation: () => Promise<T>): Promise<{ value: T; cost: Cost }> {
  return capture(db, operation).then(({ value, capture: raw }) => ({ value, cost: costOf(raw) }));
}

export type GrowthCheck = {
  readonly name: string;
  readonly scales?: readonly [number, number, number]; // default [1, 8, 64]
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly slack?: Partial<Record<Metric, Slack>>;
  readonly repetitions?: number; // measured runs per scale, default 5; the sample is their medianCost
  /**
   * Unmeasured runs per scale, after `grow` and before the measured runs, default 1. Calls `warmup` when given,
   * otherwise `operation`.
   */
  readonly warmups?: number;
  /**
   * Grows the data from the previous scale (0 before the first) to this one, normally with seed(). After each call,
   * checkGrowth runs database-wide `VACUUM (ANALYZE)` before the scale's first unmeasured run.
   */
  grow(db: GrowthDatabase, scale: number, previous: number): Promise<void>;
  /**
   * One measured run of the operation. `repetition` counts from 0 across all scales and unmeasured runs, shared
   * with `warmup`, for fresh keys.
   */
  operation(db: GrowthDatabase, scale: number, repetition: number): Promise<unknown>;
  /** One unmeasured run of the same code path on spare state, used for warm-ups in place of `operation`. */
  warmup?(db: GrowthDatabase, scale: number, repetition: number): Promise<unknown>;
};

export type GrowthReport = {
  readonly name: string;
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly samples: readonly { readonly scale: number; readonly cost: Cost }[];
};

function assertCatalogBound(
  name: string,
  scale: number,
  captureResult: Parameters<typeof catalogStatementBound>[0],
  samples: readonly { readonly scale: number; readonly cost: Cost }[],
): void {
  const { catalogStatements, allowedStatements, firstCatalogStatement } = catalogStatementBound(captureResult);
  if (catalogStatements <= allowedStatements) return;
  const error = new GrowthBoundError([], samples);
  error.message = `${name}: catalog count at scale ${scale} (${catalogStatements}) exceeds allowed count ${allowedStatements}; first catalog statement: ${firstCatalogStatement?.slice(0, 120) ?? '<unknown>'}`;
  throw error;
}

/** Resolves with the report, or rejects with GrowthBoundError (message prefixed by the check name). */
export async function checkGrowth(db: GrowthDatabase, check: GrowthCheck): Promise<GrowthReport> {
  const scales = check.scales ?? [1, 8, 64];
  const repetitions = check.repetitions ?? 5;
  const warmups = check.warmups ?? 1;
  if (scales.length !== 3) throw new TypeError('Growth checks require exactly three scales');
  const [first, second, third] = scales;
  const firstRatio = second / first;
  const secondRatio = third / second;
  if (
    scales.some((scale) => !Number.isFinite(scale) || scale <= 0) ||
    !(first < second && second < third) ||
    firstRatio < 4 ||
    Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio) >= 1e-9
  ) {
    throw new TypeError('Growth scales must be positive, increasing and equally spaced by a ratio of at least four');
  }
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new RangeError('Growth repetitions must be a positive safe integer');
  if (!Number.isSafeInteger(warmups) || warmups < 0)
    throw new RangeError('Growth warmups must be a non-negative safe integer');

  let previous = 0;
  let repetition = 0;
  const samples: Array<{ readonly scale: number; readonly cost: Cost }> = [];
  for (const scale of scales) {
    await check.grow(db, scale, previous);
    await db.admin.query('VACUUM (ANALYZE)');
    for (let warmup = 0; warmup < warmups; warmup++) {
      if (check.warmup) await check.warmup(db, scale, repetition);
      else await check.operation(db, scale, repetition);
      repetition++;
    }

    const costs: Cost[] = [];
    for (let run = 0; run < repetitions; run++) {
      const measured = await capture(db, () => check.operation(db, scale, repetition));
      const cost = costOf(measured.capture);
      assertCatalogBound(check.name, scale, measured.capture, samples);
      costs.push(cost);
      repetition++;
    }
    samples.push({ scale, cost: medianCost(costs) });
    previous = scale;
  }

  try {
    assertGrowth(samples, check.bounds, check.slack);
  } catch (error) {
    if (error instanceof Error && error.name === 'GrowthBoundError') {
      error.message = `${check.name}: ${error.message}`;
    }
    throw error;
  }

  return { name: check.name, bounds: check.bounds, samples };
}
