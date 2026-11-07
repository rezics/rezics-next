import type { Pool, PoolReading, Tokens } from '../types.ts';

export function unknownReading(pool: Pool, now: number, error: string | null = 'no quota observation'): PoolReading {
  return {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
    observedAt: null,
    windows: [],
    exhausted: false,
    error,
  };
}

export function tokens(value: Record<string, unknown>): Tokens {
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

/** Provider refusal wording shared by the current adapters. */
export const MODEL_AT_CAPACITY =
  /selected model is at capacity|model is at capacity|try a different model|server is overloaded|temporarily overloaded/i;
export const POOL_EXHAUSTED =
  /usage limit|hit your limit|quota exhausted|rate limit reached|balance exhausted|status 402|payment required|out of usage|increase limits for faster responses/i;
export const USAGE_LIMIT_REFUSAL = /usage[\s_-]*limit|hit your limit/i;
export function isUsageLimitRefusal(text: string): boolean {
  return USAGE_LIMIT_REFUSAL.test(text);
}
export function textSignals(text: string) {
  return {
    allowance: POOL_EXHAUSTED.test(text),
    usageLimit: isUsageLimitRefusal(text),
    capacity: MODEL_AT_CAPACITY.test(text),
  };
}

/** Provider connection drops: resume the same session, do not spend an attempt or check-host stamp. */
export const TRANSPORT_FAILURE_EVENT = 'transport-failure';
export const TRANSPORT_RETRY_BACKOFF_MS = [60_000, 120_000, 240_000] as const;
export const TRANSPORT_RETRY_LIMIT = 6;
export const TRANSPORT_RESUME_PROMPT =
  'The previous run ended on a dropped provider connection. Resume this same session and continue the work. Do not wait or poll. Finish with the required exit object.';
export const CURSOR_FRESH_SESSION_EVENT = 'cursor-fresh-session-restart';
export const CURSOR_FRESH_SESSION_RETRY_LIMIT = 1;
export const CURSOR_FRESH_SESSION_PROMPT =
  'The previous Cursor run stopped after repeated resume attempts made no progress. Continue in a fresh Cursor session from the existing branch and worktree, preserving committed and uncommitted changes. Do not repeat completed work. Finish with the required exit object.';

const CURSOR_TLS_DISCONNECT = /Client network socket disconnected before secure TLS connection was established/i;
const CURSOR_CONNECTION_LOST = /Connection lost, reconnecting to /i;
const CURSOR_RESUME_STOPPED = /Agent turn stopped after repeated resume attempts made no progress/i;
const CURSOR_CONNECTION_FAILED_REPEATEDLY = /Connection failed repeatedly/i;
const CODEX_STREAM_DISCONNECTED = /stream disconnected/i;
const CODEX_RESPONSES_WEBSOCKET = /failed to connect to Responses WebSocket/i;

export function isCursorResumeStopped(stderr: string): boolean {
  return CURSOR_RESUME_STOPPED.test(stderr);
}

function websocketFailureCount(stderr: string): number {
  return stderr.match(/failed to connect to Responses WebSocket/gi)?.length ?? 0;
}

function lineMatchesTransport(line: string): boolean {
  return (
    CURSOR_TLS_DISCONNECT.test(line) ||
    CURSOR_CONNECTION_LOST.test(line) ||
    CURSOR_CONNECTION_FAILED_REPEATEDLY.test(line) ||
    CODEX_STREAM_DISCONNECTED.test(line) ||
    CODEX_RESPONSES_WEBSOCKET.test(line)
  );
}

/** Last nonempty stderr line, ANSI stripped. */
export function lastNonemptyLine(text: string): string {
  for (const line of text.split(/\r?\n/).reverse()) {
    const trimmed = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** A provider network drop classified from stderr; Cursor's repeated-resume-stop signal is recovered separately. */
export function isTransportFailure(stderr: string, exitCode: number | null = null): boolean {
  if (isCursorResumeStopped(stderr)) return false;
  if (CURSOR_TLS_DISCONNECT.test(stderr)) return true;
  if (CURSOR_CONNECTION_LOST.test(stderr) && CURSOR_CONNECTION_FAILED_REPEATEDLY.test(stderr)) return true;
  if (CODEX_STREAM_DISCONNECTED.test(stderr)) return true;
  return exitCode !== 0 && websocketFailureCount(stderr) >= 2;
}

/** Last stderr line that names the transport failure; used as the incident fingerprint. */
export function transportFailureLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trim());
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!;
    if (line && lineMatchesTransport(line)) return line;
  }
  return lastNonemptyLine(stderr);
}

/** Delay before the Nth consecutive same-attempt transport resume (1-based). */
export function transportRetryBackoffMs(count: number, ladder: readonly number[] = TRANSPORT_RETRY_BACKOFF_MS): number {
  if (count < 1 || !ladder.length) return ladder[0] ?? TRANSPORT_RETRY_BACKOFF_MS[0];
  return ladder[Math.min(count - 1, ladder.length - 1)]!;
}

const EXIT_STATUSES = new Set(['success', 'blocked', 'waiting']);

function isSupportedExit(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return EXIT_STATUSES.has((value as { status?: unknown }).status as string);
}

/** Agents without an enforced schema may wrap the shared exit object in prose. */
export function parseExitObject(output: string): unknown | null {
  try {
    const value = JSON.parse(output);
    return isSupportedExit(value) ? value : null;
  } catch {
    return lastStatusObject(output);
  }
}

/**
 * Last complete supported exit. An object left open at the end of the text is a truncated fragment, so scanning
 * resumes after its opening brace and a complete report that follows it is still found; a status object nested inside
 * braces that do close stays nested and is not an exit.
 */
function lastStatusObject(text: string): unknown {
  let last: unknown = null;
  let from = 0;
  for (let rescans = 0; rescans < 64 && from < text.length; rescans++) {
    const { found, unclosed } = scanStatusObjects(text, from);
    if (found !== null) last = found;
    if (unclosed < 0) break;
    from = unclosed + 1;
  }
  return last;
}

function scanStatusObjects(text: string, from: number): { found: unknown; unclosed: number } {
  let last: unknown = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (start < 0) {
      if (c === '{') {
        start = i;
        depth = 1;
        inString = false;
        escape = false;
      }
      continue;
    }
    if (inString) {
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth !== 0) continue;
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        if (isSupportedExit(value)) last = value;
      } catch {
        /* not a JSON object */
      }
      start = -1;
    }
  }
  return { found: last, unclosed: start };
}
