import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs';
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
      const windows: PoolReading['windows'] = [limits.primary, limits.secondary].filter(w => typeof w?.used_percent === 'number' && Number.isFinite(w.used_percent)).map(w => ({
        usedPercent: w.resets_at != null && Number(w.resets_at) * 1000 <= now ? 0 : w.used_percent,
        resetsAt: w.resets_at == null ? null : Number(w.resets_at) * 1000, minutes: w.window_minutes ?? null,
      }));
      if (!windows.length) continue;
      const observedAt = typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null;
      return { pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), observedAt, windows,
        exhausted: windows.some(w => w.usedPercent >= 100) || (!!limits.rate_limit_reached_type && windows.some(w => w.usedPercent > 0)), error: null };
    } catch { /* An incomplete final JSONL line is not an observation. */ }
  }
  return unknownReading(pool, now);
}
function unknownReading(pool: Pool, now: number, error: string | null = 'no quota observation'): PoolReading {
  return { pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), observedAt: null, windows: [], exhausted: false, error };
}
function tail(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size, buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length); return buffer.toString('utf8');
  } finally { closeSync(fd); }
}
/** Other CLIs can supply a normalized quota observation through the local-only usageFile. */
export function readPool(pool: Pool, now = Date.now()): PoolReading {
  try {
    if (pool.usageFile) {
      const raw = JSON.parse(readFileSync(pool.usageFile, 'utf8')) as PoolReading;
      if (!Array.isArray(raw.windows) || !raw.windows.length || !raw.observedAt || !Number.isFinite(Date.parse(raw.observedAt))
        || raw.windows.some(w => !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100)) throw new Error('invalid quota observation');
      return { ...raw, pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), exhausted: raw.exhausted === true || raw.windows.some(w => w.usedPercent >= 100) };
    }
    if (pool.cli === 'claude') return readClaudeUsage(pool, now);
    const sessions = join(pool.configDirectory, 'sessions');
    if (pool.cli !== 'codex' || !existsSync(sessions)) return unknownReading(pool, now);
    const files = readdirSync(sessions, { recursive: true }).filter((p): p is string => typeof p === 'string' && p.endsWith('.jsonl'))
      .map(p => join(sessions, p)).map(file => ({ file, modified: statSync(file).mtimeMs })).sort((a, b) => b.modified - a.modified);
    for (const file of files) {
      const reading = parseCodexUsage(tail(file.file), pool, now);
      if (reading.windows.length) return reading;
    }
    return unknownReading(pool, now);
  } catch { return unknownReading(pool, now, 'quota observation unavailable'); }
}
export type PoolReader = (pool: Pool) => PoolReading;

/** Parse the plan windows of Claude's OAuth usage endpoint, the one Claude Code's /usage reads. */
export function parseClaudeUsage(body: string, pool: Pool, now = Date.now()): PoolReading {
  const value = JSON.parse(body) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>;
  const windows = ([['five_hour', 300], ['seven_day', 10080]] as const).flatMap(([key, minutes]) => {
    const window = value[key];
    if (typeof window?.utilization !== 'number' || !Number.isFinite(window.utilization)) return [];
    const resetsAt = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    return [{ usedPercent: Math.min(100, Math.max(0, window.utilization)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : null, minutes }];
  });
  if (!windows.length) return unknownReading(pool, now);
  return { pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString(), observedAt: new Date(now).toISOString(),
    windows, exhausted: windows.some(w => w.usedPercent >= 100), error: null };
}
// Each control-plane process asks at most once a minute. The token goes to curl on stdin, never in its arguments.
const claudeReadings = new Map<string, PoolReading>();
function readClaudeUsage(pool: Pool, now: number): PoolReading {
  const cached = claudeReadings.get(pool.configDirectory);
  if (cached?.observedAt && now - Date.parse(cached.observedAt) < 60_000)
    return { ...cached, pool: pool.name, allowanceKey: pool.allowanceKey, at: new Date(now).toISOString() };
  const credentials = JSON.parse(readFileSync(join(pool.configDirectory, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: unknown } };
  const token = credentials.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || !token) return unknownReading(pool, now);
  const response = spawnSync('curl', ['-sf', '-m', '10', '-H', '@-', '-H', 'anthropic-beta: oauth-2025-04-20',
    'https://api.anthropic.com/api/oauth/usage'], { input: `Authorization: Bearer ${token}\n`, encoding: 'utf8' });
  if (response.status !== 0) return unknownReading(pool, now, 'quota observation unavailable');
  const reading = parseClaudeUsage(response.stdout, pool, now);
  if (reading.observedAt) claudeReadings.set(pool.configDirectory, reading);
  return reading;
}


// A CLI that reports an exhausted balance, such as Grok's 402, has no usage reader; the control plane remembers the
// observation so that routing skips the allowance for the pool's maxAgeMs instead of each new task failing on it once.
function exhaustionPath(stateDirectory: string, allowanceKey: string): string {
  return join(stateDirectory, 'exhausted', `${allowanceKey.replace(/[^\w.-]/g, '_')}.json`);
}
export function markExhausted(stateDirectory: string, allowanceKey: string, now = Date.now()): void {
  const path = exhaustionPath(stateDirectory, allowanceKey);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ observedAt: new Date(now).toISOString() }));
}
export function withObservedExhaustion(reading: PoolReading, pool: Pool, stateDirectory: string, now = Date.now()): PoolReading {
  try {
    const { observedAt } = JSON.parse(readFileSync(exhaustionPath(stateDirectory, pool.allowanceKey), 'utf8')) as { observedAt: string };
    if (now - Date.parse(observedAt) > pool.policy.maxAgeMs) return reading;
    return { ...reading, observedAt, exhausted: true };
  } catch { return reading; }
}
