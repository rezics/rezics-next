import { type UsageSample, type UsageSnapshot, type UsageReport, type AccountUsage, type CodexResetStatus, type CodexResetLoad } from './types.ts';
import { configuredAccounts } from './config.ts';
import { readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { codexResetCachePath, CODEX_RESET_CACHE_MS, CODEX_RESET_URL } from './ledger.ts';
import { join, dirname } from 'node:path';
import { capacityStatus } from './claude-capacity.ts';

// Historical projection helpers remain public for complete snapshots. New launch admission uses
// fresh native OAuth evidence and the local reserve policy in claude-capacity.ts.
const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 24 * 3600;
// The 5h window keeps the manager alive: new Claude work stops while the burn rate would end the
// window at PROJECTED_LIMIT or more, and at CRITICAL_USED only merge and test continue.
export const PROJECTED_LIMIT = 95;
export const CRITICAL_USED = 95;
// The 7d window is spent up to WEEK_CAP, the share of the week the maintainer allows (2026-09-29: keep at
// least half the week unused; 2026-10-04: that limit is lifted, so the whole week). Below WEEK_TARGET at
// reset the report advises widening Claude work.
// New Claude work stops when the week would pass WEEK_PROJECTED_LIMIT before its reset or WEEK_CRITICAL_USED
// is reached; the five points below the cap carry the manager to the reset.
export const WEEK_CAP = Number(process.env.GOAL_CLAUDE_WEEK_CAP ?? 100);
export const WEEK_TARGET = WEEK_CAP - 10;
export const WEEK_PROJECTED_LIMIT = WEEK_CAP - 5;
export const WEEK_CRITICAL_USED = WEEK_CAP - 5;

function resetSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isNaN(ms) ? undefined : ms / 1000; }
  return undefined;
}

// Percent per second: the recent slope of the current window when goalctl has at least ten
// minutes of samples from the last half hour (it tracks the present worker width), otherwise
// the window average, counted over at least 15 minutes so an early spike is not extrapolated.
export function burnRate(used: number, now: number, resets: number, windowSeconds: number,
  history: UsageSample[] = []): number {
  const recent = history.filter(s => s.resets === resets && s.at >= now - 1800 && s.at <= now - 600);
  if (recent.length) {
    const first = recent.reduce((a, b) => (a.at <= b.at ? a : b));
    return Math.max(0, used - first.used) / (now - first.at);
  }
  return used / Math.max(900, now - (resets - windowSeconds));
}

// Whole-point readings leave one point of uncertainty in a difference. Use its low end for
// admission and retain its high end for status; a one-point tick alone must not halt dispatch.
function weekBurnRange(used: number, now: number, resets: number, history: UsageSample[]): [number, number] {
  const recent = history.filter(s => s.weekResets === resets && typeof s.week === 'number'
    && s.at >= now - 6 * 3600 && s.at <= now - 3600);
  if (recent.length) {
    const first = recent.reduce((a, b) => (a.at <= b.at ? a : b));
    const difference = used - first.week!;
    const elapsed = now - first.at;
    return [Math.max(0, difference - 1) / elapsed, Math.max(0, difference + 1) / elapsed];
  }
  const elapsed = Math.max(6 * 3600, now - (resets - SEVEN_DAYS));
  return [Math.max(0, used - 0.5) / elapsed, (used + 0.5) / elapsed];
}

export function weekBurnRate(used: number, now: number, resets: number, history: UsageSample[] = []): number {
  return weekBurnRange(used, now, resets, history)[0];
}

