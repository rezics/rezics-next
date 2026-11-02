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
  captureWarmup,
  GrowthSettleInfrastructureError,
  settle,
  trackGrow,
  withGrowthCheck,
  type GrowthDatabase,
} from './growth-capture.ts';
import {
  catalogStatementBound,
  costOf,
  medianCost,
  withoutCatalogTexts,
  type Capture,
  type CatalogClassification,
  type Cost,
} from './growth-cost.ts';
import { classifyGrowthSql } from './growth-sql-kind.ts';
import { classifySeries, type SeriesClassification, type SeriesInterval, type SeriesPoint } from './growth-model.ts';
import { GROWTH_BASELINE } from './growth-baseline.ts';
import { GROWTH_UNCERTAINTY } from './growth-uncertainty.ts';
import {
  formatStatementAttribution,
  profileStatements,
  statementAttributions,
  statementOccurrences,
  type StatementOccurrences,
} from './growth-report.ts';
import { appendGrowthProfile, growthProfileExportMode, type GrowthProfileExportMode } from './growth-profile-output.ts';
import {
  countedSample,
  countedViolations,
  validateCountedConfig,
  validateCountedRun,
  type CountedCheck,
  type CountedSample,
} from './growth-counters.ts';
import {
  isSuccessfulForegroundOccurrence,
  retryAffectsOccurrence,
  retainIndependentRetryViolation,
  successfulMetricEvidence,
} from './growth-retry-verdict.ts';

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
export * from './growth-profile-output.ts';

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
  /**
   * Unmeasured setup before each measured repetition, after harness preparation; never runs before warm-ups.
   * Writes and open transactions are settled before the measured operation and are not product cost.
   */
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
  /** Accepted-repetition indexes that still used a new backend after the four-discard budget. */
  readonly coldBackendExhaustion?: readonly number[];
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
  const active = new Map<number, { readonly occurrences: number[]; statements: number }>();
  const records: AttemptRecord[] = [];
  for (const occurrence of occurrences.statements) {
    const backend = occurrence.backend;
    if (backend === undefined) throw new TypeError('attempts require a backend PID for every statement');
    const text = capture.statements[occurrence.index]!;
    const kind = classifyGrowthSql(text);
    if (kind === 'begin') {
      if (active.has(backend))
        throw new TypeError(`backend ${backend} began a transaction before ending its previous attempt`);
      active.set(backend, { occurrences: [occurrence.index], statements: 0 });
      continue;
    }
    const attempt = active.get(backend);
    if (!attempt) continue;
    attempt.occurrences.push(occurrence.index);
    if (kind === 'statement') attempt.statements++;
    if (kind === 'commit' || kind === 'rollback') {
      const sqlstate = attempt.occurrences
        .map((index) => capture.statementErrors?.[index] ?? null)
        .find((code) => code === '40001' || code === '40P01');
      if (!sqlstate && (kind === 'rollback' || attempt.occurrences.some((index) => capture.statementErrors?.[index])))
        throw new TypeError(
          `backend ${backend}: transaction ended without a commit or retry SQLSTATE (40001 or 40P01)`,
        );
      const outcome: AttemptOutcome = sqlstate ? `aborted:${sqlstate}` : 'committed';
      records.push({ backend, outcome, statements: attempt.statements, occurrences: [...attempt.occurrences] });
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
  for (const metric of ['rows', 'blocks'] as const) {
    const fingerprints = new Set(
      samples.flatMap(({ occurrenceRepetitions }) =>
        occurrenceRepetitions.flatMap(({ statements }) => statements.map(({ statement }) => statement)),
      ),
    );
    for (const fingerprint of fingerprints) {
      const pointsFor = (successfulOnly: boolean) =>
        samples.flatMap((sample) => {
          const executions = sample.occurrenceRepetitions.flatMap((run, repetition) => {
            const ledger = sample.attempts!.repetitions[repetition]!.ledger;
            return run.statements.filter(
              (item) =>
                item.statement === fingerprint &&
                (successfulOnly
                  ? isSuccessfulForegroundOccurrence(item, ledger)
                  : item.error === null || item.plans.length > 0),
            );
          });
          // A missing execution (or a failure without a plan) is not a measured zero. Compare the most expensive
          // execution at each scale so an expensive repetition cannot be hidden by retry incidence.
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
      const points = pointsFor(false);
      const successfulPoints = pointsFor(true);
      // Missing executions are diagnostic, not zero-cost observations or evidence insufficiency failures.
      if (points.length < 3) continue;
      const indexProbes = metric === 'blocks' ? (check.indexProbes ?? 0) : 0;
      const verdict = classifySeries(points, check.bounds[metric], indexProbes);
      if (verdict.outcome !== 'violation') continue;

      const retryAffectsStatement = samples.some((sample) =>
        sample.occurrenceRepetitions.some((run, repetition) =>
          run.statements.some(
            (item) =>
              item.statement === fingerprint &&
              retryAffectsOccurrence(item, sample.attempts!.repetitions[repetition]!.ledger),
          ),
        ),
      );
      if (!retryAffectsStatement) {
        fail(`statement ${fingerprint} ${metric} violates ${check.bounds[metric]} growth bound across attempts`);
        continue;
      }

      if (successfulPoints.length >= 3) {
        const successfulVerdict = classifySeries(successfulPoints, check.bounds[metric], indexProbes);
        if (successfulVerdict.outcome === 'violation')
          fail(
            `statement ${fingerprint} ${metric} violates ${check.bounds[metric]} growth bound in successful foreground work`,
          );
        else {
          const explanation = `statement ${fingerprint} ${metric} violates ${check.bounds[metric]} only when retry-affected occurrences are included; successful committed or autocommit occurrences do not independently establish the violation`;
          process.stderr.write(
            `GROWTH_REVIEW ${JSON.stringify({
              file: relative(process.cwd(), Bun.main),
              check: check.name,
              metric,
              bound: check.bounds[metric],
              reason: 'retries',
              statement: fingerprint,
              explanation,
            })}\n`,
          );
        }
      } else {
        const explanation = `statement ${fingerprint} ${metric} has fewer than three scales of successful foreground evidence after retry-affected occurrences are excluded`;
        process.stderr.write(
          `GROWTH_REVIEW ${JSON.stringify({
            file: relative(process.cwd(), Bun.main),
            check: check.name,
            metric,
            bound: check.bounds[metric],
            reason: 'retries',
            statement: fingerprint,
            explanation,
          })}\n`,
        );
      }
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
  reason?: 'noise' | 'settle' | 'retries' | 'backends';
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

function classifiedVerdict(
  metric: GrowthMetric,
  classified: ClassifiedMetric,
  rule: GrowthReport['rule'],
  stepViolation: boolean,
  settleFailed: boolean,
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
  }
  return {
    outcome,
    ...(reason === undefined ? {} : { reason }),
    medians: classification.medians,
    ranges: classification.ranges,
    uncertainties,
  };
}

function selectedVerdict(
  metric: GrowthMetric,
  classified: ClassifiedMetric,
  rule: GrowthReport['rule'],
  stepViolation: boolean,
  settleFailed: boolean,
  failedStatements: readonly FailedStatementCount[],
  check: GrowthCheck,
  samples: readonly ReportSample[],
): { verdict: GrowthVerdict; retryExplanation?: string } {
  const reported = classifiedVerdict(metric, classified, rule, stepViolation, settleFailed);
  if (reported.outcome !== 'violation' || reported.reason === 'settle' || failedStatements.length === 0)
    return { verdict: reported };

  const evidence = successfulMetricEvidence(samples, metric);
  let independent: GrowthVerdict | undefined;
  if (evidence.values) {
    const independentSamples = samples.map((sample, index) => {
      const runs = evidence.values![index]!;
      const ordered = [...runs].sort((left, right) => left - right);
      const median = ordered[Math.floor((ordered.length - 1) / 2)]!;
      return {
        ...sample,
        cost: { ...sample.cost, [metric]: median },
        repetitions: sample.repetitions.map((cost, repetition) => ({
          ...cost,
          [metric]: runs[repetition]!,
        })),
      };
    });
    const independentClassified = classifyMetric(independentSamples, check, metric);
    const independentStepViolation = growthViolations(independentSamples, check.bounds, check.slack).some(
      (violation) => violation.metric === metric,
    );
    independent = classifiedVerdict(metric, independentClassified, rule, independentStepViolation, settleFailed);
  }

  const explanation = evidence.explanation
    ? `Successful foreground ${metric} evidence could not be separated: ${evidence.explanation}; retry work remains in the inclusive measurements.`
    : independent?.outcome === 'compatible'
      ? `Successful foreground ${metric} evidence is compatible with ${classified.bound}; retry work remains in the inclusive violation.`
      : `Successful foreground ${metric} evidence is ${independent?.outcome ?? 'unavailable'} and does not independently establish the inclusive violation; retry work remains in the measurements.`;
  const decision = retainIndependentRetryViolation(independent?.outcome, explanation);
  return {
    verdict:
      decision.outcome === 'violation' ? reported : { ...reported, outcome: decision.outcome, reason: decision.reason },
    ...(decision.outcome === 'inconclusive' ? { retryExplanation: decision.explanation } : {}),
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
  retryExplanation?: string,
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
      ...(retryExplanation === undefined ? {} : { retryExplanation }),
      medians: verdict.medians,
      ranges: verdict.ranges,
      uncertainties: verdict.uncertainties,
      repetitions,
      ...(settleFailures.length === 0 ? {} : { settleFailures }),
      ...(failedStatements.length === 0 ? {} : { failedStatements }),
      ...(samples.some((sample) => (sample.coldBackendExhaustion?.length ?? 0) > 0)
        ? { coldBackendExhaustion: samples.map((sample) => sample.coldBackendExhaustion ?? []) }
        : {}),
    })}\n`,
  );
}

/** Appends one JSONL record to GROWTH_PROFILE; best-effort warns once per destination, required mode throws. */
function appendProfile(report: GrowthReport, mode: GrowthProfileExportMode): void {
  const destination = process.env.GROWTH_PROFILE;
  if (!destination) return;
  const file = relative(process.cwd(), Bun.main);
  const { name, bounds, byteBounds, samples, shadow, verdicts } = report;
  appendGrowthProfile({
    destination,
    mode,
    record: {
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
      coldBackendExhaustion: samples.map(({ coldBackendExhaustion }) => coldBackendExhaustion ?? []),
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
    },
  });
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

export function assertBackgroundBound(name: string, samples: readonly ReportSample[]): void {
  const statements = new Set(
    samples.flatMap(({ cost }) =>
      Object.entries(cost.backgroundCosts ?? {})
        .filter(([, value]) => value.bounded)
        .map(([statement]) => statement),
    ),
  );
  const failures: {
    statement: string;
    rows: number;
    metric: 'rows' | 'blocks';
    scale: number;
    baseline: number;
    value: number;
    allowed: number;
  }[] = [];
  for (const statement of statements) {
    const observed: { scale: number; rows: number; blocks: number }[] = [];
    for (const sample of samples) {
      const cost = sample.cost.backgroundCosts?.[statement];
      if (cost) observed.push({ scale: sample.scale, rows: cost.rows, blocks: cost.blocks });
    }
    if (observed.length < 2) continue;
    for (const metric of ['rows', 'blocks'] as const) {
      const baseline = observed[0]!;
      let peak = baseline;
      for (const item of observed.slice(1)) if (item[metric] > peak[metric]) peak = item;
      const tolerance = DEFAULT_SLACK[metric];
      const allowed = Math.max(tolerance.absolute, tolerance.relative * baseline[metric]);
      if (peak[metric] - baseline[metric] > allowed)
        failures.push({
          statement,
          rows: peak.rows,
          metric,
          scale: peak.scale,
          baseline: baseline[metric],
          value: peak[metric],
          allowed,
        });
    }
  }
  if (failures.length === 0) return;
  failures.sort((left, right) => right.rows - left.rows);
  const largest = failures[0]!;
  const error = new GrowthBoundError([], samples);
  error.message = `${name}: background statement with largest rows ${JSON.stringify(largest.statement)}; ${largest.metric} per statement grows from ${largest.baseline} to ${largest.value} at scale ${largest.scale}, beyond default slack ${largest.allowed}`;
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
type OperationBackends = Set<number> & { readonly transactions: Map<GrowthDatabase, Map<number, number>> };

const COLD_BACKEND_DISCARD_LIMIT = 4;

function warmedEvidenceSamples(samples: readonly ReportSample[]): ReportSample[] | undefined {
  const warmed: ReportSample[] = [];
  for (const sample of samples) {
    const exhausted = sample.coldBackendExhaustion ?? [];
    if (exhausted.length === 0) {
      warmed.push(sample);
      continue;
    }
    const skip = new Set(exhausted);
    const keep = sample.repetitions.map((_, index) => index).filter((index) => !skip.has(index));
    if (keep.length === 0) return undefined;
    const repetitions = keep.map((index) => sample.repetitions[index]!);
    warmed.push({
      ...sample,
      cost: medianCost(repetitions),
      repetitions,
      statementRepetitions: keep.map((index) => sample.statementRepetitions[index]!),
      occurrenceRepetitions: keep.map((index) => sample.occurrenceRepetitions[index]!),
      ...(sample.backendRepetitions === undefined
        ? {}
        : { backendRepetitions: keep.map((index) => sample.backendRepetitions![index] ?? []) }),
      ...(sample.attempts === undefined
        ? {}
        : {
            attempts: {
              ...sample.attempts,
              repetitions: keep.map((index) => sample.attempts!.repetitions[index]!),
            },
          }),
    });
  }
  return warmed;
}

function operationBackends(
  backends: Iterable<number> = [],
  transactions: Iterable<readonly [GrowthDatabase, ReadonlyMap<number, number>]> = [],
): OperationBackends {
  const value = new Set(backends) as OperationBackends;
  const byDatabase = new Map<GrowthDatabase, Map<number, number>>();
  for (const [database, entries] of transactions) byDatabase.set(database, new Map(entries));
  Object.defineProperty(value, 'transactions', { value: byDatabase });
  return value;
}

export async function checkGrowth(db: GrowthDatabase, check: GrowthCheck): Promise<GrowthReport> {
  return withGrowthCheck(db, () => runGrowthCheck(db, check));
}

async function runGrowthCheck(db: GrowthDatabase, check: GrowthCheck): Promise<GrowthReport> {
  const growthRule = process.env.GROWTH_RULE;
  if (growthRule !== undefined && growthRule !== 'series')
    throw new TypeError(`${check.name}: GROWTH_RULE must be 'series' when set`);
  const profileMode = growthProfileExportMode(process.env.GROWTH_PROFILE_REQUIRED);
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
    let pendingBackends = operationBackends();
    const absorbUnmeasured = (run: Awaited<ReturnType<typeof captureMeasuredRun>>) => {
      for (const backend of run.backends) seenBackends.add(backend);
      for (const target of run.databases) measuredDatabases.add(target);
      for (const [target, relations] of run.writes) {
        const accumulated = pendingWrites.get(target) ?? new Set<string>();
        for (const relation of relations) accumulated.add(relation);
        pendingWrites.set(target, accumulated);
      }
      for (const backend of run.backends) pendingBackends.add(backend);
      for (const [target, transactions] of run.transactions) {
        const collected = pendingBackends.transactions.get(target) ?? new Map<number, number>();
        for (const [backend, transaction] of transactions) collected.set(backend, transaction);
        pendingBackends.transactions.set(target, collected);
      }
    };
    const settlePending = async () => {
      for (const target of pendingWrites.keys()) {
        const workflowStatus = await target.admin.query<{ exists: boolean }>(
          `SELECT to_regclass('"dbos".workflow_status') IS NOT NULL AS exists`,
        );
        if (workflowStatus.rows[0]!.exists) pendingWrites.get(target)!.add('dbos.workflow_status');
      }
      const targets = new Set<GrowthDatabase>([...pendingWrites.keys(), ...pendingBackends.transactions.keys()]);
      for (const target of targets) {
        const relations = [...(pendingWrites.get(target) ?? [])];
        if (relations.length === 0 && (pendingBackends.transactions.get(target)?.size ?? 0) === 0) continue;
        settleMs += await recordedSettle(target, {
          relations,
          operationBackends: pendingBackends,
        });
      }
      (seeding as { settleMs: number }).settleMs = settleMs;
      pendingWrites = new Map();
      pendingBackends = operationBackends();
    };
    for (let warmup = 0; warmup < warmups; warmup++) {
      absorbUnmeasured(
        await captureMeasuredRun(() =>
          captureWarmup(db, async () => {
            if (check.warmup) await check.warmup(db, scale, repetition);
            else await check.operation(db, scale, repetition);
          }),
        ),
      );
      repetition++;
    }

    const costs: Cost[] = [];
    const statementRepetitions: StatementAttribution[][] = [];
    const occurrenceRepetitions: StatementOccurrences[] = [];
    const attemptRuns: AttemptRecord[][] = [];
    const countedRuns: Record<string, number>[] = [];
    const backendRepetitions: number[][] = [];
    let coldBackendDiscards = 0;
    const coldBackendExhaustion: number[] = [];
    for (let run = 0; run < repetitions; run++) {
      let accepted = false;
      while (!accepted) {
        await settlePending();
        if (check.prepare) {
          const prepare = check.prepare;
          absorbUnmeasured(await captureMeasuredRun(() => captureWarmup(db, () => prepare(db, scale, repetition))));
          await settlePending();
        }
        const captured = await captureMeasuredRun(() =>
          capture(db, () => check.operation(db, scale, repetition), { includeBackends: true }),
        );
        for (const target of captured.databases) measuredDatabases.add(target);
        pendingBackends = operationBackends(captured.backends, captured.transactions);
        const writes = captured.writes;
        const measured = captured.value;
        const runBackends = [
          ...new Set(
            (measured.capture.statementBackends ?? []).filter((backend): backend is number => backend !== undefined),
          ),
        ];
        const coldBackends = runBackends.filter((backend) => !seenBackends.has(backend));
        if (coldBackends.length > 0 && coldBackendDiscards < COLD_BACKEND_DISCARD_LIMIT) {
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
        if (coldBackends.length > 0) coldBackendExhaustion.push(backendRepetitions.length);
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
      ...(coldBackendExhaustion.length === 0 ? {} : { coldBackendExhaustion }),
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
  const exhausted = samples.some((sample) => (sample.coldBackendExhaustion?.length ?? 0) > 0);
  const judged = exhausted ? warmedEvidenceSamples(samples) : samples;
  const classifyFrom = judged ?? samples;
  const classified: Record<GrowthMetric, ClassifiedMetric | undefined> = {
    rows: classifyMetric(classifyFrom, check, 'rows'),
    blocks: classifyMetric(classifyFrom, check, 'blocks'),
    statements: classifyMetric(classifyFrom, check, 'statements'),
    requestBytes:
      check.byteBounds?.requestBytes === undefined ? undefined : classifyMetric(classifyFrom, check, 'requestBytes'),
    responseBytes:
      check.byteBounds?.responseBytes === undefined ? undefined : classifyMetric(classifyFrom, check, 'responseBytes'),
  };
  const stepViolations = [
    ...growthViolations(classifyFrom, check.bounds, check.slack),
    ...growthByteViolations(classifyFrom, check.byteBounds ?? {}, check.slack),
  ];
  const stepViolationMetrics = new Set(stepViolations.map(({ metric }) => metric));
  const failedStatements = retryFailures(classifyFrom);
  const settleFailed = samples.some(({ settleFailures: failures }) => (failures?.length ?? 0) > 0);
  const retryExplanations: Partial<Record<GrowthMetric, string>> = {};
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
    const selected = selectedVerdict(
      metric,
      source,
      rule,
      stepViolationMetrics.has(metric),
      settleFailed,
      failedStatements,
      check,
      classifyFrom,
    );
    verdicts[metric] = selected.verdict;
    if (selected.retryExplanation) retryExplanations[metric] = selected.retryExplanation;
  }
  if (judged === undefined) {
    for (const metric of ['rows', 'blocks', 'statements', 'requestBytes', 'responseBytes'] as const) {
      const verdict = verdicts[metric];
      if (verdict) verdicts[metric] = { ...verdict, outcome: 'inconclusive', reason: 'backends' };
    }
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
  appendProfile(report, profileMode);
  if (
    listed &&
    growthRule !== 'series' &&
    (['rows', 'blocks', 'statements'] as const).every((metric) => shadow[metric].outcome === 'compatible')
  ) {
    throw new Error(`${check.name}: series establishes this bound; delete its entry from growth-baseline.ts`);
  }
  for (const metric of ['rows', 'blocks', 'statements', 'requestBytes', 'responseBytes'] as const) {
    const verdict = report.verdicts[metric];
    if (verdict)
      writeGrowthReview(
        check,
        rule,
        metric,
        classified[metric]?.bound,
        verdict,
        samples,
        failedStatements,
        retryExplanations[metric],
      );
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
