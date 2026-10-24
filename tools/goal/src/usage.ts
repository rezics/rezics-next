import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
