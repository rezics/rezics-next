import type { AttemptRecord, StepClass, TaskClass } from './types.ts';
import type { LifecycleMetrics } from './lifecycle-metrics.ts';

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
  const measured = records.filter((record) => record.outcome !== 'pending-gate');
  const byTask = new Map<string, AttemptRecord[]>();
  for (const record of measured) {
    const group = byTask.get(record.taskId) ?? [];
    group.push(record);
    byTask.set(record.taskId, group);
  }

  const passedTasks = [...byTask.values()].filter((group) => group.some((record) => record.outcome === 'passed'));
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
  for (const group of passedTasks) {
    const winner = group.filter((record) => record.outcome === 'passed').sort((a, b) => b.attempt - a.attempt)[0]!;
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
    total.attempts += group.length;
    for (const record of group) {
      const input = record.usage?.input ?? record.tokens.input;
      const cached = record.usage?.cachedInput ?? record.tokens.cached;
      const output = record.usage?.output ?? record.tokens.output;
      total.input += input;
      total.cached += cached;
      total.output += output;
      total.reasoning += record.usage?.reasoning ?? 0;
      total.compactions += record.usage?.compactions ?? 0;
      total.raw += input + output;
    }
    landedTotals.set(key, total);
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
  const rawTokens = (record: AttemptRecord) =>
    (record.usage?.input ?? record.tokens.input) + (record.usage?.output ?? record.tokens.output);
  const totalRawTokens = measured.reduce((sum, record) => sum + rawTokens(record), 0);
  const nonLandingRawTokens = measured
    .filter((record) => record.outcome !== 'passed')
    .reduce((sum, record) => sum + rawTokens(record), 0);
  const attemptsPerPassedTask = passedTasks.length
    ? passedTasks.reduce((sum, group) => sum + group.length, 0) / passedTasks.length
    : null;
  const firstAttemptPasses = [...byTask.values()].filter((group) =>
    group.some((record) => record.attempt === 1 && record.outcome === 'passed'),
  ).length;

  const criticalPathDurations: number[] = [];
  const otherDurations: number[] = [];
  for (const group of passedTasks) {
    const passingRecord = group
      .filter((record) => record.outcome === 'passed')
      .sort((a, b) => a.attempt - b.attempt)[0]!;
    const earliestStart = Math.min(...group.map((record) => Date.parse(record.startedAt)));
    const duration = Date.parse(passingRecord.endedAt) - earliestStart;
    (passingRecord.criticalPath ? criticalPathDurations : otherDurations).push(duration);
  }

  const poolTotals = new Map<string, PoolReport>();
  const reworkTotals = new Map<string, number>();
  const stepTotals: Record<StepClass, number> = { decision: 0, read: 0, edit: 0, wait: 0, check: 0, commit: 0 };
  for (const record of measured) {
    const pool = poolTotals.get(record.pool) ?? { attempts: 0, passedTasks: 0, input: 0, cached: 0, output: 0 };
    pool.attempts++;
    if (record.outcome === 'passed') pool.passedTasks++;
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

  const consulted = measured.filter((record) => record.consulted);
  const consultHits = consulted.filter(
    (record) =>
      record.outcome === 'passed' ||
      byTask.get(record.taskId)?.some((next) => next.attempt === record.attempt + 1 && next.outcome === 'passed'),
  ).length;
  const stepTotal = stepClasses.reduce((sum, step) => sum + stepTotals[step], 0);
  const stepShare = Object.fromEntries(
    stepClasses.map((step) => [step, stepTotal === 0 ? null : stepTotals[step] / stepTotal]),
  ) as Report['stepShare'];

  return {
    attempts: records.length,
    tasks: byTask.size,
    passedTasks: passedTasks.length,
    attemptsPerPassedTask,
    firstAttemptPassRate: byTask.size === 0 ? null : firstAttemptPasses / byTask.size,
    wallClockToPassMs: { criticalPath: percentiles(criticalPathDurations), other: percentiles(otherDurations) },
    pools: Object.fromEntries(poolTotals),
    consultHitRate: consulted.length === 0 ? null : consultHits / consulted.length,
    earlyStopRate:
      measured.length === 0 ? null : measured.filter((record) => record.earlyStop).length / measured.length,
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
  return [
    `Launches in trailing hour: ${attempts.total}; tasks with launches: ${attempts.taskCount}; mean per task: ${attempts.meanPerTask?.toFixed(2) ?? 'unknown'}.`,
    ...attempts.perTask.map(
      (task) =>
        `  ${task.taskId}: ${task.launches} launches (${task.sameAttemptResumes} same-attempt resumes).`,
    ),
    `Current waits: ${waiting.count}; oldest age ${age(waiting.oldestAgeMs)}; unknown ages ${waiting.unknownAgeCount}.`,
    `Orphaned landings: ${orphaned.available ? orphaned.count : 'unknown'}${orphaned.taskIds.length ? ` (${orphaned.taskIds.join(', ')})` : ''}.`,
    `Promotion phase: ${promotion.phase ?? (promotion.available ? 'none' : 'unknown')}; age ${age(promotion.phaseAgeMs)}.`,
    `Quarantines: current ${quarantines.currentCount ?? 'unknown'}; recent new ${quarantines.recentNewCount ?? 'unknown'}; causes ${quarantines.currentByCause ? JSON.stringify(quarantines.currentByCause) : 'unknown'}.`,
  ];
}
