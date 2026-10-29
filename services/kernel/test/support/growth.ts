import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  DEFAULT_BYTE_SLACK,
  DEFAULT_SLACK,
  GrowthBoundError,
  GrowthEvidenceError,
  growthByteViolations,
  growthViolations,
  type Bound,
  type ByteMetric,
  type GrowthMetric,
  type Metric,
  type RelationSize,
  type Slack,
} from './growth-bound.ts';
import { capture, captureMeasuredRun, settle, settleAdmin, trackGrow, type GrowthDatabase } from './growth-capture.ts';
import {
  catalogStatementBound,
  costOf,
  medianCost,
  withoutCatalogTexts,
  type Capture,
  type CatalogClassification,
  type Cost,
} from './growth-cost.ts';
import { classifySeries, type SeriesClassification } from './growth-model.ts';
import { GROWTH_UNCERTAINTY } from './growth-uncertainty.ts';
import {
  formatStatementAttribution,
  profileStatements,
  statementAttributions,
  statementOccurrences,
  type StatementOccurrences,
} from './growth-report.ts';
import {
  countedSample,
  countedViolations,
  validateCountedConfig,
  validateCountedRun,
  type CountedCheck,
  type CountedSample,
} from './growth-counters.ts';

export * from './growth-counters.ts';

export * from './growth-cost.ts';
export * from './growth-bound.ts';
export {
  openGrowthDatabase,
  capture,
  settle,
  settleAdmin,
  GrowthSettleInfrastructureError,
  type GrowthDatabase,
} from './growth-capture.ts';
export * from './growth-seed.ts';
export * from './growth-uncertainty.ts';

export function measure<T>(db: GrowthDatabase, operation: () => Promise<T>): Promise<{ value: T; cost: Cost }> {
  return capture(db, operation).then(({ value, capture: raw }) => ({ value, cost: costOf(raw) }));
}

export type GrowthCheck = {
  readonly name: string;
  readonly scales?:
    | readonly [number, number, number]
    | readonly [number, number, number, number]
    | readonly [number, number, number, number, number]; // default [1, 8, 64]
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>;
  readonly rule?: 'step' | 'series';
  readonly slack?: Partial<Record<GrowthMetric, Slack>>;
  /** Index descents per measured run against growing relations; each scale transition may add up to this many blocks. */
  readonly indexProbes?: number;
  /** Counts returned by the operation. `includeBackends` makes the harness-provided `connections` count available. */
  readonly counted?: CountedCheck;
  readonly includeBackends?: boolean;
  readonly repetitions?: number; // measured runs per scale, default 5; the sample is their medianCost
  /**
   * Unmeasured runs per scale, after `grow` and before the measured runs, default 1. Calls `warmup` when given,
   * otherwise `operation`. Must be a positive safe integer; use the `warmup` hook for consumable state.
   */
  readonly warmups?: number;
  /**
   * Grows the data from the previous scale (0 before the first) to this one, normally with seed(). After each call,
   * checkGrowth settles the database with ANALYZE before the scale's first unmeasured run.
   */
  grow(db: GrowthDatabase, scale: number, previous: number): Promise<void>;
  /**
   * One measured run of the operation. `repetition` counts from 0 across all scales and unmeasured runs, shared
   * with `warmup`, for fresh keys.
   */
  operation(db: GrowthDatabase, scale: number, repetition: number): Promise<unknown>;
  /** One unmeasured run of the same code path on spare state, used for warm-ups in place of `operation`. */
  warmup?(db: GrowthDatabase, scale: number, repetition: number): Promise<unknown>;
  /** Unmeasured setup before each measured repetition, after harness preparation; never runs before warm-ups. */
  prepare?(db: GrowthDatabase, scale: number, repetition: number): Promise<void>;
};

/** What growing the data to a scale cost, including the time spent settling the database. */
export type SeedingCost = {
  readonly statements: number;
  readonly rowsWritten: number;
  readonly growMs: number;
  readonly vacuumMs: number;
  readonly settleMs: number;
};

