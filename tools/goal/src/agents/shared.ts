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

/** Agents without an enforced schema may wrap the shared exit object in prose. */
export function parseExitObject(output: string): unknown | null {
  try {
    return JSON.parse(output);
  } catch {
    return lastStatusObject(output);
  }
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