export function usageLevel(snapshot: UsageSnapshot | undefined, nowMs: number,
  history: UsageSample[] = []): UsageReport {
  const five = snapshot?.rate_limits?.five_hour;
  const used = five?.used_percentage;
  if (!snapshot?.at || typeof used !== 'number') return { level: 'unknown' };
  const now = nowMs / 1000;
  const ageSeconds = Math.round(now - snapshot.at);
  if (ageSeconds > 1800) return { level: 'unknown', used, ageSeconds };
  const report: UsageReport = { level: 'normal', used, ageSeconds };
  const week = snapshot.rate_limits?.seven_day;
  const weekResets = resetSeconds(week?.resets_at);
  if (typeof week?.used_percentage === 'number' && weekResets !== undefined && weekResets > now) {
    report.weekUsed = week.used_percentage;
    report.weekResetInHours = Math.round((weekResets - now) / 360) / 10;
    const [low, high] = weekBurnRange(week.used_percentage, now, weekResets, history);
    report.weekProjected = Math.round(week.used_percentage + low * (weekResets - now));
    report.weekProjectedHigh = Math.round(week.used_percentage + high * (weekResets - now));
    report.weekAdvice = report.weekProjectedHigh >= WEEK_PROJECTED_LIMIT
      ? `warning: the week's high projection reaches ${report.weekProjectedHigh}%; watch Claude usage`
      : report.weekProjected < WEEK_TARGET
      ? `widen: the week lands at ${report.weekProjected}%; add Claude width or effort`
      : 'on target';
  }
  if (used >= CRITICAL_USED) return { ...report, level: 'critical', reason: `5h used >= ${CRITICAL_USED}%` };
  if ((report.weekUsed ?? 0) >= WEEK_CRITICAL_USED) {
    return { ...report, level: 'critical', reason: `7d used >= ${WEEK_CRITICAL_USED}%; the rest carries the manager` };
  }
  const resets = resetSeconds(five?.resets_at);
  // Without a reset time the window cannot be paced; fall back to the fixed 80% threshold.
  if (resets === undefined || resets <= now) {
    return { ...report, level: used >= 80 ? 'restricted' : 'normal', reason: 'no reset time; fixed 80%' };
  }
  const rate = burnRate(used, now, resets, FIVE_HOURS, history);
  const projected = Math.round(used + rate * (resets - now));
  Object.assign(report, { resetInMinutes: Math.round((resets - now) / 60), ratePerHour: Math.round(rate * 36000) / 10,
    projected });
  if (projected >= PROJECTED_LIMIT) {
    return { ...report, level: 'restricted', reason: `5h projected ${projected}% at reset` };
  }
  if ((report.weekProjected ?? 0) >= WEEK_PROJECTED_LIMIT) {
    return { ...report, level: 'restricted', reason: `7d projected ${report.weekProjected}% before its reset` };
  }
  return report;
}

// Codex CLIs record the account's rate limits with each turn in their session rollouts, so the newest
// rollout line that carries them is the account's current usage.
export function parseCodexUsage(text: string, nowMs: number): Partial<AccountUsage> {
  const now = nowMs / 1000;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    try {
      type Window = { used_percent?: number; window_minutes?: number; resets_at?: number };
      const event = JSON.parse(lines[i]!) as { timestamp?: string; payload?: { rate_limits?: {
        primary?: Window | null; secondary?: Window | null; plan_type?: string; rate_limit_reached_type?: string | null } } };
      const limits = event.payload?.rate_limits;
      const windows = [limits?.primary, limits?.secondary].filter((w): w is Window => typeof w?.used_percent === 'number');
      if (!limits || !windows.length) continue;
      const parsedAt = event.timestamp ? Date.parse(event.timestamp) / 1000 : undefined;
      const at = parsedAt !== undefined && Number.isFinite(parsedAt) ? parsedAt : undefined;
      const ageSeconds = at === undefined ? undefined : Math.round(now - at);
      // A window whose reset has passed starts empty again.
      const live = windows.filter(w => (w.resets_at ?? Infinity) > now);
      const week = windows.find(w => w.window_minutes === 7 * 24 * 60);
      const weekUsed = week ? (week.resets_at ?? Infinity) > now ? week.used_percent : 0 : undefined;
      if (!live.length) return { used: 0, reached: false, plan: limits.plan_type, ageSeconds, weekUsed };
      const fullest = live.reduce((a, b) => (b.used_percent! > a.used_percent! ? b : a));
      return { used: fullest.used_percent, windowMinutes: fullest.window_minutes, plan: limits.plan_type, ageSeconds, weekUsed,
        sampledAt: at, windowResetsAt: fullest.resets_at,
        resetInHours: fullest.resets_at === undefined ? undefined : Math.round((fullest.resets_at - now) / 360) / 10,
        reached: fullest.used_percent! >= 100 || !!limits.rate_limit_reached_type };
    } catch { /* partial line */ }
  }
  return {};
}

