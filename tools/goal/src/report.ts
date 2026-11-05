import type { AttemptRecord, StepClass, TaskClass } from './types.ts';
import type { LifecycleMetrics } from './lifecycle-metrics.ts';
import { formatWidthSnapshot } from './width-governor.ts';

type Percentiles = { count: number; p50: number | null; p90: number | null };
type PoolReport = { attempts: number; passedTasks: number; input: number; cached: number; output: number };
export type LandedUsageReport = {
  taskClass: TaskClass;
  model: string;
  landedTasks: number;
  attempts: number;
  inputPerTask: number;
  cachedInputPerTask: number;
  outputPerTask: number;
  reasoningPerTask: number;
  rawPerTask: number;
  compactionsPerTask: number;
};

export type Report = {
  urgent: { tasks: string[]; attempts: number; passedTasks: number };
  verifiedProofs: number;
  proofAttempts: number;
  attempts: number;
  tasks: number;
  passedTasks: number;
  attemptsPerPassedTask: number | null;
  firstAttemptPassRate: number | null;
  wallClockToPassMs: { criticalPath: Percentiles; other: Percentiles };
  pools: Record<string, PoolReport>;
  consultHitRate: number | null;
  earlyStopRate: number | null;
  reworkInputTokens: Record<string, number>;
  stepShare: Record<StepClass, number | null>;
  tokensPerLandedTask: LandedUsageReport[];
  nonLandingSpend: { rawTokens: number; totalRawTokens: number; share: number | null };
};

const stepClasses: StepClass[] = ['decision', 'read', 'edit', 'wait', 'check', 'commit'];

type TaskProjection = {
  attempts: number;
  earliestStartedAt: number;
  firstPassing: AttemptRecord | null;
  latestPassing: AttemptRecord | null;
  passingAttempts: Set<number>;
  firstAttemptPassed: boolean;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  raw: number;
  compactions: number;
};

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

