import { defaultPolicy, type ControlPolicy } from './policy.ts';
import type { Cli, Pool, PoolReading, Profile } from './types.ts';

export type PoolSelectionOptions = {
  preferred?: string;
  exclude?: string[];
  history?: readonly PoolReading[];
  now?: number;
  policy?: ControlPolicy['provider'] | undefined;
  spanMs?: number;
  /** Live worker sessions on each pool name: pending start and running. Waiting attempts do not occupy the cap. */
  running?: Readonly<Record<string, number>>;
  /** Skip only the pool's burn ceiling; reserve, exhaustion and concurrency still refuse. */
  ignoreBurnCeiling?: boolean;
};

export type PoolBurnStatus = {
  name: string;
  allowanceKey: string;
  burnPerHour: number;
  /** Raw same-window slope when it differs from the evidenced rate used for admission. */
  observedBurnPerHour?: number;
  maxBurnPerHour?: number;
  live?: number;
  waiting?: number;
  maxConcurrent?: number;
};

/** Why a burn comparison can or cannot support a numeric rate. */
export type BurnEvidenceKind = 'rate' | 'unresolved' | 'none';

/** Conservative evidenced burn plus the raw observed slope for diagnostics. */
export type BurnEvidence = {
  rate: number;
  observedRate: number;
  evidence: BurnEvidenceKind;
};

export type BurnOptions = {
  now?: number;
  spanMs?: number;
  /** Longer Codex coarse horizon; defaults to four times `spanMs` (6 h at the default 90-minute span). */
  horizonMs?: number;
  cli?: Cli;
  /** Hourly bridge: compare only the short span so a raw short slope cannot alarm on its own. */
  shortOnly?: boolean;
};

/** Codex coarse readings keep this many short spans so a 90-minute step stays under-resolved while sustained burn is visible. */
export const COARSE_BURN_HORIZON_FACTOR = 4;

export function burnHorizonMs(spanMs = defaultPolicy.pacing.burnSpanMs): number {
  return spanMs * COARSE_BURN_HORIZON_FACTOR;
}

const liveStates = new Set(['pending', 'running']);

function countByPool(
  attempts: readonly { pool: string; state: string }[],
  include: (state: string) => boolean,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of attempts) {
    if (!include(attempt.state)) continue;
    counts[attempt.pool] = (counts[attempt.pool] ?? 0) + 1;
  }
  return counts;
}

/** Occupancy that fills `policy.maxConcurrent`: pending-start and running sessions on each pool. */
export function countRunningByPool(attempts: readonly { pool: string; state: string }[]): Record<string, number> {
  return countByPool(attempts, (state) => liveStates.has(state));
}

/** Attempts parked on checks (state waiting); they do not occupy `policy.maxConcurrent`. */
export function countWaitingByPool(attempts: readonly { pool: string; state: string }[]): Record<string, number> {
  return countByPool(attempts, (state) => state === 'waiting');
}

type ReadingWindow = PoolReading['windows'][number];

/**
 * Providers stamp one window's reset a few milliseconds or seconds apart between readings, so readings pair within this
 * tolerance. A real reset moves the stamp by a window length and starts a new series.
 */
const sameResetToleranceMs = 60_000;

/** Equal window length and a reset stamp within the tolerance; an unknown stamp matches only another unknown one. */
function sameWindow(past: ReadingWindow, window: ReadingWindow): boolean {
  if (past.minutes !== window.minutes) return false;
  if (past.resetsAt === null || window.resetsAt === null) return past.resetsAt === window.resetsAt;
  return Math.abs(past.resetsAt - window.resetsAt) <= sameResetToleranceMs;
}

const none: BurnEvidence = { rate: 0, observedRate: 0, evidence: 'none' };
const evidenceRank: Record<BurnEvidenceKind, number> = { none: 0, unresolved: 1, rate: 2 };

function strongerBurn(left: BurnEvidence, right: BurnEvidence): BurnEvidence {
  if (right.rate > left.rate) return right;
  if (left.rate > right.rate) return left;
  return evidenceRank[right.evidence] > evidenceRank[left.evidence] ? right : left;
}

function coarseCodexPair(cli: Cli | undefined, currentUsed: number, pastUsed: number): boolean {
  return cli === 'codex' && (Number.isInteger(currentUsed) || Number.isInteger(pastUsed));
}

