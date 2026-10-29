import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Attempt, AttemptFailure, AttemptRecord, StepClass, Task, Tokens } from './types.ts';
import { agentAdapter, allAgentAdapters, parseAgentExit, type AgentAdapter, type SessionUsage } from './agents.ts';

export const CLASSIFIER_VERSION = '1';
export const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0 });
export const ATTEMPT_LOG_TAIL_BYTES = 256 * 1024;

/** Read a bounded suffix, discarding its first partial line so consumers only parse complete events. */
export function readLogTail(path: string, maxBytes = ATTEMPT_LOG_TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, size - length + read);
      if (!count) break;
      read += count;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (size > length) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export const emptySteps = (): Record<StepClass, number> => ({
  decision: 0,
  read: 0,
  edit: 0,
  wait: 0,
  check: 0,
  commit: 0,
});
/** Fixed precedence: one observable tool operation receives one class. Unknown operations are decisions. */
export function classifyStep(name: string, input: string): StepClass {
  const text = `${name} ${input}`;
  if (/\bgit\s+(commit|tag)\b/.test(text)) return 'commit';
  if (/\b(wait|sleep|write_stdin)\b/.test(name) || (/\byield_time_ms\b/.test(input) && /\bwrite_stdin\b/.test(input)))
    return 'wait';
  if (/\b(test|typecheck|check|lint|pytest|vitest|tsc)\b/.test(text)) return 'check';
  if (
    /apply_patch|file_change|write_file|edit_file/.test(name) ||
    /\b(sed\s+-i|tee|cat\s*>|python.*write)\b/.test(input)
  )
    return 'edit';
  if (
    /read_file|search|browse|web|view_image/.test(name) ||
    /\b(rg|cat|head|tail|git\s+(show|diff|log|status)|ls|find)\b/.test(input)
  )
    return 'read';
  return 'decision';
}
/**
 * A check host that dropped the connection (sshd throttling, a transport reset) failed the attempt, not its work: the
 * attempt is continued like a capacity refusal and never counts toward a repeated launch failure.
 */
export const CHECK_HOST_TRANSPORT =
  /RemoteTransportError|Connection closed by [0-9a-f.:]+ port 22|kex_exchange_identification|ssh: connect to host|Connection reset by peer|rsync error: (?:unexplained error|error in rsync protocol)|SSH (?:exit(?:ed)? )?255|exit(?:ed)? (?:with )?(?:code )?255|(?:^|\n)curl: \((?:6|7|18|28|35|52|56)\)|gzip: stdin: unexpected end of file|tar: Unexpected EOF in archive|remote-check: downloaded Bun does not match packageManager/i;
export { MODEL_AT_CAPACITY, POOL_EXHAUSTED, USAGE_LIMIT_REFUSAL, isUsageLimitRefusal } from './agents/shared.ts';
export type { SessionUsage } from './agents.ts';
export type LogMeasurement = {
  tokens: Tokens;
  total: Tokens;
  usage: SessionUsage | null;
  usageSource?: 'codex-session' | 'attempt-profile';
  steps: Record<StepClass, number>;
  session: string | null;
  result: string;
  blocker: string | null;
  failureKind: AttemptFailure | null;
  usageLimitRefusal: boolean;
  waitingChecks: string[] | null;
};

