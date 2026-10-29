import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Attempt, AttemptFailure, AttemptRecord, StepClass, Task, Tokens } from './types.ts';

export const CLASSIFIER_VERSION = '1';
export const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0 });
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
function tokens(value: Record<string, unknown>): Tokens {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  // Anthropic-style usage (Grok) counts cache reads apart from input_tokens; the records count them inside input.
  const cacheRead = num(value.cache_read_input_tokens);
  // Claude also reports cache writes apart; they are input the model processed.
  return {
    input: num(value.input_tokens ?? value.inputTokens) + cacheRead + num(value.cache_creation_input_tokens),
    cached: num(value.cached_input_tokens ?? value.cachedInputTokens) + cacheRead,
    output: num(value.output_tokens ?? value.outputTokens),
  };
}
/** A provider-side capacity refusal: transient and independent of the model, so the attempt simply continues. */
export const MODEL_AT_CAPACITY =
  /selected model is at capacity|model is at capacity|try a different model|server is overloaded|temporarily overloaded/i;
/**
 * A check host that dropped the connection (sshd throttling, a transport reset) failed the attempt, not its work: the
 * attempt is continued like a capacity refusal and never counts toward a repeated launch failure.
 */
export const CHECK_HOST_TRANSPORT =
  /RemoteTransportError|Connection closed by [0-9a-f.:]+ port 22|kex_exchange_identification|ssh: connect to host|Connection reset by peer|rsync error: (?:unexplained error|error in rsync protocol)|SSH (?:exit(?:ed)? )?255|exit(?:ed)? (?:with )?(?:code )?255|(?:^|\n)curl: \((?:6|7|18|28|35|52|56)\)|gzip: stdin: unexpected end of file|tar: Unexpected EOF in archive|remote-check: downloaded Bun does not match packageManager/i;
/** A CLI's wording for a usage-limit refusal; the job confirms exhaustion against the latest quota reading. */
export const POOL_EXHAUSTED =
  /usage limit|hit your limit|quota exhausted|rate limit reached|balance exhausted|status 402|payment required/i;
export const USAGE_LIMIT_REFUSAL = /usage[\s_-]*limit|hit your limit/i;
export function isUsageLimitRefusal(text: string): boolean {
  return USAGE_LIMIT_REFUSAL.test(text);
}
export type SessionUsage = {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  reasoning: number;
  compactions: number;
};
export type LogMeasurement = {
  tokens: Tokens;
  total: Tokens;
  usage: SessionUsage | null;
  steps: Record<StepClass, number>;
  session: string | null;
  result: string;
  blocker: string | null;
  failureKind: AttemptFailure | null;
  usageLimitRefusal: boolean;
};

function codexSessionUsage(
  events: Record<string, any>[],
  start: number,
  end: number,
): { tokens: Tokens; usage: SessionUsage } | null {
  const ledger = events.filter((event) => event.type === 'token_usage_record');
  if (!ledger.length) return null;
  const totals = emptyTokens();
  const seen = new Set<string>();
  const usage: SessionUsage = { model: null, effort: null, serviceTier: null, reasoning: 0, compactions: 0 };
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  const firstString = (objects: Record<string, any>[], names: string[]): string | null => {
    for (const object of objects)
      for (const name of names) {
        const value = object[name];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    return null;
  };
  const contextObjects = (event: Record<string, any>): Record<string, any>[] => {
    const result: Record<string, any>[] = [];
    const queue: Record<string, any>[] = [event];
    const keys = ['payload', 'info', 'settings', 'thread_settings', 'turn_context', 'context', 'config', 'model_info'];
    while (queue.length && result.length < 24) {
      const value = queue.shift()!;
      result.push(value);
      for (const key of keys)
        if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) queue.push(value[key]);
    }
    return result;
  };
  for (const event of events) {
    const at = event.timestamp ? Date.parse(event.timestamp) : start;
    const inside = at >= start && at <= end;
    if (at > end) continue;
    if (!inside) continue;
    const payload = event.payload ?? {};
    if (event.type === 'token_usage_record') {
      const responseId = event.response_id ?? payload.response_id ?? event.responseId;
      if (responseId !== undefined && seen.has(String(responseId))) continue;
      if (responseId !== undefined) seen.add(String(responseId));
      const record = payload.usage ?? event.usage ?? payload;
      totals.input += number(record.input_tokens ?? record.inputTokens);
      totals.cached += number(record.cached_input_tokens ?? record.cachedInputTokens);
      totals.output += number(record.output_tokens ?? record.outputTokens);
      usage.reasoning += number(record.reasoning_output_tokens ?? record.reasoningOutputTokens);
    }
    if (event.type === 'compacted' || payload.type === 'compacted' || event.type === 'session.compacted')
      usage.compactions++;
    const objects = contextObjects(event);
    usage.model = firstString(objects, ['model', 'model_name', 'modelName']) ?? usage.model;
    usage.effort = firstString(objects, ['effort', 'model_reasoning_effort', 'reasoning_effort']) ?? usage.effort;
    usage.serviceTier =
      firstString(objects, ['service_tier', 'serviceTier', 'service_tier_name', 'tier']) ?? usage.serviceTier;
  }
  return { tokens: totals, usage };
}

