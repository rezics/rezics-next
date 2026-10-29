import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool, PoolReading } from './types.ts';
import { agentAdapter } from './agents.ts';
import { unknownReading } from './agents/shared.ts';
export { parseCodexAllowance as parseCodexUsage } from './agents/codex.ts';
export { parseClaudeUsage, recordClaudeRateLimit } from './agents/claude.ts';

/** Other CLIs can supply a normalized quota observation through the local-only usageFile. */
export function readPool(pool: Pool, now = Date.now()): PoolReading {
  try {
    if (pool.usageFile) {
      const raw = JSON.parse(readFileSync(pool.usageFile, 'utf8')) as PoolReading;
      if (
        !Array.isArray(raw.windows) ||
        !raw.windows.length ||
        !raw.observedAt ||
        !Number.isFinite(Date.parse(raw.observedAt)) ||
        raw.windows.some((w) => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)
      )
        throw new Error('invalid quota observation');
      return {
        ...raw,
        pool: pool.name,
        allowanceKey: pool.allowanceKey,
        at: new Date(now).toISOString(),
        exhausted: raw.exhausted === true || raw.windows.some((w) => w.usedPercent >= 100),
      };
    }
    return agentAdapter(pool.cli).readAllowance?.(pool, now) ?? unknownReading(pool, now);
  } catch {
    return unknownReading(pool, now, 'quota observation unavailable');
  }
}
export type PoolReader = (pool: Pool) => PoolReading;

export type UsageLimitAssessment = {
  confirmedExhaustion: boolean;
  reason: 'window-used-up' | 'reading-stale' | 'reading-unavailable' | 'allowance-left';
  reading: PoolReading | null;
};

/**
 * A provider's usage-limit refusal only confirms exhaustion when a quota window is spent or its last reading is stale
 * beyond the pool's local freshness policy. Keep a recently unavailable reading retryable while it recovers.
 */
export function assessUsageLimitRefusal(
  after: PoolReading | null,
  before: PoolReading | null,
  pool: Pool,
  now = Date.now(),
): UsageLimitAssessment {
  const readings = [after, before]
    .filter(
      (reading): reading is PoolReading =>
        !!reading &&
        reading.windows.length > 0 &&
        !!reading.observedAt &&
        Number.isFinite(Date.parse(reading.observedAt)),
    )
    .sort((left, right) => Date.parse(right.observedAt!) - Date.parse(left.observedAt!));
  const reading = readings[0] ?? null;
  if (reading) {
    if (reading.exhausted || reading.windows.some((window) => window.usedPercent >= 100))
      return { confirmedExhaustion: true, reason: 'window-used-up', reading };
    const observedAt = Date.parse(reading.observedAt!);
    if (observedAt > now + 60_000 || now - observedAt > pool.policy.maxAgeMs)
      return { confirmedExhaustion: true, reason: 'reading-stale', reading };
    return { confirmedExhaustion: false, reason: 'allowance-left', reading };
  }

  const unavailableFor = after && before ? Date.parse(after.at) - Date.parse(before.at) : 0;
  if (Number.isFinite(unavailableFor) && unavailableFor > pool.policy.maxAgeMs)
    return { confirmedExhaustion: true, reason: 'reading-stale', reading: after ?? before };
  return { confirmedExhaustion: false, reason: 'reading-unavailable', reading: after ?? before };
}

// A CLI that reports an exhausted balance, such as Grok's 402, has no usage reader; the control plane remembers the
// observation so that routing skips the allowance for the pool's maxAgeMs instead of each new task failing on it once.
function exhaustionPath(stateDirectory: string, allowanceKey: string): string {
  return join(stateDirectory, 'exhausted', `${allowanceKey.replace(/[^\w.-]/g, '_')}.json`);
}
/** Remember an exhausted allowance, optionally with an explicit lifetime instead of the pool's normal maxAgeMs. */
export function markExhausted(
  stateDirectory: string,
  allowanceKey: string,
  now = Date.now(),
  durationMs?: number,
): void {
  const path = exhaustionPath(stateDirectory, allowanceKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      observedAt: new Date(now).toISOString(),
      ...(durationMs === undefined ? {} : { expiresAt: new Date(now + durationMs).toISOString() }),
    }),
  );
}
export function withObservedExhaustion(
  reading: PoolReading,
  pool: Pool,
  stateDirectory: string,
  now = Date.now(),
): PoolReading {
  try {
    const { observedAt, expiresAt } = JSON.parse(
      readFileSync(exhaustionPath(stateDirectory, pool.allowanceKey), 'utf8'),
    ) as {
      observedAt: string;
      expiresAt?: string;
    };
    const expires = expiresAt ? Date.parse(expiresAt) : Date.parse(observedAt) + pool.policy.maxAgeMs;
    if (!Number.isFinite(expires) || now >= expires) return reading;
    return { ...reading, observedAt, exhausted: true };
  } catch {
    return reading;
  }
}
