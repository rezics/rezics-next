import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  assertGrowth,
  DEFAULT_SLACK,
  GrowthBoundError,
  type Bound,
  type Metric,
  type RelationSize,
  type Slack,
} from './growth-bound.ts';
import { capture, trackGrow, type GrowthDatabase } from './growth-capture.ts';
import {
  catalogStatementBound,
  costOf,
  medianCost,
  withoutCatalogTexts,
  type Capture,
  type Cost,
} from './growth-cost.ts';

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
   * otherwise `operation`. Must be a positive safe integer; use the `warmup` hook for consumable state.
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

/** What growing the data to a scale cost: the statements and written rows of `grow`, and the time of `grow` and of the vacuum after it. */
export type SeedingCost = {
  readonly statements: number;
  readonly rowsWritten: number;
  readonly growMs: number;
  readonly vacuumMs: number;
};

export type ReportSample = {
  readonly scale: number;
  readonly cost: Cost;
  readonly repetitions: readonly Cost[];
  readonly relationSizes: Readonly<Record<string, RelationSize>>;
  readonly seeding: SeedingCost;
};

export type GrowthReport = {
  readonly name: string;
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly samples: readonly ReportSample[];
};

let profileWarned = false;

/** Appends one line per check to the file named by GROWTH_PROFILE; a failure warns once and never fails the check. */
function appendProfile(name: string, scales: readonly number[], samples: readonly ReportSample[]): void {
  const path = process.env.GROWTH_PROFILE;
  if (!path) return;
  try {
    const file = relative(process.cwd(), Bun.main);
    const line = JSON.stringify({ file, check: name, scales, seeding: samples.map(({ seeding }) => seeding) });
    appendFileSync(path, `${line}\n`);
  } catch (error) {
    if (profileWarned) return;
    profileWarned = true;
    console.warn(`GROWTH_PROFILE ${path} was not written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCatalogBound(
  name: string,
  scale: number | undefined,
  captureResult: Capture,
  samples: readonly { readonly scale: number; readonly cost: Cost }[],
): ReadonlySet<string> {
  const { catalogTexts, catalogStatements, allowedStatements, firstCatalogStatement } =
    catalogStatementBound(captureResult);
  if (catalogStatements <= allowedStatements) return catalogTexts;
  const error = new GrowthBoundError([], samples);
  const where = scale === undefined ? '' : ` at scale ${scale}`;
  error.message = `${name}: catalog count${where} (${catalogStatements}) exceeds allowed count ${allowedStatements}; first catalog statement: ${firstCatalogStatement?.slice(0, 120) ?? '<unknown>'}`;
  throw error;
}

function assertBackgroundBound(name: string, samples: readonly ReportSample[]): void {
  const statements = new Set(
    samples.flatMap(({ cost }) =>
      Object.entries(cost.backgroundCosts ?? {})
        .filter(([, value]) => value.bounded)
        .map(([statement]) => statement),
    ),
  );
  const failures: { statement: string; rows: number; metric: 'rows' | 'blocks'; values: number[]; allowed: number }[] =
    [];
  for (const statement of statements) {
    const observed: { scale: number; rows: number; blocks: number }[] = [];
    for (const sample of samples) {
      const cost = sample.cost.backgroundCosts?.[statement];
      if (cost) observed.push({ scale: sample.scale, rows: cost.rows, blocks: cost.blocks });
    }
    if (observed.length < 2) continue;
    for (const metric of ['rows', 'blocks'] as const) {
      const first = observed[0]![metric];
      const last = observed.at(-1)![metric];
      const tolerance = DEFAULT_SLACK[metric];
      const allowed = Math.max(tolerance.absolute, tolerance.relative * first);
      if (last - first > allowed)
        failures.push({
          statement,
          rows: observed.at(-1)!.rows,
          metric,
          values: observed.map((item) => item[metric]),
          allowed,
        });
    }
  }
  if (failures.length === 0) return;
  failures.sort((left, right) => right.rows - left.rows);
  const largest = failures[0]!;
  const error = new GrowthBoundError([], samples);
  error.message = `${name}: background statement with largest rows: ${largest.statement.slice(0, 160)}; ${largest.metric} per statement grows from ${largest.values[0]} to ${largest.values.at(-1)} beyond default slack ${largest.allowed}`;
  throw error;
}

async function readRelationSizes(db: GrowthDatabase): Promise<Readonly<Record<string, RelationSize>>> {
  const result = await db.admin.query<{ name: string; reltuples: number; relpages: number }>(
    `SELECT CASE WHEN c.relkind IN ('i', 'I') THEN 'index:' || c.relname
                 ELSE n.nspname || '.' || c.relname
            END AS name,
            c.reltuples,
            c.relpages
     FROM pg_class AS c
     JOIN pg_namespace AS n ON n.oid = c.relnamespace`,
  );
  return Object.fromEntries(result.rows.map(({ name, reltuples, relpages }) => [name, { reltuples, relpages }]));
}

function sizesForMeasuredRelations(
  costs: readonly Cost[],
  available: Readonly<Record<string, RelationSize>>,
): Readonly<Record<string, RelationSize>> {
  const names = new Set(costs.flatMap(({ relations }) => Object.keys(relations)));
  return Object.fromEntries(
    Array.from(names, (name) => {
      const size = available[name];
      if (!size) throw new Error(`Measured relation ${name} was missing from pg_class statistics`);
      return [name, size];
    }),
  );
}

/**
 * For a capture taken outside checkGrowth: holds it to the bound checkGrowth enforces, catalog-only statements may not
 * exceed the distinct non-catalog statement texts, and returns it without them. Throws GrowthBoundError otherwise.
 */
export function withoutCatalogStatements(name: string, captureResult: Capture): Capture {
  return withoutCatalogTexts(captureResult, assertCatalogBound(name, undefined, captureResult, []));
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
    scales.some((scale) => !Number.isFinite(scale) || scale <= 0 || scale > 4096) ||
    !(first < second && second < third) ||
    firstRatio < 4 ||
    Math.abs(firstRatio - secondRatio) / Math.max(firstRatio, secondRatio) >= 1e-9
  ) {
    throw new TypeError(
      'Growth scales must be positive, increasing and equally spaced by a ratio of at least four, with a largest scale no greater than 4096',
    );
  }
  if (!Number.isSafeInteger(repetitions) || repetitions < 1)
    throw new RangeError('Growth repetitions must be a positive safe integer');
  if (!Number.isSafeInteger(warmups) || warmups < 1)
    throw new RangeError('Growth warmups must be a positive safe integer; use the warmup hook for consumable state');

  let previous = 0;
  let repetition = 0;
  const samples: ReportSample[] = [];
  for (const scale of scales) {
    const growStart = performance.now();
    const grown = await trackGrow(db, () => check.grow(db, scale, previous));
    const vacuumStart = performance.now();
    await db.admin.query('VACUUM (ANALYZE)');
    const vacuumMs = performance.now() - vacuumStart;
    const seeding: SeedingCost = { ...grown.seeding, growMs: vacuumStart - growStart, vacuumMs };
    const availableRelationSizes = await readRelationSizes(db);
    for (let warmup = 0; warmup < warmups; warmup++) {
      if (check.warmup) await check.warmup(db, scale, repetition);
      else await check.operation(db, scale, repetition);
      repetition++;
    }

    const costs: Cost[] = [];
    for (let run = 0; run < repetitions; run++) {
      // DBOS return-existing enqueues update workflow_status; vacuum its tuple chain before every measured repetition.
      const workflowStatus = await db.admin.query<{ exists: boolean }>(
        `SELECT to_regclass('"dbos".workflow_status') IS NOT NULL AS exists`,
      );
      if (workflowStatus.rows[0]!.exists) await db.admin.query('VACUUM (ANALYZE) "dbos".workflow_status');
      const measured = await capture(db, () => check.operation(db, scale, repetition));
      const cost = costOf(measured.capture);
      assertCatalogBound(check.name, scale, measured.capture, samples);
      costs.push(cost);
      repetition++;
    }
    samples.push({
      scale,
      cost: medianCost(costs),
      repetitions: costs,
      relationSizes: sizesForMeasuredRelations(costs, availableRelationSizes),
      seeding,
    });
    previous = scale;
  }

  appendProfile(check.name, scales, samples);
  assertBackgroundBound(check.name, samples);
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