function earliestMatching(
  window: ReadingWindow,
  current: PoolReading,
  history: readonly PoolReading[],
  currentAt: number,
  start: number,
  requireKnownReset: boolean,
): { at: number; used: number } | undefined {
  let earliestAt: number | undefined;
  let earliestUsed: number | undefined;
  for (const past of history) {
    if (past.allowanceKey !== current.allowanceKey || !past.observedAt) continue;
    const at = Date.parse(past.observedAt);
    if (!Number.isFinite(at) || at < start || at >= currentAt) continue;
    const old = past.windows.find((candidate) => sameWindow(candidate, window));
    if (!old) continue;
    if (requireKnownReset && (old.resetsAt === null || window.resetsAt === null)) continue;
    if (earliestAt === undefined || at < earliestAt) {
      earliestAt = at;
      earliestUsed = old.usedPercent;
    }
  }
  return earliestAt === undefined || earliestUsed === undefined ? undefined : { at: earliestAt, used: earliestUsed };
}

function rateFromPair(currentUsed: number, pastUsed: number, elapsed: number, cli: Cli | undefined): BurnEvidence {
  if (elapsed <= 0) return none;
  const delta = Math.max(0, currentUsed - pastUsed);
  const observedRate = (delta * 3_600_000) / elapsed;
  const coarse = coarseCodexPair(cli, currentUsed, pastUsed);
  const evidencedDelta = coarse ? Math.max(0, delta - 1) : delta;
  const rate = (evidencedDelta * 3_600_000) / elapsed;
  if (coarse && evidencedDelta === 0) return { rate: 0, observedRate, evidence: 'unresolved' };
  return { rate, observedRate, evidence: 'rate' };
}

function windowBurn(
  window: ReadingWindow,
  current: PoolReading,
  history: readonly PoolReading[],
  currentAt: number,
  now: number,
  spanMs: number,
  horizonMs: number,
  cli: Cli | undefined,
  shortOnly: boolean,
): BurnEvidence {
  const short = earliestMatching(window, current, history, currentAt, now - spanMs, false);
  const shortEvidence = short ? rateFromPair(window.usedPercent, short.used, currentAt - short.at, cli) : none;
  if (shortOnly || cli !== 'codex') return shortEvidence;
  const long = earliestMatching(window, current, history, currentAt, now - horizonMs, true);
  if (!long) return shortEvidence;
  const shortCoarse = short ? coarseCodexPair(cli, window.usedPercent, short.used) : false;
  const longCoarse = coarseCodexPair(cli, window.usedPercent, long.used);
  if (!shortCoarse && !longCoarse) return shortEvidence;
  return strongerBurn(shortEvidence, rateFromPair(window.usedPercent, long.used, currentAt - long.at, cli));
}

// Milliseconds per hour, minutes per day and percentages below are unit conversions, not admission policy.
/**
 * Same-window consumption used for hard pacing, near-ceiling and the hourly alarm. Codex pairs that include an integer
 * sample treat one observed point as endpoint uncertainty: evidenced burn is max(0, delta - 1 pp) over actual elapsed
 * time. Those coarse series also compare a bounded longer horizon (four short spans, 6 h by default) so several points
 * can still prove sustained excess. Fractional Codex pairs and other providers keep the raw short-span slope. Resets
 * are never burn; a long-span pair needs a known matching reset.
 */
export function burnEvidence(
  current: PoolReading,
  history: readonly PoolReading[] = [],
  options: BurnOptions = {},
): BurnEvidence {
  if (!current.observedAt) return none;
  const currentAt = Date.parse(current.observedAt);
  if (!Number.isFinite(currentAt)) return none;
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const horizonMs = options.horizonMs ?? burnHorizonMs(spanMs);
  const now = options.now ?? currentAt;
  const shortOnly = options.shortOnly === true;
  return current.windows.reduce(
    (best, window) =>
      strongerBurn(
        best,
        windowBurn(window, current, history, currentAt, now, spanMs, horizonMs, options.cli, shortOnly),
      ),
    none,
  );
}

/** Evidenced percent-per-hour for admission. Unresolved coarse precision is 0 so a single integer step does not refuse. */
export function burnPerHour(
  current: PoolReading,
  history: readonly PoolReading[] = [],
  options: BurnOptions = {},
): number {
  return burnEvidence(current, history, options).rate;
}