/** Cumulative totals are differenced, duplicate snapshots contribute zero, and pre-window totals establish a baseline. */
export function measureLog(
  text: string,
  options: { startedAt?: string; endedAt?: string; baseline?: Tokens; adapter?: AgentAdapter } = {},
): LogMeasurement {
  const start = options.startedAt ? Date.parse(options.startedAt) : -Infinity;
  const end = options.endedAt ? Date.parse(options.endedAt) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error('invalid measurement interval');
  const lines = text.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  // Accept either JSON Lines or one JSON document.
  const events = lines.length
    ? lines
    : (() => {
        try {
          return [JSON.parse(text)];
        } catch {
          return [];
        }
      })();
  const adapters = options.adapter ? [options.adapter] : allAgentAdapters();
  const hasRollout = adapters.some((adapter) => adapter.hasRollout?.(events));
  let previous = options.baseline ?? emptyTokens();
  const result: LogMeasurement = {
    tokens: emptyTokens(),
    total: previous,
    usage: null,
    steps: emptySteps(),
    session: null,
    result: '',
    blocker: null,
    failureKind: null,
    usageLimitRefusal: false,
    waitingChecks: null,
  };
  const seen = new Set<string>();
  // The last answer that ended a turn with a report or a blocker; see the end of the loop.
  let answered: string | null = null;
  for (const event of events) {
    const eventAdapters = adapters.filter((adapter) => adapter.matchesEvent(event));
    const at = event.timestamp ? Date.parse(event.timestamp) : start;
    const inside = at >= start && at <= end;
    if (at > end) continue;
    const failure = eventAdapters.map((adapter) => adapter.failure(event)).find((value) => value !== null);
    if (inside && failure !== undefined && failure !== null) {
      result.result = failure || result.result;
      const limited = eventAdapters.some((adapter) => adapter.isRateLimit(event));
      result.failureKind =
        limited ||
        result.failureKind === 'pool-exhausted' ||
        eventAdapters.some((adapter) => adapter.signals?.(result.result).allowance)
          ? 'pool-exhausted'
          : 'tool';
      result.usageLimitRefusal ||=
        eventAdapters.some((adapter) => adapter.isUsageLimit?.(event)) ||
        eventAdapters.some((adapter) => adapter.signals?.(result.result).usageLimit);
    }
    if (inside && eventAdapters.some((adapter) => adapter.completed(event))) result.failureKind = null;
    if (inside && eventAdapters.some((adapter) => adapter.isRateLimit(event))) result.failureKind = 'pool-exhausted';
    for (const adapter of eventAdapters) result.session = adapter.sessionId(event) ?? result.session;
    const observation = adapters
      .map((adapter) => adapter.parseEvent?.(event, hasRollout))
      .find((value) => value != null);
    const usage = observation?.usage;
    if (usage) {
      const current = usage.tokens;
      if (inside)
        for (const key of ['input', 'cached', 'output'] as const) {
          result.tokens[key] += usage.delta ? current[key] : Math.max(0, current[key] - previous[key]);
        }
      previous = {
        input: Math.max(previous.input, current.input),
        cached: Math.max(previous.cached, current.cached),
        output: Math.max(previous.output, current.output),
      };
      result.total = previous;
    }
    if (!inside) continue;
    for (const step of observation?.steps ?? []) {
      if (step.id && seen.has(step.id)) continue;
      if (step.id) seen.add(step.id);
      result.steps[classifyStep(step.name, step.input)]++;
    }
    if (observation?.answer !== undefined) result.result = observation.answer;
    if (observation?.final && isFinalAnswer(result.result, options.adapter)) answered = result.result;
  }
  // A worker whose background command finishes after its report is woken once more, and answers that
  // notification in a later result ("my report above stands"): the report it gave stays its final answer.
  if (answered !== null && !isFinalAnswer(result.result, options.adapter)) result.result = answered;
  const blocker = /^BLOCKER:\s*(.+)$/im.exec(result.result)?.[1]?.trim();
  result.blocker = blocker && !/^(none|no(?: blockers?)?|n\/a|not blocked)\.?$/i.test(blocker) ? blocker : null;
  try {
    // A CLI without an enforced output schema may wrap the status object in prose; take the last object that parses.
    const exit = parseAgentExit(result.result, options.adapter) as {
      status?: unknown;
      blocker?: { kind?: unknown; detail?: unknown };
      checks?: unknown;
    } | null;
    if (
      exit?.status === 'blocked' &&
      exit.blocker &&
      typeof exit.blocker.kind === 'string' &&
      ['spec-conflict', 'scope-growth', 'tool'].includes(exit.blocker.kind) &&
      typeof exit.blocker.detail === 'string'
    ) {
      result.failureKind = exit.blocker.kind as AttemptFailure;
      result.blocker = exit.blocker.detail;
    }
    if (
      exit?.status === 'waiting' &&
      Array.isArray(exit.checks) &&
      exit.checks.length > 0 &&
      exit.checks.every((id: unknown) => typeof id === 'string' && /^[\w-]+$/.test(id))
    )
      result.waitingChecks = [...new Set(exit.checks as string[])];
  } catch {
    /* Historical human-readable handoffs remain importable. */
  }
  const ledger =
    adapters.map((adapter) => adapter.parseUsage(events, start, end)).find((usage) => usage !== null) ?? null;
  if (ledger) {
    result.tokens = ledger.tokens;
    result.total = ledger.tokens;
    result.usage = ledger.usage;
    if (ledger.source) result.usageSource = ledger.source;
  }
  return result;
}
/** Whether an answer reports success or states a blocker, as a worker's final answer does. */
function isFinalAnswer(text: string, adapter?: AgentAdapter): boolean {
  const exit = parseAgentExit(text, adapter);
  return (
    reportsSuccess(text, adapter) ||
    /^BLOCKER:/im.test(text) ||
    (!!exit && typeof exit === 'object' && 'status' in exit)
  );
}
/** Whether a worker's final answer reports success: its status object, or the older RESULT line. */
export function reportsSuccess(result: string, adapter?: AgentAdapter): boolean {
  if (/^RESULT:\s*success\b/im.test(result)) return true;
  const exit = parseAgentExit(result, adapter) as { status?: unknown } | null;
  return exit?.status === 'success';
}
export function makeRecord(
  task: Task,
  attempt: Attempt,
  measurement: LogMeasurement,
  outcome: AttemptRecord['outcome'] = 'pending-gate',
): AttemptRecord {
  return {
    taskId: task.id,
    attempt: attempt.attempt,
    taskClass: task.taskClass,
    profile: attempt.profile,
    pool: attempt.pool,
    tableVersion: attempt.tableVersion,
    experiment: attempt.experiment,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt ?? new Date().toISOString(),
    steps: Object.values(measurement.steps).reduce((a, b) => a + b, 0),
    criticalPath: task.brief.criticalPath,
    tokens: measurement.tokens,
    before: attempt.before,
    after: attempt.after,
    outcome,
    firstFailure: attempt.failure?.fingerprint ?? null,
    escalation: attempt.escalation,
    consulted: attempt.consulted,
    fixRound: attempt.fixRound,
    diffLines: 0,
    changedFiles: [],
    hostMs: 0,
    classifierVersion: CLASSIFIER_VERSION,
    stepClasses: measurement.steps,
    earlyStop: false,
    usage: {
      model: measurement.usage?.model ?? attempt.profile.model,
      effort: measurement.usage?.effort ?? attempt.profile.effort,
      serviceTier: measurement.usage?.serviceTier ?? attempt.profile.serviceTier ?? null,
      input: measurement.tokens.input,
      cachedInput: measurement.tokens.cached,
      output: measurement.tokens.output,
      reasoning: measurement.usage?.reasoning ?? 0,
      compactions: measurement.usage?.compactions ?? 0,
      source: measurement.usageSource ?? 'attempt-profile',
    },
  };
}
export type MeasurementOptions = { baseline?: Tokens; configDirectory?: string | undefined };
export function readMeasurement(
  attempt: Attempt,
  options: MeasurementOptions & { maxLogBytes?: number } = {},
): LogMeasurement {
  let text = '';
  if (options.maxLogBytes !== undefined) text = readLogTail(attempt.logPath, options.maxLogBytes);
  else
    try {
      text = readFileSync(attempt.logPath, 'utf8');
    } catch {
      /* A failed spawn has no stream. */
    }
  const interval = { startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}) };
  // Historical records can lack a profile; their event/session formats select an adapter instead.
  const selected = attempt.profile && agentAdapter(attempt.profile.cli);
  const adapters = selected ? [selected] : allAgentAdapters();
  const measurement = measureLog(text, {
    ...(selected ? { adapter: selected } : {}),
    ...interval,
    ...(options.baseline ? { baseline: options.baseline } : {}),
  });
  const completed = text.split('\n').some((line) => {
    try {
      const event = JSON.parse(line);
      return adapters.some((adapter) => adapter.completed(event));
    } catch {
      return false;
    }
  });
  if (!options.configDirectory) return measurement;
  const session = measurement.session ?? attempt.session;
  if (!session) return measurement;
  const source = adapters
    .map((adapter) => ({ adapter, rollout: adapter.readSession?.(options.configDirectory!, session) ?? null }))
    .find(({ rollout }) => rollout !== null);
  if (!source) return measurement;
  const { adapter, rollout } = source;
  const usage = measureLog(rollout!, {
    adapter,
    ...interval,
    ...(options.baseline ? { baseline: options.baseline } : {}),
  });
  if (usage.usage || !completed)
    return {
      ...measurement,
      tokens: usage.tokens,
      total: usage.total,
      usage: usage.usage ?? measurement.usage,
      ...(usage.usageSource ? { usageSource: usage.usageSource } : {}),
      session,
    };
  return { ...measurement, session };
}

/** Only the bounded approach/result fields enter evidence; the rest of the session stays in its raw log. */
export function reportedApproaches(result: string, adapter?: AgentAdapter): { approach: string; result: string }[] {
  try {
    const value = parseAgentExit(result, adapter) as { approaches?: { approach?: unknown; result?: unknown }[] } | null;
    if (Array.isArray(value?.approaches))
      return value.approaches.filter(
        (item: { approach?: unknown; result?: unknown }): item is { approach: string; result: string } =>
          typeof item.approach === 'string' && typeof item.result === 'string',
      );
  } catch {
    /* Legacy handoffs use two bounded lines. */
  }
  return [...result.matchAll(/^APPROACH:[ \t]*(.+)\r?\nOUTCOME:[ \t]*(.+)$/gim)].map((match) => ({
    approach: match[1]!.trim().slice(0, 1000),
    result: match[2]!.trim().slice(0, 2000),
  }));
}
