import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  DEFAULT_BYTE_SLACK,
  DEFAULT_SLACK,
  GrowthBoundError,
  growthByteViolations,
  growthViolations,
  type Bound,
  type ByteMetric,
  type GrowthMetric,
  type Metric,
  type RelationSize,
  type Slack,
} from './growth-bound.ts';
import {
  capture,
  captureMeasuredRun,
  GrowthSettleInfrastructureError,
  captureWarmup,
  settle,
  trackGrow,
  type GrowthDatabase,
} from './growth-capture.ts';
import {
  catalogStatementBound,
  costOf,
  isControlStatement,
  medianCost,
  withoutCatalogTexts,
  type Capture,
  type CatalogClassification,
  type Cost,
} from './growth-cost.ts';
import { classifySeries, type SeriesClassification, type SeriesInterval, type SeriesPoint } from './growth-model.ts';
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
export * from './growth-access-path.ts';
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
  /** Number of logical top-level transaction commands in each measured run. Enables attempt-based bounds. */
  readonly attempts?: { readonly commands: number };
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
  /** Backend PIDs used by each accepted measured repetition, when known. */
  readonly backendRepetitions?: readonly (readonly number[])[];
  /** Measured runs discarded because they touched a backend not seen earlier at this scale. */
  readonly coldBackendDiscards?: number;
  readonly settleFailures?: readonly string[];
  readonly counted?: CountedSample;
  readonly attempts?: AttemptSample;
};

export type AttemptOutcome = 'committed' | `aborted:${string}`;
export type AttemptRecord = {
  readonly backend: number;
  readonly outcome: AttemptOutcome;
  readonly statements: number;
  readonly occurrences: readonly number[];
};
export type AttemptSample = {
  readonly commands: number;
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly attemptsPerCommand: number;
  readonly repetitions: readonly {
    readonly byOutcome: Readonly<Record<string, number>>;
    readonly attemptsPerCommand: number;
    readonly ledger: readonly AttemptRecord[];
  }[];
};

function attemptRecords(capture: Capture, occurrences: StatementOccurrences): AttemptRecord[] {
  const backends = capture.statementBackends;
  if (!backends || backends.length !== capture.statements.length)
    throw new TypeError('attempts require captures with backend attribution');
  const active = new Map<number, number[]>();
  const records: AttemptRecord[] = [];
  for (const occurrence of occurrences.statements) {
    const backend = occurrence.backend;
    if (backend === undefined) throw new TypeError('attempts require a backend PID for every statement');
    const text = capture.statements[occurrence.index]!;
    if (/^\s*(?:BEGIN|START\s+TRANSACTION)\b/i.test(text)) {
      if (active.has(backend))
        throw new TypeError(`backend ${backend} began a transaction before ending its previous attempt`);
      active.set(backend, [occurrence.index]);
      continue;
    }
    const attempt = active.get(backend);
    if (!attempt) continue;
    attempt.push(occurrence.index);
    if (/^\s*(?:COMMIT|END|ABORT|ROLLBACK(?!\s+(?:WORK\s+|TRANSACTION\s+)?TO\b))\b/i.test(text)) {
      const sqlstate = attempt
        .map((index) => capture.statementErrors?.[index] ?? null)
        .find((code) => code === '40001' || code === '40P01');
      if (
        !sqlstate &&
        (/^\s*(?:ROLLBACK|ABORT)\b/i.test(text) || attempt.some((index) => capture.statementErrors?.[index]))
      )
        throw new TypeError(
          `backend ${backend}: transaction ended without a commit or retry SQLSTATE (40001 or 40P01)`,
        );
      const outcome: AttemptOutcome = sqlstate ? `aborted:${sqlstate}` : 'committed';
      const statements = attempt.filter((index) => !isControlStatement(capture.statements[index]!)).length;
      records.push({ backend, outcome, statements, occurrences: [...attempt] });
      active.delete(backend);
    }
  }
  if (active.size)
    throw new TypeError(
      `capture ended with unterminated transaction attempts on backends ${[...active.keys()].join(', ')}`,
    );
  return records;
}

/** Build the foreground transaction attempt ledger from a captured run. */
export function readAttemptLedger(capture: Capture): AttemptRecord[] {
  return attemptRecords(capture, statementOccurrences(capture));
}