export function poolBurnStatus(
  pools: readonly Pool[],
  history: readonly PoolReading[],
  now = Date.now(),
  spanMs = defaultPolicy.pacing.burnSpanMs,
  live: Readonly<Record<string, number>> = {},
  waiting: Readonly<Record<string, number>> = {},
): PoolBurnStatus[] {
  return pools.map((pool) => {
    const series = history.filter((reading) => reading.allowanceKey === pool.allowanceKey && reading.observedAt);
    const latest = series.reduce<PoolReading | undefined>((chosen, reading) => {
      if (!chosen?.observedAt) return reading;
      return Date.parse(reading.observedAt!) >= Date.parse(chosen.observedAt) ? reading : chosen;
    }, undefined);
    const evidence = latest ? burnEvidence(latest, series, { now, spanMs, cli: pool.cli }) : none;
    return {
      name: pool.name,
      allowanceKey: pool.allowanceKey,
      burnPerHour: evidence.rate,
      ...(evidence.observedRate !== evidence.rate ? { observedBurnPerHour: evidence.observedRate } : {}),
      ...(pool.policy.maxBurnPerHour === undefined ? {} : { maxBurnPerHour: pool.policy.maxBurnPerHour }),
      ...(pool.policy.maxConcurrent === undefined
        ? {}
        : {
            live: live[pool.name] ?? 0,
            waiting: waiting[pool.name] ?? 0,
            maxConcurrent: pool.policy.maxConcurrent,
          }),
    };
  });
}

/**
 * The percent a window keeps back. A reserve keeps allowance for the managers until the window resets, so in a window
 * longer than a day it need not exceed reservePerHour for each hour left: an ending week's leftover goes to work. A
 * window of a day or less keeps its whole reserve, since that window is what keeps managers running.
 */
export function effectiveReserve(pool: Pool, window: PoolReading['windows'][number], now: number): number {
  const perHour = pool.policy.reservePerHour;
  if (perHour === undefined || window.resetsAt === null || (window.minutes ?? 0) <= 24 * 60)
    return pool.policy.reservePercent;
  return Math.min(pool.policy.reservePercent, (perHour * Math.max(0, window.resetsAt - now)) / 3_600_000);
}

export type AllowanceResetPressure = { unusedPercent: number; hoursToReset: number; urgency: number };

/** A reading is fresh under the same age and provider clock-skew limits used to admit its pool. */
export function isFreshPoolReading(
  pool: Pool,
  reading: PoolReading,
  now: number,
  observationClockSkewMs = defaultPolicy.provider.observationClockSkewMs,
): boolean {
  if (!reading.observedAt) return false;
  const observedAt = Date.parse(reading.observedAt);
  return (
    Number.isFinite(observedAt) &&
    now - observedAt <= pool.policy.maxAgeMs &&
    observedAt <= now + observationClockSkewMs
  );
}

/** Unused allowance per hour until its longest window resets, after the pool's reserve. */
export function allowanceResetPressure(
  reading: PoolReading,
  pool: Pool,
  now: number,
  options: { resetAt?: number; minimumResetMs?: number } = {},
): AllowanceResetPressure | undefined {
  const window = [...reading.windows].sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0))[0];
  const resetAt = options.resetAt ?? window?.resetsAt;
  if (!window || resetAt === null || resetAt === undefined || !Number.isFinite(resetAt) || resetAt <= now)
    return undefined;
  const minimumResetMs = options.minimumResetMs ?? defaultPolicy.pacing.minimumResetMs;
  const hoursToReset = Math.max(resetAt - now, minimumResetMs) / 3_600_000;
  const unusedPercent = Math.max(0, 100 - effectiveReserve(pool, window, now) - window.usedPercent);
  return { unusedPercent, hoursToReset, urgency: unusedPercent / hoursToReset };
}

type IndexedReading = { reading: PoolReading; history: readonly PoolReading[] };
type AllowanceIndex = ReadonlyMap<string, readonly IndexedReading[]>;
type PoolAllowance = { score: number; resetPressure?: number } | null;

/** Index shared readings and history once by allowance key, then reuse that projection across profile fallbacks. */
function indexAllowanceReadings(readings: readonly PoolReading[], history: readonly PoolReading[]): AllowanceIndex {
  const historyByAllowance = new Map<string, PoolReading[]>();
  for (const previous of history) {
    const list = historyByAllowance.get(previous.allowanceKey);
    if (list) list.push(previous);
    else historyByAllowance.set(previous.allowanceKey, [previous]);
  }
  const indexed = new Map<string, IndexedReading[]>();
  for (const reading of readings) {
    const past = historyByAllowance.get(reading.allowanceKey) ?? [];
    const allowance = indexed.get(reading.allowanceKey) ?? [];
    allowance.push({ reading, history: past });
    indexed.set(reading.allowanceKey, allowance);
  }
  return indexed;
}

