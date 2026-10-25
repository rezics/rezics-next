import type { AttemptRecord, StepClass } from './types.ts';

type Percentiles = { count: number; p50: number | null; p90: number | null };
type PoolReport = { attempts: number; passedTasks: number; input: number; cached: number; output: number };

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
  const measured = records.filter(record => record.outcome !== 'pending-gate');
  const byTask = new Map<string, AttemptRecord[]>();
  for (const record of measured) {
    const group = byTask.get(record.taskId) ?? [];
    group.push(record);
    byTask.set(record.taskId, group);
  }

  const passedTasks = [...byTask.values()].filter(group => group.some(record => record.outcome === 'passed'));
  const attemptsPerPassedTask = passedTasks.length
    ? passedTasks.reduce((sum, group) => sum + group.length, 0) / passedTasks.length
    : null;
  const firstAttemptPasses = [...byTask.values()].filter(group =>
    group.some(record => record.attempt === 1 && record.outcome === 'passed')).length;

  const criticalPathDurations: number[] = [];
  const otherDurations: number[] = [];
  for (const group of passedTasks) {
    const passingRecord = group.filter(record => record.outcome === 'passed')
      .sort((a, b) => a.attempt - b.attempt)[0]!;
    const earliestStart = Math.min(...group.map(record => Date.parse(record.startedAt)));
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

  const consulted = measured.filter(record => record.consulted);
  const consultHits = consulted.filter(record => record.outcome === 'passed'
    || byTask.get(record.taskId)?.some(next => next.attempt === record.attempt + 1 && next.outcome === 'passed')).length;
  const stepTotal = stepClasses.reduce((sum, step) => sum + stepTotals[step], 0);
  const stepShare = Object.fromEntries(stepClasses.map(step => [step, stepTotal === 0 ? null : stepTotals[step] / stepTotal])) as Report['stepShare'];

  return {
    attempts: records.length,
    tasks: byTask.size,
    passedTasks: passedTasks.length,
    attemptsPerPassedTask,
    firstAttemptPassRate: byTask.size === 0 ? null : firstAttemptPasses / byTask.size,
    wallClockToPassMs: { criticalPath: percentiles(criticalPathDurations), other: percentiles(otherDurations) },
    pools: Object.fromEntries(poolTotals),
    consultHitRate: consulted.length === 0 ? null : consultHits / consulted.length,
    earlyStopRate: measured.length === 0 ? null : measured.filter(record => record.earlyStop).length / measured.length,
    reworkInputTokens: Object.fromEntries(reworkTotals),
    stepShare,
  };
}