function percentiles(values: number[]): Percentiles {
  return { count: values.length, p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
}

/** Summarize measurements from completed attempt records, excluding attempts still waiting on a gate. */
export function report(records: AttemptRecord[]): Report {
  const byTask = new Map<string, TaskProjection>();
  const poolTotals = new Map<string, PoolReport>();
  const reworkTotals = new Map<string, number>();
  const stepTotals: Record<StepClass, number> = { decision: 0, read: 0, edit: 0, wait: 0, check: 0, commit: 0 };
  const urgentTasks = new Set<string>();
  const urgentPassedTasks = new Set<string>();
  const verifiedProofs = new Set<string>();
  const consultedAttempts: { taskId: string; attempt: number }[] = [];
  let proofAttempts = 0;
  let measuredAttempts = 0;
  let totalRawTokens = 0;
  let nonLandingRawTokens = 0;
  let consultedCount = 0;
  let consultHits = 0;
  let earlyStops = 0;
  let urgentAttempts = 0;

  for (const record of records) {
    if (record.taskKind === 'verification') proofAttempts++;
    if (record.outcome === 'pending-gate') continue;

    measuredAttempts++;
    const input = record.usage?.input ?? record.tokens.input;
    const cached = record.usage?.cachedInput ?? record.tokens.cached;
    const output = record.usage?.output ?? record.tokens.output;
    const raw = input + output;
    totalRawTokens += raw;
    if (record.outcome !== 'passed') nonLandingRawTokens += raw;

    if (record.taskKind !== 'verification' && !record.urgent) {
      const group = byTask.get(record.taskId) ?? {
        attempts: 0,
        earliestStartedAt: Number.POSITIVE_INFINITY,
        firstPassing: null,
        latestPassing: null,
        passingAttempts: new Set<number>(),
        firstAttemptPassed: false,
        input: 0,
        cached: 0,
        output: 0,
        reasoning: 0,
        raw: 0,
        compactions: 0,
      };
      group.attempts++;
      group.earliestStartedAt = Math.min(group.earliestStartedAt, Date.parse(record.startedAt));
      group.input += input;
      group.cached += cached;
      group.output += output;
      group.reasoning += record.usage?.reasoning ?? 0;
      group.raw += raw;
      group.compactions += record.usage?.compactions ?? 0;
      if (record.outcome === 'passed') {
        group.passingAttempts.add(record.attempt);
        if (!group.firstPassing || record.attempt < group.firstPassing.attempt) group.firstPassing = record;
        if (!group.latestPassing || record.attempt > group.latestPassing.attempt) group.latestPassing = record;
        if (record.attempt === 1) group.firstAttemptPassed = true;
      }
      byTask.set(record.taskId, group);
    }

    if (record.urgent) {
      urgentTasks.add(record.taskId);
      urgentAttempts++;
      if (record.outcome === 'passed') urgentPassedTasks.add(record.taskId);
    }
    if (record.outcome === 'verified') verifiedProofs.add(record.taskId);
    if (record.consulted) {
      consultedCount++;
      if (record.outcome === 'passed') consultHits++;
      else consultedAttempts.push({ taskId: record.taskId, attempt: record.attempt });
    }
    if (record.earlyStop) earlyStops++;

    const pool = poolTotals.get(record.pool) ?? { attempts: 0, passedTasks: 0, input: 0, cached: 0, output: 0 };
    pool.attempts++;
    if (record.outcome === 'passed' && !record.urgent) pool.passedTasks++;
    pool.input += record.tokens.input;
    pool.cached += record.tokens.cached;
    pool.output += record.tokens.output;
    poolTotals.set(record.pool, pool);

    if (record.outcome !== 'passed') {
      const key = record.escalation ?? record.outcome;
      reworkTotals.set(key, (reworkTotals.get(key) ?? 0) + record.tokens.input);
    }
    for (const step of stepClasses) stepTotals[step] += record.stepClasses[step];
  }

  for (const { taskId, attempt } of consultedAttempts) {
    if (byTask.get(taskId)?.passingAttempts.has(attempt + 1)) consultHits++;
  }

  const landedTotals = new Map<
    string,
    {
      taskClass: TaskClass;
      model: string;
      landedTasks: number;
      attempts: number;
      input: number;
      cached: number;
      output: number;
      reasoning: number;
      raw: number;
      compactions: number;
    }
  >();
  const criticalPathDurations: number[] = [];
  const otherDurations: number[] = [];
  let passedTaskCount = 0;
  let passedTaskAttempts = 0;
  let firstAttemptPasses = 0;
  for (const group of byTask.values()) {
    if (group.firstAttemptPassed) firstAttemptPasses++;
    if (!group.firstPassing) continue;

    passedTaskCount++;
    passedTaskAttempts += group.attempts;
    const winner = group.latestPassing!;
    const taskClass = winner.taskClass;
    const model = winner.usage?.model ?? winner.profile.model;
    const key = JSON.stringify([taskClass, model]);
    const total = landedTotals.get(key) ?? {
      taskClass,
      model,
      landedTasks: 0,
      attempts: 0,
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      raw: 0,
      compactions: 0,
    };
    total.landedTasks++;
    total.attempts += group.attempts;
    total.input += group.input;
    total.cached += group.cached;
    total.output += group.output;
    total.reasoning += group.reasoning;
    total.compactions += group.compactions;
    total.raw += group.raw;
    landedTotals.set(key, total);

    const passingRecord = group.firstPassing;
    const duration = Date.parse(passingRecord.endedAt) - group.earliestStartedAt;
    (passingRecord.criticalPath ? criticalPathDurations : otherDurations).push(duration);
  }
  const tokensPerLandedTask = [...landedTotals.values()]
    .sort((a, b) => a.taskClass.localeCompare(b.taskClass) || a.model.localeCompare(b.model))
    .map((total) => ({
      taskClass: total.taskClass,
      model: total.model,
      landedTasks: total.landedTasks,
      attempts: total.attempts,
      inputPerTask: total.input / total.landedTasks,
      cachedInputPerTask: total.cached / total.landedTasks,
      outputPerTask: total.output / total.landedTasks,
      reasoningPerTask: total.reasoning / total.landedTasks,
      rawPerTask: total.raw / total.landedTasks,
      compactionsPerTask: total.compactions / total.landedTasks,
    }));
  const stepTotal = stepClasses.reduce((sum, step) => sum + stepTotals[step], 0);
  const stepShare = Object.fromEntries(
    stepClasses.map((step) => [step, stepTotal === 0 ? null : stepTotals[step] / stepTotal]),
  ) as Report['stepShare'];

  return {
    urgent: {
      tasks: [...urgentTasks],
      attempts: urgentAttempts,
      passedTasks: urgentPassedTasks.size,
    },
    proofAttempts,
    verifiedProofs: verifiedProofs.size,
    attempts: records.length,
    tasks: byTask.size,
    passedTasks: passedTaskCount,
    attemptsPerPassedTask: passedTaskCount ? passedTaskAttempts / passedTaskCount : null,
    firstAttemptPassRate: byTask.size === 0 ? null : firstAttemptPasses / byTask.size,
    wallClockToPassMs: { criticalPath: percentiles(criticalPathDurations), other: percentiles(otherDurations) },
    pools: Object.fromEntries(poolTotals),
    consultHitRate: consultedCount === 0 ? null : consultHits / consultedCount,
    earlyStopRate: measuredAttempts === 0 ? null : earlyStops / measuredAttempts,
    reworkInputTokens: Object.fromEntries(reworkTotals),
    stepShare,
    tokensPerLandedTask,
    nonLandingSpend: {
      rawTokens: nonLandingRawTokens,
      totalRawTokens,
      share: totalRawTokens === 0 ? null : nonLandingRawTokens / totalRawTokens,
    },
  };
}

/** Human-readable usage figures shared by the goal report command and its tests. */
export function formatUsageReport(result: Report): string[] {
  const number = (value: number) => Math.round(value).toLocaleString('en-US');
  const share = result.nonLandingSpend.share === null ? 'n/a' : `${(result.nonLandingSpend.share * 100).toFixed(1)}%`;
  return [
    'Tokens per landed task by class and winning model:',
    ...(result.tokensPerLandedTask.length
      ? result.tokensPerLandedTask.map(
          (row) =>
            `  ${row.taskClass} / ${row.model}: ${number(row.rawPerTask)} raw; ${number(row.inputPerTask)} input (${number(row.cachedInputPerTask)} cached); ${number(row.outputPerTask)} output; ${number(row.reasoningPerTask)} reasoning; ${number(row.compactionsPerTask)} compactions.`,
        )
      : ['  (no landed tasks)']),
    `Spend on attempts that did not land: ${share} (${number(result.nonLandingSpend.rawTokens)} / ${number(result.nonLandingSpend.totalRawTokens)} raw tokens).`,
  ];
}

/** Human-readable lifecycle measurements shared by the flow report and its CLI output. */
export function formatLifecycleMetrics(metrics: LifecycleMetrics): string[] {
  const age = (value: number | null) => (value === null ? 'unknown' : `${Math.round(value / 60_000)}m`);
  const attempts = metrics.attemptsPerTaskPerTrailingHour;
  const waiting = metrics.waiting;
  const orphaned = metrics.orphanedLandings;
  const promotion = metrics.promotion;
  const quarantines = metrics.quarantines;
  // Persisted snapshots from before conflict telemetry have no conflict fields.
  const conflicts = metrics.conflicts;
  const outcomes = conflicts?.recordedOutcomes;
  const created = conflicts?.createdAttempts;
  const devOutcomes = conflicts?.devResolverOutcomes;
  const coverage = (value: { available: boolean; complete: boolean } | undefined) =>
    !value?.available
      ? 'unavailable'
      : value.complete
        ? 'complete recorded window'
        : 'truncated recorded window (lower bounds)';
  const observedTiming = outcomes?.observationToLandedMs;
  const returnReasons = devOutcomes?.returnedToWorker.reasons;
  const reasonLabel = (value: string) =>
    value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  const returnReasonSummary = returnReasons?.length
    ? `${returnReasons
        .slice(0, 3)
        .map(({ reason, count }) => `${count} × ${reasonLabel(reason)}`)
        .join('; ')}${returnReasons.length > 3 ? `; ${returnReasons.length - 3} more reasons omitted` : ''}`
    : 'none recorded';
  return [
    `Launches in trailing hour: ${attempts.total}; tasks with launches: ${attempts.taskCount}; mean per task: ${attempts.meanPerTask?.toFixed(2) ?? 'unknown'}.`,
    ...attempts.perTask.map(
      (task) => `  ${task.taskId}: ${task.launches} launches (${task.sameAttemptResumes} same-attempt resumes).`,
    ),
    `Current waits: ${waiting.count}; oldest age ${age(waiting.oldestAgeMs)}; unknown ages ${waiting.unknownAgeCount}.`,
    `Orphaned landings: ${orphaned.available ? orphaned.count : 'unknown'}${orphaned.taskIds.length ? ` (${orphaned.taskIds.join(', ')})` : ''}.`,
    `Promotion phase: ${promotion.phase ?? (promotion.available ? 'none' : 'unknown')}; age ${age(promotion.phaseAgeMs)}.`,
    `Quarantines: current ${quarantines.currentCount ?? 'unknown'}; recent new ${quarantines.recentNewCount ?? 'unknown'}; causes ${quarantines.currentByCause ? JSON.stringify(quarantines.currentByCause) : 'unknown'}.`,
    `Owner-landing capability: unavailable; ${conflicts?.reason ?? 'This historical snapshot did not record conflict metrics.'}`,
    `Conflicts in trailing hour: ${outcomes?.observedCount ?? 'unknown'} observed; ${outcomes?.unclassifiedCount ?? 'unknown'} unclassified rebase outcomes; total unknown; ${coverage(outcomes)}.`,
    devOutcomes?.available
      ? `Dev resolver conflicts in trailing hour: ${devOutcomes.resolvedAndLanded ?? 'unknown'} resolved and landed; ${devOutcomes.returnedToWorker.count ?? 'unknown'} returned to worker (reasons: ${returnReasonSummary}); ${devOutcomes.inProgress ?? 'unknown'} still in progress; ${coverage(devOutcomes)}.`
      : 'Dev resolver conflicts in trailing hour: unknown (flow outcome history unavailable).',
    'Conflict-to-landed duration: unknown; open conflict count/oldest age: unknown; resolution owner/rerere/replay: unknown.',
    `Trailing-hour outcome observations to landed${outcomes?.available && !outcomes.complete ? ' (sample)' : ''}: ${observedTiming?.count ?? 'unknown'} timed; p50 ${age(observedTiming?.p50Ms ?? null)}; p90 ${age(observedTiming?.p90Ms ?? null)}; unlanded ${outcomes?.unlandedCount ?? 'unknown'}; oldest observation age ${age(outcomes?.oldestUnlandedObservationAgeMs ?? null)}; unknown timing ${outcomes?.unknownTimingCount ?? 'unknown'}.`,
    `Conflict-created attempts in trailing hour: ${created?.observedCount ?? 'unknown'} observed; ${created?.unknownCauseCount ?? 'unknown'} unknown causes; total unknown; ${coverage(created)}.`,
    ...formatWidthSnapshot(metrics.width),
  ];
}