export type ReportSample = {
  readonly scale: number;
  readonly cost: Cost;
  readonly repetitions: readonly Cost[];
  readonly relationSizes: Readonly<Record<string, RelationSize>>;
  readonly seeding: SeedingCost;
  readonly statementRepetitions: readonly (readonly StatementAttribution[])[];
  readonly occurrenceRepetitions: readonly StatementOccurrences[];
  readonly counted?: CountedSample;
};

export type StatementAttribution = {
  readonly statement: string;
  readonly rows: number;
  readonly blocks: number;
  readonly count: number;
  readonly node?: string;
};

export type GrowthReport = {
  readonly name: string;
  readonly rule: 'step' | 'series';
  readonly bounds: Readonly<Record<Metric, Bound>>;
  readonly byteBounds?: Readonly<Partial<Record<ByteMetric, Bound>>>;
  readonly samples: readonly ReportSample[];
  readonly shadow: Readonly<Record<Metric, ShadowVerdict>>;
  readonly counted?: Readonly<Record<string, { readonly limits?: number; readonly bounds?: Bound }>>;
};

export type ShadowVerdict = (
  | SeriesClassification
  | { readonly outcome: 'insufficient-evidence'; readonly error: string }
) & { readonly uncertainties: readonly number[] };

function shadowVerdict(samples: readonly ReportSample[], check: GrowthCheck, metric: Metric): ShadowVerdict {
  const uncertainties: number[] = [];
  try {
    const slack = GROWTH_UNCERTAINTY[metric];
    const points = samples.map(({ scale, cost, repetitions }) => {
      const uncertainty = Math.max(slack.absolute, slack.relative * cost[metric]);
      uncertainties.push(uncertainty);
      return { scale, repetitions: repetitions.map((value) => value[metric]), uncertainty };
    });
    return {
      ...classifySeries(points, check.bounds[metric], metric === 'blocks' ? (check.indexProbes ?? 0) : 0),
      uncertainties,
    };
  } catch (error) {
    // Shadow diagnostics must not preempt any existing assertion, including validation of bounds and slack.
    return {
      outcome: 'insufficient-evidence',
      uncertainties,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let profileWarned = false;

/** Appends one line per check to the file named by GROWTH_PROFILE; a failure warns once and never fails the check. */
function appendProfile(report: GrowthReport): void {
  const path = process.env.GROWTH_PROFILE;
  if (!path) return;
  try {
    const file = relative(process.cwd(), Bun.main);
    const { name, bounds, byteBounds, samples, shadow } = report;
    const line = JSON.stringify({
      file,
      check: name,
      scales: samples.map(({ scale }) => scale),
      seeding: samples.map(({ seeding }) => seeding),
      bounds,
      ...(byteBounds === undefined ? {} : { byteBounds }),
      repetitions: samples.map(({ repetitions }) =>
        repetitions.map(({ rows, blocks, statements, requestBytes, responseBytes, failedStatements }) => ({
          rows,
          blocks,
          statements,
          ...(requestBytes === undefined ? {} : { requestBytes }),
          ...(responseBytes === undefined ? {} : { responseBytes }),
          ...(failedStatements === undefined ? {} : { failedStatements }),
        })),
      ),
      ...(samples.some(({ counted }) => counted !== undefined)
        ? { counted: samples.map(({ counted }) => counted ?? {}) }
        : {}),
      relationSizes: samples.map(({ relationSizes }) => relationSizes),
      statements: profileStatements(samples),
      shadow: Object.fromEntries(
        Object.entries(shadow).map(([metric, verdict]) => [
          metric,
          {
            ...verdict,
            ...('families' in verdict
              ? {
                  families: Object.fromEntries(
                    Object.entries(verdict.families).map(([family, { a, b, factor }]) => [
                      family,
                      {
                        a,
                        b,
                        t: Number.isFinite(factor) ? factor : 'Infinity',
                      },
                    ]),
                  ),
                }
              : {}),
          },
        ]),
      ),
    });
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
): CatalogClassification {
  const classification = catalogStatementBound(captureResult);
  const { catalogStatements, allowedStatements, firstCatalogStatement } = classification;
  if (catalogStatements <= allowedStatements) return classification;
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
  const rule = check.rule ?? (process.env.GROWTH_RULE === 'series' ? 'series' : 'step');
  const scales = check.scales ?? [1, 8, 64];
  const repetitions = check.repetitions ?? 5;
  const warmups = check.warmups ?? 1;
  if (check.indexProbes !== undefined) {
    if (!Number.isSafeInteger(check.indexProbes) || check.indexProbes <= 0)
      throw new TypeError(`${check.name}: indexProbes must be a positive safe integer`);
    if (check.bounds.blocks === 'constant')
      throw new TypeError(`${check.name}: indexProbes cannot be used with a constant blocks bound`);
  }
  if (check.counted) validateCountedConfig(check.counted);
  if (scales.length < 3 || scales.length > 5) throw new TypeError('Growth checks require three to five scales');
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
    const vacuumMs = await settle(db, { analyze: true });
    let settleMs = vacuumMs;
    const seeding: SeedingCost = { ...grown.seeding, growMs: vacuumStart - growStart, vacuumMs, settleMs };
    const availableRelationSizes = await readRelationSizes(db);
    let pendingWrites = new Map<GrowthDatabase, Set<string>>();
    for (let warmup = 0; warmup < warmups; warmup++) {
      const warmed = await captureMeasuredRun(async () => {
        await capture(db, async () => {
          if (check.warmup) await check.warmup(db, scale, repetition);
          else await check.operation(db, scale, repetition);
        });
      });
      for (const [target, relations] of warmed.writes) {
        const accumulated = pendingWrites.get(target) ?? new Set<string>();
        for (const relation of relations) accumulated.add(relation);
        pendingWrites.set(target, accumulated);
      }
      repetition++;
    }

    const costs: Cost[] = [];
    const statementRepetitions: StatementAttribution[][] = [];
    const occurrenceRepetitions: StatementOccurrences[] = [];
    const countedRuns: Record<string, number>[] = [];
    for (let run = 0; run < repetitions; run++) {
      for (const target of pendingWrites.keys()) {
        const workflowStatus = await target.admin.query<{ exists: boolean }>(
          `SELECT to_regclass('"dbos".workflow_status') IS NOT NULL AS exists`,
        );
        if (workflowStatus.rows[0]!.exists) {
          const relations = pendingWrites.get(target)!;
          relations.add('dbos.workflow_status');
        }
      }
      for (const [target, relations] of pendingWrites) {
        if (relations.size > 0) settleMs += await settle(target, { relations: [...relations] });
      }
      (seeding as { settleMs: number }).settleMs = settleMs;
      if (check.prepare) await check.prepare(db, scale, repetition);
      const captured = await captureMeasuredRun(() =>
        capture(db, () => check.operation(db, scale, repetition), {
          ...(check.includeBackends === undefined ? {} : { includeBackends: check.includeBackends }),
        }),
      );
      pendingWrites = captured.writes;
      const measured = captured.value;
      const cost = costOf(measured.capture);
      if (check.counted) {
        const values = check.counted.read(measured.value, scale);
        const merged = { ...values };
        const configuredNames = [
          ...Object.keys(check.counted.limits ?? {}),
          ...Object.keys(check.counted.bounds ?? {}),
        ];
        if (configuredNames.includes('connections')) {
          const backends = measured.capture.statementBackends;
          if (backends === undefined)
            throw new Error(
              `Counted unit connections is unavailable at scale ${scale}: capture did not include backends`,
            );
          merged.connections = new Set(backends.filter((backend): backend is number => backend !== undefined)).size;
        }
        countedRuns.push({ ...validateCountedRun(check.counted, merged, scale) });
      }
      assertCatalogBound(check.name, scale, measured.capture, samples);
      costs.push(cost);
      statementRepetitions.push(statementAttributions(measured.capture));
      occurrenceRepetitions.push(statementOccurrences(measured.capture));
      repetition++;
    }
    samples.push({
      scale,
      cost: medianCost(costs),
      repetitions: costs,
      ...(check.counted === undefined ? {} : { counted: countedSample(countedRuns) }),
      relationSizes: sizesForMeasuredRelations(costs, availableRelationSizes),
      seeding,
      statementRepetitions,
      occurrenceRepetitions,
    });
    previous = scale;
  }

  const shadow: GrowthReport['shadow'] = {
    rows: shadowVerdict(samples, check, 'rows'),
    blocks: shadowVerdict(samples, check, 'blocks'),
    statements: shadowVerdict(samples, check, 'statements'),
  };
  const report: GrowthReport = {
    name: check.name,
    rule,
    bounds: check.bounds,
    ...(check.byteBounds === undefined ? {} : { byteBounds: check.byteBounds }),
    samples,
    shadow,
    ...(check.counted === undefined
      ? {}
      : {
          counted: Object.fromEntries(
            [...new Set([...Object.keys(check.counted.limits ?? {}), ...Object.keys(check.counted.bounds ?? {})])].map(
              (name) => [
                name,
                {
                  ...(check.counted!.limits?.[name] === undefined ? {} : { limits: check.counted!.limits[name] }),
                  ...(check.counted!.bounds?.[name] === undefined ? {} : { bounds: check.counted!.bounds[name] }),
                },
              ],
            ),
          ),
        }),
  };
  appendProfile(report);
  assertBackgroundBound(check.name, samples);
  try {
    const countedFailures = check.counted
      ? countedViolations(
          check.counted,
          samples.map(({ scale, counted }) => ({ scale, counted: counted ?? {} })),
        )
      : [];
    if (rule === 'step') {
      const metricViolations =
        check.byteBounds === undefined
          ? growthViolations(samples, check.bounds, check.slack)
          : [
              ...growthViolations(samples, check.bounds, check.slack),
              ...growthByteViolations(samples, check.byteBounds, check.slack),
            ];
      if (countedFailures.length > 0 || metricViolations.length > 0) {
        const error = new GrowthBoundError(metricViolations, samples, check.byteBounds);
        error.message += formatStatementAttribution(
          samples,
          metricViolations.map(({ metric }) => metric),
        );
        if (countedFailures.length > 0)
          error.message += `${error.message ? '\n' : ''}${countedFailures
            .map(({ unit, scale, value, limit, kind }) =>
              kind === 'limit'
                ? `counted unit ${unit} at scale ${scale}: value ${value} exceeds limit ${limit}`
                : `counted unit ${unit} at scale ${scale}: value ${value} violates ${limit} growth bound`,
            )
            .join('\n')}`;
        throw error;
      }
    } else {
      if (countedFailures.length > 0) {
        const error = new GrowthBoundError([], samples, check.byteBounds);
        error.message = countedFailures
          .map(({ unit, scale, value, limit, kind }) =>
            kind === 'limit'
              ? `counted unit ${unit} at scale ${scale}: value ${value} exceeds limit ${limit}`
              : `counted unit ${unit} at scale ${scale}: value ${value} violates ${limit} growth bound`,
          )
          .join('\n');
        throw error;
      }
      for (const metric of ['rows', 'blocks', 'statements'] as const) {
        const uncertainties = shadow[metric].uncertainties;
        const verdict = classifySeries(
          samples.map(({ scale, repetitions }, index) => ({
            scale,
            repetitions: repetitions.map((value) => value[metric]),
            uncertainty: uncertainties[index]!,
          })),
          check.bounds[metric],
          metric === 'blocks' ? (check.indexProbes ?? 0) : 0,
        );
        if (verdict.outcome === 'insufficient-evidence') {
          throw new GrowthEvidenceError(
            `${check.name}: insufficient growth evidence for ${metric}; medians ${verdict.medians.join(', ')}, repetitions ${samples.map(({ repetitions }) => `[${repetitions.map((value) => value[metric]).join(', ')}]`).join('; ')}, uncertainties ${uncertainties.join(', ')}`,
          );
        }
        if (verdict.outcome === 'violation') {
          const error = new GrowthBoundError([], samples, check.byteBounds);
          error.message = `${metric} violates ${check.bounds[metric]} growth bound; medians ${verdict.medians.join(', ')}; intervals ${verdict.intervals.map(({ lower, upper }) => `[${lower}, ${upper}]`).join(', ')}; staircase ${verdict.staircase.join(', ')}; families ${Object.entries(
            verdict.families,
          )
            .map(([family, fit]) => `${family} factor ${fit.factor}`)
            .join(', ')}`;
          error.message += formatStatementAttribution(samples, [metric]);
          throw error;
        }
      }
      for (const metric of ['requestBytes', 'responseBytes'] as const) {
        const bound = check.byteBounds?.[metric];
        if (bound === undefined) continue;
        const tolerance = check.slack?.[metric] ?? DEFAULT_BYTE_SLACK[metric];
        if (
          !Number.isFinite(tolerance.absolute) ||
          tolerance.absolute < 0 ||
          !Number.isFinite(tolerance.relative) ||
          tolerance.relative < 0
        )
          throw new TypeError(`Slack for ${metric} must be finite and non-negative`);
        const points = samples.map(({ scale, cost, repetitions }) => {
          const median = cost[metric];
          if (median === undefined || !Number.isFinite(median) || median < 0)
            throw new TypeError(`Growth value for ${metric} must be finite and non-negative`);
          const repetitionBytes = repetitions.map((value) => value[metric]);
          if (repetitionBytes.some((value) => value === undefined || !Number.isFinite(value) || value < 0))
            throw new TypeError(`Growth repetitions for ${metric} must be finite and non-negative`);
          return {
            scale,
            repetitions: repetitionBytes as number[],
            uncertainty: Math.max(tolerance.absolute, tolerance.relative * median),
          };
        });
        const verdict = classifySeries(points, bound);
        if (verdict.outcome === 'insufficient-evidence') {
          throw new GrowthEvidenceError(
            `${check.name}: insufficient growth evidence for ${metric}; medians ${verdict.medians.join(', ')}, repetitions ${samples.map(({ repetitions }) => `[${repetitions.map((value) => value[metric]).join(', ')}]`).join('; ')}, uncertainties ${points.map(({ uncertainty }) => uncertainty).join(', ')}`,
          );
        }
        if (verdict.outcome === 'violation') {
          const error = new GrowthBoundError([], samples, check.byteBounds);
          error.message = `${metric} violates ${bound} growth bound; medians ${verdict.medians.join(', ')}; intervals ${verdict.intervals.map(({ lower, upper }) => `[${lower}, ${upper}]`).join(', ')}; families ${Object.entries(
            verdict.families,
          )
            .map(([family, fit]) => `${family} factor ${fit.factor}`)
            .join(', ')}`;
          error.message += formatStatementAttribution(samples, [metric]);
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'GrowthBoundError') {
      error.message = `${check.name}: ${error.message}`;
      const attempts = samples.flatMap(({ scale, cost }) =>
        cost.failedStatements === undefined ? [] : [`${scale} ${JSON.stringify(cost.failedStatements)}`],
      );
      if (attempts.length > 0) error.message += `\nfailed attempts by SQLSTATE at scale: ${attempts.join(', ')}`;
    }
    throw error;
  }

  return report;
}