function summarizeAttempts(commands: number, runs: readonly AttemptRecord[][]): AttemptSample {
  const repetitions = runs.map((ledger) => {
    const byOutcome: Record<string, number> = {};
    for (const attempt of ledger) byOutcome[attempt.outcome] = (byOutcome[attempt.outcome] ?? 0) + 1;
    return { byOutcome, attemptsPerCommand: ledger.length / commands, ledger };
  });
  const byOutcome: Record<string, number> = {};
  for (const repetition of repetitions)
    for (const [outcome, count] of Object.entries(repetition.byOutcome))
      byOutcome[outcome] = (byOutcome[outcome] ?? 0) + count / repetitions.length;
  return {
    commands,
    byOutcome,
    attemptsPerCommand: repetitions.reduce((sum, item) => sum + item.attemptsPerCommand, 0) / repetitions.length,
    repetitions,
  };
}

export function validateAttemptSamples(check: GrowthCheck, samples: readonly ReportSample[]): void {
  if (!check.attempts) return;
  const ledgerText = samples
    .map(({ scale, attempts }) => `scale ${scale}: ${JSON.stringify(attempts?.repetitions)}`)
    .join('\n');
  const fail = (message: string): never => {
    const error = new GrowthBoundError([], samples);
    error.message = `${check.name}: ${message}\nper-scale attempt ledger:\n${ledgerText}`;
    throw error;
  };
  let committedCount: number | undefined;
  let committedStatements: readonly string[] = [];
  for (const { attempts, scale, occurrenceRepetitions } of samples) {
    if (!attempts) throw new TypeError(`${check.name}: missing attempt ledger at scale ${scale}`);
    for (const [repetition, run] of attempts.repetitions.entries()) {
      const committed = run.ledger.filter(({ outcome }) => outcome === 'committed');
      if (committed.length !== check.attempts.commands)
        fail(
          `attempts declared ${check.attempts.commands} commands at scale ${scale}, repetition ${repetition}, but observed ${committed.length} committed attempts`,
        );
      for (const [index, attempt] of run.ledger.entries()) {
        if (attempt.outcome !== 'committed') continue;
        const statements = attempt.occurrences.map(
          (occurrence) =>
            occurrenceRepetitions[repetition]?.statements.find(({ index }) => index === occurrence)?.statement ??
            `occurrence ${occurrence} (SQL unavailable)`,
        );
        if (committedCount === undefined) {
          committedCount = attempt.statements;
          committedStatements = statements;
        }
        if (attempt.statements !== committedCount) {
          fail(
            `committed attempt ${index} on backend ${attempt.backend} at scale ${scale}, repetition ${repetition}: statement counts differ; expected ${committedCount}, got ${attempt.statements}; statements: ${statements.join('; ')}; reference committed statements: ${committedStatements.join('; ')}`,
          );
        }
      }
    }
  }
  for (const { attempts, scale } of samples)
    for (const [repetition, run] of attempts!.repetitions.entries())
      for (const [index, attempt] of run.ledger.entries())
        if (attempt.outcome !== 'committed' && attempt.statements > committedCount!)
          fail(
            `aborted attempt ${index} (${attempt.outcome}) at scale ${scale}, repetition ${repetition} ran ${attempt.statements} statements, exceeding committed attempt count ${committedCount}`,
          );
  const retries = retryFailures(samples);
  for (const metric of ['rows', 'blocks'] as const) {
    const fingerprints = new Set(
      samples.flatMap(({ occurrenceRepetitions }) =>
        occurrenceRepetitions.flatMap(({ statements }) => statements.map(({ statement }) => statement)),
      ),
    );
    for (const fingerprint of fingerprints) {
      const points = samples.flatMap((sample) => {
        const executions = sample.occurrenceRepetitions.flatMap(({ statements }) =>
          statements.filter((item) => item.statement === fingerprint && (item.error === null || item.plans.length > 0)),
        );
        // A missing execution (or a failure without a plan) is not a measured zero. Compare the most expensive
        // execution at each scale so retry incidence cannot change the verdict or hide an expensive repetition.
        if (executions.length === 0) return [];
        const maximum = Math.max(...executions.map((item) => item[metric]));
        return [
          {
            scale: sample.scale,
            repetitions: [maximum],
            uncertainty: Math.max(GROWTH_UNCERTAINTY[metric].absolute, GROWTH_UNCERTAINTY[metric].relative * maximum),
          },
        ];
      });
      // Missing executions are diagnostic, not zero-cost observations or evidence insufficiency failures.
      if (points.length < 3) continue;
      const verdict = classifySeries(points, check.bounds[metric], metric === 'blocks' ? (check.indexProbes ?? 0) : 0);
      if (verdict.outcome === 'violation' && retries.length === 0)
        fail(`statement ${fingerprint} ${metric} violates ${check.bounds[metric]} growth bound across attempts`);
    }
  }
}

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
  readonly samples: readonly (ReportSample & {
    readonly backendRepetitions: readonly (readonly number[])[];
    readonly coldBackendDiscards: number;
  })[];
  readonly verdicts: Readonly<Record<Metric, GrowthVerdict> & Partial<Record<ByteMetric, GrowthVerdict>>>;
  readonly shadow: Readonly<Record<Metric, ShadowVerdict>>;
  readonly counted?: Readonly<Record<string, { readonly limits?: number; readonly bounds?: Bound }>>;
};