function assessPool(
  pool: Pool,
  indexedReadings: AllowanceIndex,
  now: number,
  policy: ControlPolicy['provider'] | undefined,
  spanMs: number,
  running: Readonly<Record<string, number>>,
  ignoreBurnCeiling: boolean,
): PoolAllowance {
  if (pool.policy.maxConcurrent !== undefined && (running[pool.name] ?? 0) >= pool.policy.maxConcurrent) return null;
  const shared = indexedReadings.get(pool.allowanceKey) ?? [];
  const fresh = shared.filter(({ reading }) =>
    isFreshPoolReading(pool, reading, now, (policy ?? defaultPolicy.provider).observationClockSkewMs),
  );
  if (
    fresh.some(
      ({ reading }) =>
        reading.exhausted ||
        reading.windows.some((window) => window.usedPercent >= 100 - effectiveReserve(pool, window, now)),
    )
  )
    return null;
  if (!fresh.length && !pool.policy.allowUnknown) return null;
  const rates = fresh.map(({ reading, history }) => burnPerHour(reading, history, { now, spanMs, cli: pool.cli }));
  if (
    !ignoreBurnCeiling &&
    pool.policy.maxBurnPerHour !== undefined &&
    rates.some((rate) => rate > pool.policy.maxBurnPerHour!)
  )
    return null;
  const used = Math.max(0, ...fresh.flatMap(({ reading }) => reading.windows.map((window) => window.usedPercent)));
  const latest = fresh.reduce<IndexedReading | undefined>((chosen, item) => {
    if (!chosen?.reading.observedAt) return item;
    return Date.parse(item.reading.observedAt!) > Date.parse(chosen.reading.observedAt) ? item : chosen;
  }, undefined);
  const pressure = latest ? allowanceResetPressure(latest.reading, pool, now) : undefined;
  return {
    score: (100 - used) * pool.policy.weight,
    ...(pressure === undefined ? {} : { resetPressure: pressure.urgency }),
  };
}

