import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultPolicy } from '../policy.ts';
import type { Pool, PoolReading } from '../types.ts';
import { unknownReading } from './shared.ts';

/** Parse the plan windows of Claude's OAuth usage endpoint, the one Claude Code's /usage reads. */
export function parseClaudeUsage(body: string, pool: Pool, now = Date.now()): PoolReading {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return unknownReading(pool, now, 'Claude OAuth usage response was invalid');
  }
  if (!isRecord(value)) return unknownReading(pool, now, 'Claude OAuth usage response was invalid');
  const windows = (
    [
      ['five_hour', 300],
      ['seven_day', 10080],
    ] as const
  ).flatMap(([key, minutes]) => {
    const window = value[key];
    if (!isRecord(window) || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return [];
    const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    return [
      {
        usedPercent: Math.min(100, Math.max(0, window.utilization)),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
        minutes,
      },
    ];
  });
  if (!windows.length) return unknownReading(pool, now, 'Claude OAuth usage response was invalid');
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

// All control-plane processes share observations; each caller applies its own refresh and stale policy.
// The OAuth token goes to curl on stdin, never in its arguments.
const MAX_DATE_MS = 8.64e15; // ECMAScript Date's representable range, not a retention policy.
const claudeReadings = new Map<string, PoolReading>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dateMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function validCachedReading(value: unknown, pool: Pool, now: number, staleMs: number): PoolReading | undefined {
  if (!isRecord(value) || value.pool !== pool.name || value.allowanceKey !== pool.allowanceKey) return undefined;
  if (dateMilliseconds(value.at) === undefined || typeof value.observedAt !== 'string') return undefined;
  const observedAt = dateMilliseconds(value.observedAt);
  if (observedAt === undefined || now < observedAt || now - observedAt >= staleMs) return undefined;
  if (!Array.isArray(value.windows) || !value.windows.length) return undefined;
  const validWindows = value.windows.every(
    (window) =>
      isRecord(window) &&
      typeof window.usedPercent === 'number' &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100 &&
      (window.resetsAt === null ||
        (typeof window.resetsAt === 'number' &&
          Number.isFinite(window.resetsAt) &&
          Math.abs(window.resetsAt) <= MAX_DATE_MS)) &&
      (window.minutes === null ||
        (typeof window.minutes === 'number' && Number.isFinite(window.minutes) && window.minutes > 0)) &&
      (window.window === undefined || typeof window.window === 'string'),
  );
  if (!validWindows) return undefined;
  const exhausted = value.windows.some((window) => (window as Record<string, unknown>).usedPercent === 100);
  if (value.exhausted !== exhausted || value.error !== null) return undefined;
  return value as unknown as PoolReading;
}

function claudeCache(pool: Pool): string {
  return join(
    tmpdir(),
    `goal-claude-usage-${createHash('sha256').update(pool.configDirectory).digest('hex').slice(0, 16)}.json`,
  );
}

function cachedClaudeReading(pool: Pool, cache: string, now: number, staleMs: number): PoolReading | undefined {
  let disk: unknown;
  try {
    disk = JSON.parse(readFileSync(cache, 'utf8')) as unknown;
  } catch {
    /* A damaged cache is not an observation. */
  }
  return [claudeReadings.get(cache), disk]
    .map((reading) => validCachedReading(reading, pool, now, staleMs))
    .filter((reading): reading is PoolReading => !!reading)
    .sort((left, right) => Date.parse(right.observedAt!) - Date.parse(left.observedAt!))[0];
}

function rememberClaudeReading(pool: Pool, reading: PoolReading): void {
  const cache = claudeCache(pool);
  claudeReadings.set(cache, reading);
  const temporary = `${cache}.${process.pid}`;
  try {
    writeFileSync(temporary, JSON.stringify(reading), { mode: 0o600 });
    renameSync(temporary, cache);
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      /* Persistence is best effort; keep the in-memory observation. */
    }
  }
}

function resetIso(seconds: unknown): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  const milliseconds = seconds * 1000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MS) return undefined;
  return new Date(milliseconds).toISOString();
}

/** Claude Code streams the plan's windows in its rate_limit_event; a finished worker's log refreshes the shared reading. */
export function recordClaudeRateLimit(pool: Pool, log: string, now = Date.now()): void {
  try {
    let info: Record<string, unknown> | undefined;
    for (const line of log.split('\n')) {
      if (!line.includes('"rate_limit_event"')) continue;
      try {
        const event: unknown = JSON.parse(line);
        if (isRecord(event) && isRecord(event.rate_limit_info)) info = event.rate_limit_info;
      } catch {
        /* Not an event line. */
      }
    }
    const windows = info?.unifiedWindows;
    if (!isRecord(windows)) return;
    const body = Object.fromEntries(
      Object.entries(windows).map(([key, value]) => {
        const window = isRecord(value) ? value : {};
        return [
          key,
          {
            utilization: typeof window.utilization === 'number' ? window.utilization * 100 : undefined,
            resets_at: resetIso(window.resetsAt),
          },
        ];
      }),
    );
    const reading = parseClaudeUsage(JSON.stringify(body), pool, now);
    if (!reading.observedAt) return;
    rememberClaudeReading(pool, reading);
  } catch {
    /* Allowance observation must never fail worker settlement. */
  }
}

export function readClaudeUsage(pool: Pool, now: number, policy = defaultPolicy.provider): PoolReading {
  const cache = claudeCache(pool);
  const cached = cachedClaudeReading(pool, cache, now, policy.claudeStaleMs);
  const age = cached ? now - Date.parse(cached.observedAt!) : Infinity;
  const reuse = (reading: PoolReading) => ({
    ...reading,
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
  });
  if (cached && age < policy.claudeRefreshMs) return reuse(cached);
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
  let observationError = 'Claude OAuth access token unavailable';
  let response: ReturnType<typeof spawnSync> | undefined;
  if (typeof token === 'string' && token) {
    try {
      response = spawnSync(
        'curl',
        [
          '-sf',
          '-m',
          String(policy.claudeRequestTimeoutSeconds),
          '-H',
          '@-',
          '-H',
          'anthropic-beta: oauth-2025-04-20',
          'https://api.anthropic.com/api/oauth/usage',
        ],
        { input: `Authorization: Bearer ${token}\n`, encoding: 'utf8' },
      );
    } catch {
      /* Report a failed optional observation below. */
    }
    observationError = 'Claude OAuth usage request failed';
  }
  const reading =
    response?.status === 0 && typeof response.stdout === 'string'
      ? parseClaudeUsage(response.stdout, pool, now)
      : undefined;
  if (reading?.observedAt) {
    rememberClaudeReading(pool, reading);
    return reading;
  }
  if (response?.status === 0) observationError = 'Claude OAuth usage response was invalid';
  if (cached && age < policy.claudeStaleMs) return reuse(cached);
  return unknownReading(pool, now, observationError);
}