export type ShadowVerdict = (
  | SeriesClassification
  | {
      readonly outcome: 'inconclusive';
      readonly reason: 'noise';
      readonly error: string;
      readonly ranges: readonly SeriesInterval[];
    }
) & { readonly uncertainties: readonly number[] };

export type GrowthVerdict = Readonly<{
  outcome: 'compatible' | 'violation' | 'inconclusive';
  reason?: 'noise' | 'settle' | 'retries';
  medians: readonly number[];
  ranges: readonly SeriesInterval[];
  uncertainties: readonly number[];
}>;

type ClassifiedMetric = Readonly<{
  bound: Bound;
  classification: SeriesClassification;
  uncertainties: readonly number[];
}>;

type FailedStatementCount = Readonly<{ scale: number; sqlstate: string; count: number }>;

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
      outcome: 'inconclusive',
      reason: 'noise',
      ranges: [],
      uncertainties,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function classifyMetric(samples: readonly ReportSample[], check: GrowthCheck, metric: GrowthMetric): ClassifiedMetric {
  const bound =
    metric === 'rows' || metric === 'blocks' || metric === 'statements'
      ? check.bounds[metric]
      : check.byteBounds?.[metric];
  if (bound === undefined) throw new TypeError(`No growth bound is declared for ${metric}`);
  const slack =
    metric === 'rows' || metric === 'blocks' || metric === 'statements'
      ? GROWTH_UNCERTAINTY[metric]
      : (check.slack?.[metric] ?? DEFAULT_BYTE_SLACK[metric]);
  if (!Number.isFinite(slack.absolute) || slack.absolute < 0 || !Number.isFinite(slack.relative) || slack.relative < 0)
    throw new TypeError(`Slack for ${metric} must be finite and non-negative`);
  const uncertainties: number[] = [];
  const points: SeriesPoint[] = samples.map(({ scale, cost, repetitions }) => {
    const median = cost[metric];
    const values = repetitions.map((value) => value[metric]);
    if (median === undefined || !Number.isFinite(median) || median < 0)
      throw new TypeError(`Growth value for ${metric} must be finite and non-negative`);
    if (values.some((value) => value === undefined || !Number.isFinite(value) || value < 0))
      throw new TypeError(`Growth repetitions for ${metric} must be finite and non-negative`);
    const uncertainty = Math.max(slack.absolute, slack.relative * median);
    uncertainties.push(uncertainty);
    return { scale, repetitions: values as number[], uncertainty };
  });
  return {
    bound,
    classification: classifySeries(points, bound, metric === 'blocks' ? (check.indexProbes ?? 0) : 0),
    uncertainties,
  };
}

function retryFailures(samples: readonly ReportSample[]): FailedStatementCount[] {
  const counts = new Map<string, FailedStatementCount>();
  for (const sample of samples)
    for (const repetition of sample.repetitions)
      for (const sqlstate of ['40001', '40P01']) {
        const count = repetition.failedStatements?.[sqlstate] ?? 0;
        if (count === 0) continue;
        const key = `${sample.scale}:${sqlstate}`;
        const previous = counts.get(key);
        counts.set(key, { scale: sample.scale, sqlstate, count: (previous?.count ?? 0) + count });
      }
  return [...counts.values()];
}