function selectPool(
  profile: Profile,
  pools: readonly Pool[],
  indexedReadings: AllowanceIndex,
  options: PoolSelectionOptions,
  now: number,
  spanMs: number,
  allowanceByPool: Map<Pool, PoolAllowance>,
  urgency?: (pool: Pool) => number | undefined,
): Pool | undefined {
  const candidates = pools.filter(
    (pool) =>
      pool.cli === profile.cli && pool.classes.includes(profile.poolClass) && !options.exclude?.includes(pool.name),
  );
  const ranked = candidates
    .map((pool) => {
      if (!allowanceByPool.has(pool))
        allowanceByPool.set(
          pool,
          assessPool(
            pool,
            indexedReadings,
            now,
            options.policy,
            spanMs,
            options.running ?? {},
            options.ignoreBurnCeiling === true,
          ),
        );
      const allowance = allowanceByPool.get(pool);
      if (!allowance) return null;
      const reportedPressure = urgency?.(pool);
      const resetPressure = reportedPressure ?? allowance.resetPressure;
      return {
        pool,
        score: allowance.score,
        preferred: pool.name === options.preferred,
        ...(resetPressure === undefined ? {} : { resetPressure }),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const comparableResetPressure =
    profile.poolClass !== 'manager' && ranked.length > 1 && ranked.every((item) => item.resetPressure !== undefined);
  ranked.sort(
    (a, b) =>
      Number(b.preferred) - Number(a.preferred) ||
      (comparableResetPressure ? b.resetPressure! - a.resetPressure! : 0) ||
      b.score - a.score ||
      a.pool.name.localeCompare(b.pool.name),
  );
  return ranked[0]?.pool;
}

export class PoolUnavailableError extends Error {
  constructor(profile: Profile) {
    super(`no allowed pool available for ${profile.cli}/${profile.poolClass}`);
  }
}

function poolMatches(profile: Profile, pools: readonly Pool[]): boolean {
  return pools.some((pool) => pool.cli === profile.cli && pool.classes.includes(profile.poolClass));
}

function noAllowedPool(profile: Profile, pools: readonly Pool[], fallbacks: readonly Profile[] = []): Error {
  const message = `no allowed pool available for ${profile.cli}/${profile.poolClass}`;
  // Missing configured routes remain configuration errors. A typed refusal only means a compatible configured pool
  // existed but current allowance, burn or concurrency rules admitted none of the requested profiles.
  return [profile, ...fallbacks].some((candidate) => poolMatches(candidate, pools))
    ? new PoolUnavailableError(profile)
    : new Error(message);
}

export function choosePool(
  profile: Profile,
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
): Pool {
  const now = options.now ?? Date.now();
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const indexedReadings = indexAllowanceReadings(readings, options.history ?? []);
  const selected = selectPool(profile, pools, indexedReadings, options, now, spanMs, new Map());
  if (!selected) throw noAllowedPool(profile, pools);
  return selected;
}

/** Apply the same freshness, reserve, pacing and occupancy rules to one already selected pool. */
export function poolAllowed(pool: Pool, readings: readonly PoolReading[], options: PoolSelectionOptions = {}): boolean {
  const now = options.now ?? Date.now();
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  return (
    assessPool(
      pool,
      indexAllowanceReadings(readings, options.history ?? []),
      now,
      options.policy,
      spanMs,
      options.running ?? {},
      options.ignoreBurnCeiling === true,
    ) !== null
  );
}

/** A mailbox wake can use the manager reserve and is independent of worker pacing and slots. */
export function managerWakePoolAllowed(
  pool: Pool,
  readings: readonly PoolReading[],
  policy?: ControlPolicy['provider'],
): boolean {
  const { maxConcurrent: _workerSlots, ...rest } = pool.policy;
  return poolAllowed(
    { ...pool, policy: { ...rest, reservePercent: 0, reservePerHour: 0, allowUnknown: true } },
    readings,
    { policy, ignoreBurnCeiling: true },
  );
}

/** The routed profile's pool, or the first fallback that has one; `undefined` when every candidate is refused. */
export function findAllowedPool(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
  urgency?: (pool: Pool) => number | undefined,
): { profile: Profile; pool: Pool } | undefined {
  const now = options.now ?? Date.now();
  const spanMs = options.spanMs ?? defaultPolicy.pacing.burnSpanMs;
  const selection = { ...options, now, spanMs };
  const indexedReadings = indexAllowanceReadings(readings, selection.history ?? []);
  const allowanceByPool = new Map<Pool, PoolAllowance>();
  const urgencyByPool = new Map<Pool, number | undefined>();
  const poolUrgency = urgency
    ? (pool: Pool) => {
        if (!urgencyByPool.has(pool)) urgencyByPool.set(pool, urgency(pool));
        return urgencyByPool.get(pool);
      }
    : undefined;
  if (urgency && !options.preferred) {
    const choices = [profile, ...fallbacks].flatMap((candidate, order) => {
      const pool = selectPool(candidate, pools, indexedReadings, selection, now, spanMs, allowanceByPool, poolUrgency);
      return pool ? [{ profile: candidate, pool, order, urgency: poolUrgency!(pool) ?? -1 }] : [];
    });
    choices.sort((a, b) => b.urgency - a.urgency || a.order - b.order);
    if (choices[0]) return { profile: choices[0].profile, pool: choices[0].pool };
  }
  const primary = selectPool(profile, pools, indexedReadings, selection, now, spanMs, allowanceByPool, poolUrgency);
  if (primary) return { profile, pool: primary };
  const { preferred: _preferred, ...fallbackOptions } = selection;
  for (const candidate of fallbacks) {
    const pool = selectPool(
      candidate,
      pools,
      indexedReadings,
      fallbackOptions,
      now,
      spanMs,
      allowanceByPool,
      poolUrgency,
    );
    if (pool) return { profile: candidate, pool };
  }
  return undefined;
}

/**
 * The routed profile's pool, or the first fallback profile that has one when the routed CLI has no quota. With a pacing
 * measure, a new task instead goes to the allowed profile whose allowance most needs spending before it resets; a
 * retry keeps its engine while that has quota. A pool over its burn ceiling or concurrent-worker cap is skipped; with
 * no allowed fallback the task waits. Running attempts are not stopped.
 */
export function choosePoolWithFallback(
  profile: Profile,
  fallbacks: readonly Profile[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
  urgency?: (pool: Pool) => number | undefined,
): { profile: Profile; pool: Pool } {
  const selected = findAllowedPool(profile, fallbacks, pools, readings, options, urgency);
  if (!selected) throw noAllowedPool(profile, pools, fallbacks);
  return selected;
}

/** The first configured pool the routed profile would use; ready tasks wait on this pool when none are allowed. */
export function waitingPoolName(profile: Profile, pools: readonly Pool[]): string | undefined {
  return [...pools]
    .filter((pool) => pool.cli === profile.cli && pool.classes.includes(profile.poolClass))
    .sort((a, b) => a.name.localeCompare(b.name))[0]?.name;
}

/** Ready tasks whose route has no allowed pool, counted on the pool their first profile would use. */
export function countAllowanceWaiting(
  items: readonly { first: Profile; fallbacks: readonly Profile[] }[],
  pools: readonly Pool[],
  readings: readonly PoolReading[],
  options: PoolSelectionOptions = {},
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (findAllowedPool(item.first, item.fallbacks, pools, readings, options)) continue;
    const name = waitingPoolName(item.first, pools);
    if (!name) continue;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}
