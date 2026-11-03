import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import type { Attempt, AttemptFailure, AttemptRecord, StepClass, Task, Tokens } from './types.ts';
import {
  agentAdapter,
  allAgentAdapters,
  parseAgentExit,
  type AgentAdapter,
  type AgentUsage,
  type AgentUsageAccumulator,
  type SessionUsage,
} from './agents.ts';
import { scanSessionJsonl } from './session-accounting.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';

export const CLASSIFIER_VERSION = '1';
export const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0 });
export const ATTEMPT_LOG_TAIL_BYTES = defaultPolicy.worker.logTailBytes;

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
/** Read output appended after a particular run began, optionally keeping only its bounded suffix. */
export function readLogFromOffset(path: string, offset: number, maxBytes = Number.POSITIVE_INFINITY): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, Math.min(size, Math.floor(offset)));
    const readStart = Math.max(start, size - maxBytes);
    const length = size - readStart;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, readStart + read);
      if (!count) break;
      read += count;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (readStart > 0) {
      const previous = Buffer.alloc(1);
      const gotPrevious = readSync(fd, previous, 0, 1, readStart - 1);
      if (gotPrevious && previous[0] !== 10) {
        const newline = text.indexOf('\n');
        text = newline < 0 ? '' : text.slice(newline + 1);
      }
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
  options: {
    startedAt?: string;
    endedAt?: string;
    baseline?: Tokens;
    adapter?: AgentAdapter;
    policy?: ControlPolicy;
  } = {},
): LogMeasurement {
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
  const state = measurementState(options, adapters, hasRollout);
  for (const event of events) state.add(event);
  const ledger =
    adapters
      .map((adapter) => adapter.parseUsage(events, state.start, state.end, options.policy?.provider))
      .find((usage) => usage !== null) ?? null;
  return state.finish(ledger);
}

type MeasurementState = {
  start: number;
  end: number;
  add(event: Record<string, any>): void;
  finish(ledger: AgentUsage | null): LogMeasurement;
  readonly hasUsage: boolean;
  readonly exactUsage: boolean;
};

function measurementState(
  options: { startedAt?: string; endedAt?: string; baseline?: Tokens; adapter?: AgentAdapter; policy?: ControlPolicy },
  adapters: AgentAdapter[],
  hasRollout: boolean,
): MeasurementState {
  const start = options.startedAt ? Date.parse(options.startedAt) : -Infinity;
  const end = options.endedAt ? Date.parse(options.endedAt) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error('invalid measurement interval');
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
  let hasUsage = false;
  let cumulativeBaselineKnown = options.baseline !== undefined;
  let exactUsage = true;

  return {
    start,
    end,
    add(event) {
      const eventAdapters = adapters.filter((adapter) => adapter.matchesEvent(event));
      const at = event.timestamp ? Date.parse(event.timestamp) : start;
      const inside = at >= start && at <= end;
      if (at > end) return;
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
        hasUsage = true;
        if (!usage.delta) {
          if (!inside && at < start) cumulativeBaselineKnown = true;
          else if (inside && !cumulativeBaselineKnown) exactUsage = false;
        }
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
      if (!inside) return;
      for (const step of observation?.steps ?? []) {
        if (step.id && seen.has(step.id)) continue;
        if (step.id) seen.add(step.id);
        result.steps[classifyStep(step.name, step.input)]++;
      }
      if (observation?.answer !== undefined) result.result = observation.answer;
      if (observation?.final && isFinalAnswer(result.result, options.adapter)) answered = result.result;
    },
    get hasUsage() {
      return hasUsage;
    },
    get exactUsage() {
      return exactUsage;
    },
    finish(ledger) {
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
        if (exit?.status === 'waiting' && Array.isArray(exit.checks) && exit.checks.length > 0) {
          // Workers sometimes label an id ("Focused acceptance check: <uuid>"); rejecting the label superseded the attempt
          // and started its checks again (three times for one task on 2026-10-29), so the id is taken from the label.
          const ids = (exit.checks as unknown[]).map((entry) =>
            typeof entry !== 'string'
              ? null
              : /^[\w-]+$/.test(entry)
                ? entry
                : (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(entry)?.[0] ?? null),
          );
          if (ids.every((id): id is string => id !== null)) result.waitingChecks = [...new Set(ids)];
        }
      } catch {
        /* Historical human-readable handoffs remain importable. */
      }
      if (ledger) {
        hasUsage = true;
        result.tokens = ledger.tokens;
        result.total = ledger.tokens;
        result.usage = ledger.usage;
        if (ledger.source) result.usageSource = ledger.source;
      }
      return result;
    },
  };
}