function selectedVerdict(
  metric: GrowthMetric,
  classified: ClassifiedMetric,
  rule: GrowthReport['rule'],
  stepViolation: boolean,
  settleFailed: boolean,
  failedStatements: readonly FailedStatementCount[],
): GrowthVerdict {
  const { classification, uncertainties } = classified;
  let outcome: GrowthVerdict['outcome'];
  let reason: GrowthVerdict['reason'];
  if (rule === 'series') {
    outcome = classification.outcome;
    reason = classification.reason;
  } else if (!stepViolation) {
    outcome = 'compatible';
  } else if (classification.outcome === 'violation') {
    outcome = 'violation';
  } else {
    outcome = 'inconclusive';
    reason = classification.reason ?? 'noise';
  }
  if (outcome === 'violation' && metric === 'blocks' && settleFailed) {
    outcome = 'inconclusive';
    reason = 'settle';
  } else if (outcome === 'violation' && failedStatements.length > 0) {
    outcome = 'inconclusive';
    reason = 'retries';
  }
  return {
    outcome,
    ...(reason === undefined ? {} : { reason }),
    medians: classification.medians,
    ranges: classification.ranges,
    uncertainties,
  };
}

function writeGrowthReview(
  check: GrowthCheck,
  rule: GrowthReport['rule'],
  metric: GrowthMetric,
  bound: Bound | undefined,
  verdict: GrowthVerdict,
  samples: readonly ReportSample[],
  failedStatements: readonly FailedStatementCount[],
): void {
  if (verdict.outcome !== 'inconclusive') return;
  const settleFailures = samples.flatMap(({ scale, settleFailures: failures }) =>
    (failures ?? []).map((message) => ({ scale, message: message.slice(0, 2000) })),
  );
  const repetitions = samples.map(({ scale, repetitions: values }) => ({
    scale,
    values: values.map((value) => value[metric]),
  }));
  process.stderr.write(
    `GROWTH_REVIEW ${JSON.stringify({
      file: relative(process.cwd(), Bun.main),
      check: check.name,
      metric,
      ...(bound === undefined ? {} : { bound }),
      rule,
      reason: verdict.reason ?? 'noise',
      medians: verdict.medians,
      ranges: verdict.ranges,
      uncertainties: verdict.uncertainties,
      repetitions,
      ...(settleFailures.length === 0 ? {} : { settleFailures }),
      ...(failedStatements.length === 0 ? {} : { failedStatements }),
    })}\n`,
  );
}

let profileWarned = false;