// Admission and reporting share the authoritative normalized observation. Legacy status-line
// snapshots (including seven-day-only output) never establish fresh session capacity.
export function currentUsage(): UsageReport {
  const { cache, decision } = capacityStatus();
  const current = cache?.current;
  return { level: decision.reason === 'capacity-unknown' || current?.error ? 'unknown'
    : decision.reason === 'allowance-exhausted' ? 'critical' : decision.admit ? 'normal' : 'restricted',
    reason: decision.reason, used: current?.five_hour?.used, weekUsed: current?.seven_day?.used,
    ageSeconds: current ? Math.round((Date.now() - current.observedAt) / 1000) : undefined,
    resetInMinutes: current?.five_hour ? Math.round((current.five_hour.resetsAt - Date.now()) / 60_000) : undefined };
}

// Rollouts live under sessions/YYYY/MM/DD/; a resumed session keeps appending to its first day's file,
// so look at the newest few days and take the most recently written rollout.
// Rollouts of the last three session days, newest first. A rollout records rate limits only after its
// first model response, so the newest one may carry none (2026-09-30: an idle session hid 87% used).
function recentRollouts(home: string): string[] {
  const children = (dir: string): string[] => {
    try { return readdirSync(dir).sort().reverse().map(name => join(dir, name)); } catch { return []; }
  };
  const days = children(join(home, 'sessions')).flatMap(children).flatMap(children).slice(0, 3);
  const files = days.flatMap(day => children(day).filter(file => file.endsWith('.jsonl')));
  return files.map(file => ({ file, at: statSync(file).mtimeMs })).sort((a, b) => b.at - a.at).map(item => item.file);
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function codexAccounts(): AccountUsage[] {
  const accounts: AccountUsage[] = configuredAccounts().map((account, index) => ({ account: account.engine,
    home: account.home ?? '', engines: [account.engine, ...(index === 0 ? ['luna'] : [])],
    weight: account.weight, pastAllowance: account.pastAllowance }));
  return accounts.map(account => {
    if (!account.home) return account;
    for (const file of recentRollouts(account.home)) {
      const usage = parseCodexUsage(tail(file, 512 * 1024), Date.now());
      if (usage.used !== undefined) return { ...account, ...usage };
    }
    return account;
  });
}

function resetStatusFrom(value: unknown): CodexResetStatus | undefined {
  if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object') return undefined;
  return value as CodexResetStatus;
}

/** Read a public GET-only status snapshot, with a local 30-minute cache and no credentials. */
export async function loadCodexResetStatus(options: {
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>; cacheFile?: string; nowMs?: number;
} = {}): Promise<CodexResetLoad> {
  const nowMs = options.nowMs ?? Date.now();
  const cacheFile = options.cacheFile ?? codexResetCachePath;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { fetchedAt?: number; status?: unknown };
    const status = resetStatusFrom(cached.status);
    if (status && typeof cached.fetchedAt === 'number' && nowMs >= cached.fetchedAt
      && nowMs - cached.fetchedAt < CODEX_RESET_CACHE_MS) {
      return { status, fetchedAt: cached.fetchedAt, available: true };
    }
  } catch { /* no usable cache */ }
  try {
    const response = await (options.fetcher ?? fetch)(CODEX_RESET_URL, {
      method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { available: false };
    const status = resetStatusFrom(await response.json());
    if (!status) return { available: false };
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ fetchedAt: nowMs, status }));
    } catch { /* a cache write is best effort */ }
    return { status, fetchedAt: nowMs, available: true };
  } catch { return { available: false }; }
}

