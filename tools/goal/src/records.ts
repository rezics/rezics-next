import { readFileSync } from 'node:fs';
import type { Attempt, AttemptRecord, StepClass, Task, Tokens } from './types.ts';

export const CLASSIFIER_VERSION = '1';
export const emptyTokens = (): Tokens => ({ input: 0, cached: 0, output: 0 });
export const emptySteps = (): Record<StepClass, number> => ({ decision: 0, read: 0, edit: 0, wait: 0, check: 0, commit: 0 });
/** Fixed precedence: one observable tool operation receives one class. Unknown operations are decisions. */
export function classifyStep(name: string, input: string): StepClass {
  const text = `${name} ${input}`;
  if (/\bgit\s+(commit|tag)\b/.test(text)) return 'commit';
  if (/\b(wait|sleep|write_stdin)\b/.test(name) || /\byield_time_ms\b/.test(input) && /\bwrite_stdin\b/.test(input)) return 'wait';
  if (/\b(test|typecheck|check|lint|pytest|vitest|tsc)\b/.test(text)) return 'check';
  if (/apply_patch|file_change|write_file|edit_file/.test(name) || /\b(sed\s+-i|tee|cat\s*>|python.*write)\b/.test(input)) return 'edit';
  if (/read_file|search|browse|web|view_image/.test(name) || /\b(rg|cat|head|tail|git\s+(show|diff|log|status)|ls|find)\b/.test(input)) return 'read';
  return 'decision';
}
function tokens(value: Record<string, unknown>): Tokens {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
  return { input: num(value.input_tokens ?? value.inputTokens), cached: num(value.cached_input_tokens ?? value.cachedInputTokens ?? value.cache_read_input_tokens), output: num(value.output_tokens ?? value.outputTokens) };
}
export type LogMeasurement = { tokens: Tokens; total: Tokens; steps: Record<StepClass, number>; session: string | null; result: string; blocker: string | null };
/** Cumulative totals are differenced, duplicate snapshots contribute zero, and pre-window totals establish a baseline. */
export function measureLog(text: string, options: { startedAt?: string; endedAt?: string; baseline?: Tokens } = {}): LogMeasurement {
  const start = options.startedAt ? Date.parse(options.startedAt) : -Infinity;
  const end = options.endedAt ? Date.parse(options.endedAt) : Infinity;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) throw new Error('invalid measurement interval');
  const events = text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const hasRollout = events.some(e => e.payload?.type === 'token_count' && e.payload.info?.total_token_usage);
  let previous = options.baseline ?? emptyTokens();
  const result: LogMeasurement = { tokens: emptyTokens(), total: previous, steps: emptySteps(), session: null, result: '', blocker: null };
  const seen = new Set<string>();
  for (const event of events) {
    const at = event.timestamp ? Date.parse(event.timestamp) : start;
    const inside = at >= start && at <= end;
    if (at > end) continue;
    if (inside && (event.type === 'turn.failed' || event.type === 'error')) result.result = event.error?.message ?? event.message ?? result.result;
    if (event.type === 'thread.started') result.session = event.thread_id ?? result.session;
    if (event.type === 'session_meta') result.session = event.payload?.id ?? event.payload?.session_id ?? result.session;
    const payload = event.payload ?? event;
    const usage = hasRollout ? (payload.type === 'token_count' ? payload.info?.total_token_usage : null)
      : (event.type === 'turn.completed' ? event.usage : event.type === 'result' || event.result !== undefined || event.text !== undefined ? event.usage : null);
    if (usage) {
      const current = tokens(usage);
      if (inside) for (const key of ['input', 'cached', 'output'] as const) {
        result.tokens[key] += event.usage_mode === 'delta' ? current[key] : Math.max(0, current[key] - previous[key]);
      }
      previous = { input: Math.max(previous.input, current.input), cached: Math.max(previous.cached, current.cached), output: Math.max(previous.output, current.output) };
      result.total = previous;
    }
    if (!inside) continue;
    const item = event.item ?? payload;
    const type = item.type;
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'function_call', 'custom_tool_call', 'reasoning'].includes(type)
      && (event.type !== 'item.started')) {
      const key = item.call_id ?? item.id;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const name = item.name ?? type;
      const input = item.command ?? item.input ?? item.arguments ?? '';
      result.steps[classifyStep(name, typeof input === 'string' ? input : JSON.stringify(input))]++;
    }
    if (type === 'agent_message') result.result = item.text ?? '';
    if (payload.type === 'message' && payload.role === 'assistant') result.result = (payload.content ?? []).map((c: { text?: string }) => c.text ?? '').join('\n');
    if (event.type === 'result' || event.result !== undefined) {
      const answer = event.result ?? event.text ?? result.result;
      result.result = typeof answer === 'string' ? answer : JSON.stringify(answer);
      result.session = event.session_id ?? event.sessionId ?? result.session;
    }
  }
  const blocker = /^BLOCKER:\s*(.+)$/im.exec(result.result)?.[1]?.trim();
  result.blocker = blocker && !/^(none|no(?: blockers?)?|n\/a|not blocked)\.?$/i.test(blocker) ? blocker : null;
  return result;
}
export function makeRecord(task: Task, attempt: Attempt, measurement: LogMeasurement, outcome: AttemptRecord['outcome'] = 'pending-gate'): AttemptRecord {
  return { taskId: task.id, attempt: attempt.attempt, taskClass: task.taskClass, profile: attempt.profile, pool: attempt.pool,
    tableVersion: attempt.tableVersion, experiment: attempt.experiment, startedAt: attempt.startedAt, endedAt: attempt.endedAt ?? new Date().toISOString(),
    steps: Object.values(measurement.steps).reduce((a, b) => a + b, 0), criticalPath: task.brief.criticalPath,
    tokens: measurement.tokens, before: attempt.before, after: attempt.after, outcome, firstFailure: attempt.failure?.fingerprint ?? null,
    escalation: attempt.escalation, consulted: attempt.consulted, fixRound: attempt.fixRound,
    diffLines: 0, changedFiles: [], hostMs: 0, classifierVersion: CLASSIFIER_VERSION, stepClasses: measurement.steps, earlyStop: false };
}
export function readMeasurement(attempt: Attempt, baseline?: Tokens): LogMeasurement {
  let text = '';
  try { text = readFileSync(attempt.logPath, 'utf8'); } catch { /* A failed spawn has no stream. */ }
  return measureLog(text, { startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}), ...(baseline ? { baseline } : {}) });
}

/** Only the bounded approach/result fields enter evidence; the rest of the session stays in its raw log. */
export function reportedApproaches(result: string): { approach: string; result: string }[] {
  return [...result.matchAll(/^APPROACH:[ \t]*(.+)\r?\nOUTCOME:[ \t]*(.+)$/gim)]
    .map(match => ({ approach: match[1]!.trim().slice(0, 1000), result: match[2]!.trim().slice(0, 2000) }));
}
