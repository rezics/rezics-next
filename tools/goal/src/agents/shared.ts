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
  /usage limit|hit your limit|quota exhausted|rate limit reached|balance exhausted|status 402|payment required/i;
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

/** Last complete supported exit; unmatched braces leave the remainder unavailable. */
function lastStatusObject(text: string): unknown {
  let last: unknown = null;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
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
  return last;
}