export function codexHoursUntil100(account: AccountUsage, announcedAt: string | undefined, nowMs: number): number | undefined {
  if (typeof account.used !== 'number') return undefined;
  const paceStart = codexPaceStartSeconds(account, announcedAt);
  if (account.windowMinutes === undefined || paceStart === undefined || account.used <= 0) return undefined;
  const now = nowMs / 1000;
  const sampleAt = account.sampledAt ?? (account.ageSeconds === undefined ? Number.NaN : now - account.ageSeconds);
  if (!Number.isFinite(sampleAt) || sampleAt < paceStart) return undefined;
  if (account.used >= 100) return 0;
  const elapsedAtSample = (sampleAt - paceStart) / 3600;
  if (elapsedAtSample <= 0) return undefined;
  const percentPerHour = account.used / elapsedAtSample;
  if (percentPerHour <= 0) return undefined;
  const remaining = (100 - account.used) / percentPerHour - (now - sampleAt) / 3600;
  return Math.round(Math.max(0, remaining) * 10) / 10;
}

function codexPaceStartSeconds(account: AccountUsage, announcedAt: string | undefined): number | undefined {
  if (account.windowMinutes === undefined || account.windowResetsAt === undefined) return undefined;
  const windowStart = account.windowResetsAt - account.windowMinutes * 60;
  const latestReset = announcedAt ? Date.parse(announcedAt) / 1000 : Number.NaN;
  return Number.isFinite(latestReset) ? Math.max(windowStart, latestReset) : windowStart;
}

export interface GoalUsageReport {
  claude: UsageReport & { file: string };
  codex: (Omit<AccountUsage, 'windowResetsAt' | 'sampledAt'> & {
    pace_since: string | 'unavailable'; hours_until_100_percent: number | 'unavailable';
  })[];
  codex_resets: {
    source: 'Data from codex-resets.com'; status?: 'unavailable';
    latest_reset?: { announced_at: string | 'unavailable'; age_hours: number | 'unavailable' };
    stats?: { avg_interval_days: number | 'unavailable' };
  };
}

export async function usageReport(options: {
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>; cacheFile?: string; nowMs?: number;
} = {}): Promise<GoalUsageReport> {
  const nowMs = options.nowMs ?? Date.now();
  const reset = await loadCodexResetStatus({ ...options, nowMs });
  const announcedAt = reset.status?.data?.latest_reset?.announced_at;
  const announcedMs = announcedAt ? Date.parse(announcedAt) : Number.NaN;
  const ageHours = Number.isFinite(announcedMs) ? Math.round(Math.max(0, nowMs - announcedMs) / 360_000) / 10 : 'unavailable';
  const interval = reset.status?.data?.stats?.avg_interval_days;
  const accounts = codexAccounts();
  return {
    claude: { ...currentUsage(), file: capacityStatus().files.observation },
    codex: accounts.map(account => {
      const paceStart = reset.available ? codexPaceStartSeconds(account, announcedAt) : undefined;
      const publicAccount = Object.fromEntries(Object.entries(account)
        .filter(([key]) => key !== 'windowResetsAt' && key !== 'sampledAt')) as Omit<AccountUsage, 'windowResetsAt' | 'sampledAt'>;
      return { ...publicAccount,
        pace_since: paceStart === undefined ? 'unavailable' : new Date(paceStart * 1000).toISOString(),
        hours_until_100_percent: paceStart === undefined ? 'unavailable'
          : codexHoursUntil100(account, announcedAt, nowMs) ?? 'unavailable' };
    }),
    codex_resets: reset.available ? {
      source: 'Data from codex-resets.com',
      latest_reset: { announced_at: announcedAt ?? 'unavailable', age_hours: ageHours },
      stats: { avg_interval_days: typeof interval === 'number' ? interval : 'unavailable' },
    } : { source: 'Data from codex-resets.com', status: 'unavailable' },
  };
}

export function describeAccount(account: AccountUsage): string {
  return `${account.account} (${account.engines.join('/')}): `
    + (account.used === undefined ? 'no usage recorded yet'
      : `${account.used}% of ${account.windowMinutes ? `${Math.round(account.windowMinutes / 1440)}d` : 'window'}`
        + `${account.reached ? ' EXHAUSTED' : ''}`
        + (account.resetInHours !== undefined ? `, resets in ${account.resetInHours}h` : '')
        + (account.ageSeconds !== undefined ? ` (${Math.round(account.ageSeconds / 60)}m old)` : ''));
}
