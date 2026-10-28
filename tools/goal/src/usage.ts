import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Pool, PoolReading } from './types.ts';

export function parseCodexUsage(text: string, pool: Pool, now = Date.now()): PoolReading {
  for (const line of text.split('\n').reverse()) {
    if (!line.includes('rate_limits')) continue;
    try {
      const event = JSON.parse(line);
      const limits = event.payload?.rate_limits ?? event.rate_limits;
      if (!limits) continue;
      const windows: PoolReading['windows'] = (
        [
          ['primary', limits.primary],
          ['secondary', limits.secondary],
        ] as const
      ).flatMap(([window, value]) => {
        if (typeof value?.used_percent !== 'number' || !Number.isFinite(value.used_percent)) return [];
        return [
          {
            window,
            usedPercent: value.resets_at != null && Number(value.resets_at) * 1000 <= now ? 0 : value.used_percent,
            resetsAt: value.resets_at == null ? null : Number(value.resets_at) * 1000,
            minutes: value.window_minutes ?? null,
          },
        ];
      });
      if (!windows.length) continue;
      const observedAt =
        typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null;
      return {
        pool: pool.name,
        allowanceKey: pool.allowanceKey,
        at: new Date(now).toISOString(),
        observedAt,
        windows,
        exhausted:
          windows.some((w) => w.usedPercent >= 100) ||
          (!!limits.rate_limit_reached_type && windows.some((w) => w.usedPercent > 0)),
        error: null,
      };
    } catch {
      /* An incomplete final JSONL line is not an observation. */
    }
  }
  return unknownReading(pool, now);
}
function unknownReading(pool: Pool, now: number, error: string | null = 'no quota observation'): PoolReading {
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
function tail(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size,
      buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}
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
    if (pool.cli === 'claude') return readClaudeUsage(pool, now);
    const sessions = join(pool.configDirectory, 'sessions');
    if (pool.cli !== 'codex' || !existsSync(sessions)) return unknownReading(pool, now);
    const files = readdirSync(sessions, { recursive: true })
      .filter((p): p is string => typeof p === 'string' && p.endsWith('.jsonl'))
      .map((p) => join(sessions, p))
      .map((file) => ({ file, modified: statSync(file).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const file of files) {
      const reading = parseCodexUsage(tail(file.file), pool, now);
      if (reading.windows.length) return reading;
    }
    return unknownReading(pool, now);
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

/** Parse the plan windows of Claude's OAuth usage endpoint, the one Claude Code's /usage reads. */
export function parseClaudeUsage(body: string, pool: Pool, now = Date.now()): PoolReading {
  const value = JSON.parse(body) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
  const windows = (
    [
      ['five_hour', 300],
      ['seven_day', 10080],
    ] as const
  ).flatMap(([key, minutes]) => {
    const window = value[key];
    if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) return [];
    const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    return [
      {
        usedPercent: Math.min(100, Math.max(0, window.utilization)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        minutes,
      },
    ];
  });
  if (!windows.length) return unknownReading(pool, now);
  return {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
    observedAt: new Date(now).toISOString(),
    windows,
    exhausted: windows.some((w) => w.usedPercent >= 100),
    error: null,
  };
}
// The endpoint rate-limits its callers, so all control-plane processes share one cached reading: it is refreshed at
// most every two minutes, and a refused refresh keeps the last good reading for up to twenty minutes. The token goes
// to curl on stdin, never in its arguments.
const CLAUDE_REFRESH_MS = 120_000,
  CLAUDE_STALE_MS = 1_200_000;
function claudeCache(pool: Pool): string {
  return join(
    tmpdir(),
    `goal-claude-usage-${createHash('sha256').update(pool.configDirectory).digest('hex').slice(0, 16)}.json`,
  );
}
/** Claude Code streams the plan's windows in its rate_limit_event; a finished worker's log refreshes the shared reading. */
export function recordClaudeRateLimit(pool: Pool, log: string, now = Date.now()): void {
  let info: { unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }> } | undefined;
  for (const line of log.split('\n')) {
    if (!line.includes('"rate_limit_event"')) continue;
    try {
      info = JSON.parse(line).rate_limit_info ?? info;
    } catch {
      /* Not an event line. */
    }
  }
  const windows = info?.unifiedWindows;
  if (!windows) return;
  const body = Object.fromEntries(
    Object.entries(windows).map(([key, window]) => [
      key,
      {
        utilization: typeof window.utilization === 'number' ? window.utilization * 100 : undefined,
        resets_at: typeof window.resetsAt === 'number' ? new Date(window.resetsAt * 1000).toISOString() : undefined,
      },
    ]),
  );
  const reading = parseClaudeUsage(JSON.stringify(body), pool, now);
  if (!reading.observedAt) return;
  const cache = claudeCache(pool);
  writeFileSync(`${cache}.${process.pid}`, JSON.stringify(reading), { mode: 0o600 });
  renameSync(`${cache}.${process.pid}`, cache);
}
function readClaudeUsage(pool: Pool, now: number): PoolReading {
  const cache = claudeCache(pool);
  let cached: PoolReading | undefined;
  try {
    cached = JSON.parse(readFileSync(cache, 'utf8')) as PoolReading;
  } catch {
    /* No reading yet. */
  }
  const age = cached?.observedAt ? now - Date.parse(cached.observedAt) : Infinity;
  const reuse = (reading: PoolReading) => ({
    ...reading,
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
  });
  if (cached && age < CLAUDE_REFRESH_MS) return reuse(cached);
  const token = (() => {
    try {
      return (
        JSON.parse(readFileSync(join(pool.configDirectory, '.credentials.json'), 'utf8')) as {
          claudeAiOauth?: { accessToken?: unknown };
        }
      ).claudeAiOauth?.accessToken;
    } catch {
      return undefined;
    }
  })();
  const response =
    typeof token === 'string' && token
      ? spawnSync(
          'curl',
          [
            '-sf',
            '-m',
            '10',
            '-H',
            '@-',
            '-H',
            'anthropic-beta: oauth-2025-04-20',
            'https://api.anthropic.com/api/oauth/usage',
          ],
          { input: `Authorization: Bearer ${token}\n`, encoding: 'utf8' },
        )
      : undefined;
  const reading = response?.status === 0 ? parseClaudeUsage(response.stdout, pool, now) : undefined;
  if (reading?.observedAt) {
    writeFileSync(`${cache}.${process.pid}`, JSON.stringify(reading), { mode: 0o600 });
    renameSync(`${cache}.${process.pid}`, cache);
    return reading;
  }
  if (cached && age < CLAUDE_STALE_MS) return reuse(cached);
  return unknownReading(pool, now, 'quota observation unavailable');
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