/** Appends one line per check to the file named by GROWTH_PROFILE; a failure warns once and never fails the check. */
function appendProfile(report: GrowthReport): void {
  const path = process.env.GROWTH_PROFILE;
  if (!path) return;
  try {
    const file = relative(process.cwd(), Bun.main);
    const { name, bounds, byteBounds, samples, shadow, verdicts } = report;
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
      backendRepetitions: samples.map(({ backendRepetitions }) => backendRepetitions),
      coldBackendDiscards: samples.map(({ coldBackendDiscards }) => coldBackendDiscards),
      ...(samples.some(({ counted }) => counted !== undefined)
        ? { counted: samples.map(({ counted }) => counted ?? {}) }
        : {}),
      ...(samples.some(({ attempts }) => attempts !== undefined)
        ? { attempts: samples.map(({ attempts }) => attempts ?? null) }
        : {}),
      ...(samples.some(({ settleFailures }) => settleFailures !== undefined)
        ? { settleFailures: samples.map(({ settleFailures }) => settleFailures ?? []) }
        : {}),
      relationSizes: samples.map(({ relationSizes }) => relationSizes),
      verdicts,
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
  const samples: Array<GrowthReport['samples'][number]> = [];
  let laterSettleTimeout = false;
  for (const scale of scales) {
    const settleFailures: string[] = [];
    const recordedSettle = async (target: GrowthDatabase, options: Parameters<typeof settle>[1]): Promise<number> => {
      const started = performance.now();
      try {
        return await settle(target, laterSettleTimeout ? { ...options, timeoutMs: 900, pollMs: 25 } : options);
      } catch (error) {
        if (!(error instanceof GrowthSettleInfrastructureError)) throw error;
        laterSettleTimeout = true;
        settleFailures.push(error.message.slice(0, 2000));
        return performance.now() - started;
      }
    };
    const growStart = performance.now();
    const grown = await trackGrow(db, () => check.grow(db, scale, previous));
    const vacuumStart = performance.now();
    const vacuumMs = await recordedSettle(db, { analyze: true });
    let settleMs = vacuumMs;
    const seeding: SeedingCost = { ...grown.seeding, growMs: vacuumStart - growStart, vacuumMs, settleMs };
    const measuredDatabases = new Set<GrowthDatabase>([db]);
    let pendingWrites = new Map<GrowthDatabase, Set<string>>();
    const seenBackends = new Set<number>();
    let pendingBackends = new Set<number>();
    for (let warmup = 0; warmup < warmups; warmup++) {
      const warmed = await captureMeasuredRun(() =>
        captureWarmup(db, async () => {
          if (check.warmup) await check.warmup(db, scale, repetition);
          else await check.operation(db, scale, repetition);
        }),
      );
      for (const backend of warmed.backends) seenBackends.add(backend);
      for (const target of warmed.databases) measuredDatabases.add(target);
      for (const [target, relations] of warmed.writes) {
        const accumulated = pendingWrites.get(target) ?? new Set<string>();
        for (const relation of relations) accumulated.add(relation);
        pendingWrites.set(target, accumulated);
      }
      for (const backend of warmed.backends) pendingBackends.add(backend);
      repetition++;
    }

    const costs: Cost[] = [];
    const statementRepetitions: StatementAttribution[][] = [];
    const occurrenceRepetitions: StatementOccurrences[] = [];
    const attemptRuns: AttemptRecord[][] = [];
    const countedRuns: Record<string, number>[] = [];
    const backendRepetitions: number[][] = [];
    let coldBackendDiscards = 0;
    for (let run = 0; run < repetitions; run++) {
      let accepted = false;
      while (!accepted) {
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
          if (relations.size > 0)
            settleMs += await recordedSettle(target, { relations: [...relations], operationBackends: pendingBackends });
        }
        (seeding as { settleMs: number }).settleMs = settleMs;
        if (check.prepare) await check.prepare(db, scale, repetition);
        const captured = await captureMeasuredRun(() =>
          capture(db, () => check.operation(db, scale, repetition), { includeBackends: true }),
        );
        for (const target of captured.databases) measuredDatabases.add(target);
        pendingBackends = new Set(captured.backends);
        const writes = captured.writes;
        const measured = captured.value;
        const runBackends = [
          ...new Set(
            (measured.capture.statementBackends ?? []).filter((backend): backend is number => backend !== undefined),
          ),
        ];
        const coldBackends = runBackends.filter((backend) => !seenBackends.has(backend));
        if (coldBackends.length > 0 && coldBackendDiscards < 4) {
          coldBackendDiscards++;
          for (const backend of runBackends) seenBackends.add(backend);
          for (const [target, relations] of writes) {
            const accumulated = pendingWrites.get(target) ?? new Set<string>();
            for (const relation of relations) accumulated.add(relation);
            pendingWrites.set(target, accumulated);
          }
          repetition++;
          continue;
        }
        pendingWrites = writes;
        for (const backend of runBackends) seenBackends.add(backend);
        backendRepetitions.push(runBackends);
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
        if (check.attempts) attemptRuns.push(attemptRecords(measured.capture, occurrenceRepetitions.at(-1)!));
        repetition++;
        accepted = true;
      }
    }
    const availableRelationSizes: Record<string, RelationSize> = {};
    for (const target of measuredDatabases) Object.assign(availableRelationSizes, await readRelationSizes(target));
    samples.push({
      scale,
      cost: medianCost(costs),
      repetitions: costs,
      ...(check.counted === undefined ? {} : { counted: countedSample(countedRuns) }),
      relationSizes: sizesForMeasuredRelations(costs, availableRelationSizes),
      seeding,
      statementRepetitions,
      occurrenceRepetitions,
      backendRepetitions,
      coldBackendDiscards,
      ...(check.attempts ? { attempts: summarizeAttempts(check.attempts.commands, attemptRuns) } : {}),
      ...(settleFailures.length === 0 ? {} : { settleFailures }),
    });
    previous = scale;
  }

  const shadow: GrowthReport['shadow'] = {
    rows: shadowVerdict(samples, check, 'rows'),
    blocks: shadowVerdict(samples, check, 'blocks'),
    statements: shadowVerdict(samples, check, 'statements'),
  };
  const classified: Record<GrowthMetric, ClassifiedMetric | undefined> = {
    rows: classifyMetric(samples, check, 'rows'),
    blocks: classifyMetric(samples, check, 'blocks'),
    statements: classifyMetric(samples, check, 'statements'),
    requestBytes:
      check.byteBounds?.requestBytes === undefined ? undefined : classifyMetric(samples, check, 'requestBytes'),
    responseBytes:
      check.byteBounds?.responseBytes === undefined ? undefined : classifyMetric(samples, check, 'responseBytes'),
  };
  const stepViolations = [
    ...growthViolations(samples, check.bounds, check.slack),
    ...growthByteViolations(samples, check.byteBounds ?? {}, check.slack),
  ];
  const stepViolationMetrics = new Set(stepViolations.map(({ metric }) => metric));
  const failedStatements = retryFailures(samples);
  const settleFailed = samples.some(({ settleFailures: failures }) => (failures?.length ?? 0) > 0);
  const verdicts: Record<GrowthMetric, GrowthVerdict | undefined> = {
    rows: undefined,
    blocks: undefined,
    statements: undefined,
    requestBytes: undefined,
    responseBytes: undefined,
  };
  for (const metric of ['rows', 'blocks', 'statements', 'requestBytes', 'responseBytes'] as const) {
    const source = classified[metric];
    if (!source) continue;
    verdicts[metric] = selectedVerdict(
      metric,
      source,
      rule,
      stepViolationMetrics.has(metric),
      settleFailed,
      failedStatements,
    );
  }

  const report: GrowthReport = {
    name: check.name,
    rule,
    bounds: check.bounds,
    ...(check.byteBounds === undefined ? {} : { byteBounds: check.byteBounds }),
    samples,
    verdicts: verdicts as GrowthReport['verdicts'],
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
  for (const metric of ['rows', 'blocks', 'statements', 'requestBytes', 'responseBytes'] as const) {
    const verdict = report.verdicts[metric];
    if (verdict) writeGrowthReview(check, rule, metric, classified[metric]?.bound, verdict, samples, failedStatements);
  }
  assertBackgroundBound(check.name, samples);
  validateAttemptSamples(check, samples);

  const countedFailures = check.counted
    ? countedViolations(
        check.counted,
        samples.map(({ scale, counted }) => ({ scale, counted: counted ?? {} })),
      )
    : [];
  const violations =
    rule === 'step' ? stepViolations.filter(({ metric }) => report.verdicts[metric]?.outcome === 'violation') : [];
  const established = (Object.entries(report.verdicts) as [GrowthMetric, GrowthVerdict | undefined][])
    .filter(([, verdict]) => verdict?.outcome === 'violation')
    .map(([metric]) => metric);
  if (countedFailures.length > 0 || established.length > 0) {
    const error = new GrowthBoundError(violations, samples, check.byteBounds);
    const details =
      rule === 'series'
        ? established.map((metric) => {
            const source = classified[metric]!;
            const verdict = report.verdicts[metric]!;
            const suffix =
              'staircase' in source.classification ? `; staircase ${source.classification.staircase.join(', ')}` : '';
            return `${metric} violates ${source.bound} growth bound; medians ${verdict.medians.join(', ')}; ranges ${verdict.ranges
              .map(({ lower, upper }) => `[${lower}, ${upper}]`)
              .join(', ')}${suffix}`;
          })
        : [];
    const attributions = established.length > 0 ? formatStatementAttribution(samples, established) : '';
    const countDetails = countedFailures.map(({ unit, scale, value, limit, kind }) =>
      kind === 'limit'
        ? `counted unit ${unit} at scale ${scale}: value ${value} exceeds limit ${limit}`
        : `counted unit ${unit} at scale ${scale}: value ${value} violates ${limit} growth bound`,
    );
    error.message = `${check.name}: ${[error.message, ...details, attributions, ...countDetails]
      .filter(Boolean)
      .join('\n')}`;
    const failedAttempts = samples.flatMap(({ scale, cost }) =>
      cost.failedStatements === undefined ? [] : [`${scale} ${JSON.stringify(cost.failedStatements)}`],
    );
    if (failedAttempts.length > 0)
      error.message += `\nfailed attempts by SQLSTATE at scale: ${failedAttempts.join(', ')}`;
    throw error;
  }

  return report;
}