/** Cumulative totals are differenced, duplicate snapshots contribute zero, and pre-window totals establish a baseline. */
export function measureLog(
  text: string,
  options: { startedAt?: string; endedAt?: string; baseline?: Tokens } = {},
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
  // Grok's JSON output is one pretty-printed object rather than JSON Lines.
  const events = lines.length
    ? lines
    : (() => {
        try {
          return [JSON.parse(text)];
        } catch {
          return [];
        }
      })();
  const hasRollout = events.some((e) => e.payload?.type === 'token_count' && e.payload.info?.total_token_usage);
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
  };
  const seen = new Set<string>();
  // The last answer that ended a turn with a report or a blocker; see the end of the loop.
  let answered: string | null = null;
  for (const event of events) {
    const at = event.timestamp ? Date.parse(event.timestamp) : start;
    const inside = at >= start && at <= end;
    if (at > end) continue;
    if (inside && (event.type === 'turn.failed' || event.type === 'error')) {
      result.result = event.error?.message ?? event.message ?? result.result;
      const code = event.error?.code ?? event.code;
      result.failureKind =
        ['usage_limit_exceeded', 'rate_limit_exceeded', 'insufficient_quota'].includes(code) ||
        POOL_EXHAUSTED.test(result.result)
          ? 'pool-exhausted'
          : 'tool';
      result.usageLimitRefusal ||= code === 'usage_limit_exceeded' || isUsageLimitRefusal(result.result);
    }
    if (inside && event.type === 'turn.completed') result.failureKind = null;
    // Claude Code's stream: a refused rate limit ends the session, and an error result carries its reason as text.
    if (inside && event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected')
      result.failureKind = 'pool-exhausted';
    if (inside && event.type === 'result' && event.is_error === true) {
      const detail = String(event.result ?? '');
      result.usageLimitRefusal ||= isUsageLimitRefusal(detail);
      if (result.failureKind !== 'pool-exhausted')
        result.failureKind = POOL_EXHAUSTED.test(detail) ? 'pool-exhausted' : 'tool';
    }
    if (event.type === 'system' && event.subtype === 'init') result.session = event.session_id ?? result.session;
    if (event.type === 'thread.started') result.session = event.thread_id ?? result.session;
    if (event.type === 'session_meta')
      result.session = event.payload?.id ?? event.payload?.session_id ?? result.session;
    const payload = event.payload ?? event;
    const usage = hasRollout
      ? payload.type === 'token_count'
        ? payload.info?.total_token_usage
        : null
      : event.type === 'turn.completed'
        ? event.usage
        : event.type === 'result' || event.result !== undefined || event.text !== undefined
          ? event.usage
          : null;
    if (usage) {
      const current = tokens(usage);
      if (inside)
        for (const key of ['input', 'cached', 'output'] as const) {
          result.tokens[key] += event.usage_mode === 'delta' ? current[key] : Math.max(0, current[key] - previous[key]);
        }
      previous = {
        input: Math.max(previous.input, current.input),
        cached: Math.max(previous.cached, current.cached),
        output: Math.max(previous.output, current.output),
      };
      result.total = previous;
    }
    if (!inside) continue;
    const item = event.item ?? payload;
    const type = item.type;
    // Steps are actions. Reasoning items are not: counting them stopped a progressing Sol worker at about 100 actions.
    if (
      ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'function_call', 'custom_tool_call'].includes(
        type,
      ) &&
      event.type !== 'item.started'
    ) {
      const key = item.call_id ?? item.id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const name = item.name ?? type;
      const input = item.command ?? item.input ?? item.arguments ?? '';
      result.steps[classifyStep(name, typeof input === 'string' ? input : JSON.stringify(input))]++;
    }
    // Claude Code nests its tool calls in the assistant message's content.
    if (event.type === 'assistant')
      for (const call of event.message?.content ?? []) {
        if (call?.type !== 'tool_use' || (call.id && seen.has(call.id))) continue;
        if (call.id) seen.add(call.id);
        const input = call.input?.command ?? call.input ?? '';
        result.steps[
          classifyStep(call.name ?? 'tool_use', typeof input === 'string' ? input : JSON.stringify(input))
        ]++;
      }
    if (type === 'agent_message') result.result = item.text ?? '';
    if (payload.type === 'message' && payload.role === 'assistant')
      result.result = (payload.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
    if (
      event.type === 'result' ||
      event.result !== undefined ||
      (event.text !== undefined && event.stopReason !== undefined)
    ) {
      const answer = event.result ?? event.text ?? result.result;
      result.result = typeof answer === 'string' ? answer : JSON.stringify(answer);
      result.session = event.session_id ?? event.sessionId ?? result.session;
      if (event.type === 'result' && isFinalAnswer(result.result)) answered = result.result;
    }
  }
  // A Claude worker whose background command finishes after its report is woken once more, and answers that
  // notification in a later result ("my report above stands"): the report it gave stays its final answer.
  if (answered !== null && !isFinalAnswer(result.result)) result.result = answered;
  const blocker = /^BLOCKER:\s*(.+)$/im.exec(result.result)?.[1]?.trim();
  result.blocker = blocker && !/^(none|no(?: blockers?)?|n\/a|not blocked)\.?$/i.test(blocker) ? blocker : null;
  try {
    // A CLI without an enforced output schema may wrap the status object in prose; take the last object that parses.
    const exit = (() => {
      try {
        return JSON.parse(result.result);
      } catch {
        return lastStatusObject(result.result);
      }
    })();
    if (
      exit.status === 'blocked' &&
      exit.blocker &&
      ['spec-conflict', 'scope-growth', 'tool'].includes(exit.blocker.kind) &&
      typeof exit.blocker.detail === 'string'
    ) {
      result.failureKind = exit.blocker.kind;
      result.blocker = exit.blocker.detail;
    }
  } catch {
    /* Historical human-readable handoffs remain importable. */
  }
  const ledger = codexSessionUsage(events, start, end);
  if (ledger) {
    result.tokens = ledger.tokens;
    result.total = ledger.tokens;
    result.usage = ledger.usage;
  }
  return result;
}
/** Whether an answer reports success or states a blocker, as a worker's final answer does. */
function isFinalAnswer(text: string): boolean {
  return reportsSuccess(text) || /^BLOCKER:/im.test(text) || lastStatusObject(text) !== null;
}
/** Whether a worker's final answer reports success: its status object, or the older RESULT line. */
export function reportsSuccess(result: string): boolean {
  if (/^RESULT:\s*success\b/im.test(result)) return true;
  const exit = (() => {
    try {
      return JSON.parse(result);
    } catch {
      return lastStatusObject(result);
    }
  })() as { status?: unknown } | null;
  return exit?.status === 'success';
}
function lastStatusObject(text: string): unknown {
  for (let end = text.lastIndexOf('}'); end >= 0; end = text.lastIndexOf('}', end - 1)) {
    for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
      try {
        const value = JSON.parse(text.slice(start, end + 1));
        if (value && typeof value === 'object' && 'status' in value) return value;
      } catch {
        /* keep widening */
      }
    }
  }
  return null;
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
      source: measurement.usage ? 'codex-session' : 'attempt-profile',
    },
  };
}
export type MeasurementOptions = { baseline?: Tokens; configDirectory?: string | undefined };
function rolloutFor(configDirectory: string, session: string): string | null {
  const root = join(configDirectory, 'sessions');
  const suffix = `-${session}.jsonl`;
  const pending = [root];
  const matches: string[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) matches.push(path);
    }
  }
  matches.sort((a, b) => basename(a).localeCompare(basename(a)) || a.localeCompare(b));
  for (const path of matches) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      /* A rollout may disappear during cleanup. */
    }
  }
  return null;
}
export function readMeasurement(attempt: Attempt, options: MeasurementOptions = {}): LogMeasurement {
  let text = '';
  try {
    text = readFileSync(attempt.logPath, 'utf8');
  } catch {
    /* A failed spawn has no stream. */
  }
  const interval = { startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}) };
  const measurement = measureLog(text, { ...interval, ...(options.baseline ? { baseline: options.baseline } : {}) });
  const completed = text.split('\n').some((line) => {
    try {
      return JSON.parse(line).type === 'turn.completed';
    } catch {
      return false;
    }
  });
  if (!options.configDirectory) return measurement;
  const session = measurement.session ?? attempt.session;
  if (!session) return measurement;
  const rollout = rolloutFor(options.configDirectory, session);
  if (rollout === null) return measurement;
  const usage = measureLog(rollout, { ...interval, ...(options.baseline ? { baseline: options.baseline } : {}) });
  if (usage.usage || !completed)
    return {
      ...measurement,
      tokens: usage.tokens,
      total: usage.total,
      usage: usage.usage ?? measurement.usage,
      session,
    };
  return { ...measurement, session };
}

/** Only the bounded approach/result fields enter evidence; the rest of the session stays in its raw log. */
export function reportedApproaches(result: string): { approach: string; result: string }[] {
  try {
    const value = JSON.parse(result);
    if (Array.isArray(value.approaches))
      return value.approaches.filter(
        (item: { approach?: unknown; result?: unknown }) =>
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