/** Measure a retained session JSONL file without retaining its event history. */
export function measureSessionFile(
  path: string,
  options: {
    startedAt?: string;
    endedAt?: string;
    baseline?: Tokens;
    adapter?: AgentAdapter;
    policy?: ControlPolicy;
  } = {},
): { measurement: LogMeasurement; hasUsage: boolean } | null {
  const adapters = options.adapter ? [options.adapter] : allAgentAdapters();
  let hasRollout = false;
  const header = scanSessionJsonl(
    path,
    (event) => {
      if (!hasRollout) hasRollout = adapters.some((adapter) => adapter.hasRollout?.([event]) ?? false);
    },
    options.policy?.records,
  );
  if (!header.complete) return null;

  const state = measurementState(options, adapters, hasRollout);
  const usageAccumulators: AgentUsageAccumulator[] = adapters.flatMap((adapter) =>
    adapter.createUsageAccumulator
      ? [adapter.createUsageAccumulator(state.start, state.end, options.policy?.provider)]
      : [],
  );
  const body = scanSessionJsonl(
    path,
    (event) => {
      state.add(event);
      for (const accumulator of usageAccumulators) accumulator.add(event);
    },
    options.policy?.records,
  );
  if (!body.complete) return null;
  const ledger = usageAccumulators.map((accumulator) => accumulator.finish()).find((usage) => usage !== null) ?? null;
  const measurement = state.finish(ledger);
  return { measurement, hasUsage: ledger !== null || (state.hasUsage && state.exactUsage) };
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
    taskKind: task.brief.kind,
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
export type MeasurementOptions = {
  policy?: ControlPolicy;
  baseline?: Tokens;
  configDirectory?: string | undefined;
  logStartOffset?: number;
};
/**
 * The agent session an attempt ran in. A superseded attempt's session is recorded only when it is finalized, after its
 * retry has chosen how to start, so the head of its run log names it instead; without this every retry of a superseded
 * attempt started a fresh session and lost its context (437 of 437 retries on 2026-10-29).
 */
export function attemptSession(attempt: Attempt, policy = defaultPolicy.records): string | null {
  if (attempt.session) return attempt.session;
  const adapter = attempt.profile && agentAdapter(attempt.profile.cli);
  if (!adapter) return null;
  let head = '';
  try {
    const fd = openSync(attempt.logPath, 'r');
    try {
      const buffer = Buffer.alloc(policy.sessionHeadBytes);
      head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of head.split('\n')) {
    try {
      const session = adapter.sessionId(JSON.parse(line));
      if (session) return session;
    } catch {
      /* A partial last line or non-JSON output. */
    }
  }
  return null;
}
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
  const interval = {
    policy: options.policy ?? defaultPolicy,
    startedAt: attempt.startedAt,
    ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
  };
  // Historical records can lack a profile; their event/session formats select an adapter instead.
  const selected = attempt.profile && agentAdapter(attempt.profile.cli);
  const adapters = selected ? [selected] : allAgentAdapters();
  const measurement = measureLog(text, {
    ...(selected ? { adapter: selected } : {}),
    ...interval,
    ...(options.baseline ? { baseline: options.baseline } : {}),
  });
  const runText =
    options.logStartOffset === undefined
      ? text
      : readLogFromOffset(attempt.logPath, options.logStartOffset, options.maxLogBytes);
  if (runText !== text) {
    const runOutcome = measureLog(runText, {
      ...(selected ? { adapter: selected } : {}),
      ...interval,
    });
    measurement.session = runOutcome.session;
    measurement.result = runOutcome.result;
    measurement.blocker = runOutcome.blocker;
    measurement.failureKind = runOutcome.failureKind;
    measurement.usageLimitRefusal = runOutcome.usageLimitRefusal;
    measurement.waitingChecks = runOutcome.waitingChecks;
  }
  const completed = runText.split('\n').some((line) => {
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
    .map((adapter) => {
      const path = adapter.readSessionPath?.(options.configDirectory!, session) ?? null;
      return {
        adapter,
        path,
        rollout: path === null ? (adapter.readSession?.(options.configDirectory!, session) ?? null) : null,
      };
    })
    .find(({ path, rollout }) => path !== null || rollout !== null);
  if (!source) return measurement;
  const { adapter, path, rollout } = source;
  const streamed = path
    ? measureSessionFile(path, {
        adapter,
        ...interval,
        ...(options.baseline ? { baseline: options.baseline } : {}),
      })
    : null;
  if (path && !streamed) return { ...measurement, session };
  const usage =
    streamed?.measurement ??
    measureLog(rollout!, {
      adapter,
      ...interval,
      ...(options.baseline ? { baseline: options.baseline } : {}),
    });
  if (usage.usage || (!completed && (path ? streamed?.hasUsage : true)))
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
export function reportedApproaches(
  result: string,
  adapter?: AgentAdapter,
  policy = defaultPolicy.records,
): { approach: string; result: string }[] {
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
    approach: match[1]!.trim().slice(0, policy.legacyApproachCharacters),
    result: match[2]!.trim().slice(0, policy.legacyResultCharacters),
  }));
}
