import { AsyncLocalStorage } from 'node:async_hooks';

type Phase =
  | 'before_command'
  | 'command_overhead'
  | 'time_mint'
  | 'access_prepare'
  | 'gate_wait'
  | 'transaction_pool_wait'
  | 'transaction_body'
  | 'commit'
  | 'writable_wait'
  | 'contention_pause'
  | 'request_completion';

const phases: Phase[] = [
  'before_command',
  'command_overhead',
  'time_mint',
  'access_prepare',
  'gate_wait',
  'transaction_pool_wait',
  'transaction_body',
  'commit',
  'writable_wait',
  'contention_pause',
  'request_completion',
];
type Timing = {
  started: number;
  boundary: number;
  phase: Phase;
  durations: Record<Phase, number>;
  accessPreparations: AccessPreparationSample[];
  retries: number;
  ended: boolean;
  logged: boolean;
};
type AccessPreparationFrame = {
  startedAt: number;
  poolCheckoutMs: number;
  clockQueryMs: number;
};
type AccessPreparationSample = Omit<AccessPreparationFrame, 'startedAt'> & { wallMs: number };
const timings = new AsyncLocalStorage<Timing>();
const accessPreparation = new AsyncLocalStorage<AccessPreparationFrame>();

const ACCESS_PREPARATION_SAMPLES = 8;

/** Request-local diagnostics only: no wall clock, SQL, body or retained attempt history. */
export async function withCommandTiming<T>(run: () => T | Promise<T>): Promise<T> {
  const existing = timings.getStore();
  if (existing && !existing.ended) return await run();
  const started = performance.now();
  const timing: Timing = {
    started,
    boundary: started,
    phase: 'before_command',
    durations: Object.fromEntries(phases.map((phase) => [phase, 0])) as Record<Phase, number>,
    accessPreparations: [],
    retries: 0,
    ended: false,
    logged: false,
  };
  return timings.run(timing, async () => {
    try {
      return await run();
    } finally {
      timing.ended = true;
    }
  });
}

/** Add request-local Access diagnostics without retaining SQL, identities or request bodies. */
export async function withAccessPreparationTiming<T>(run: () => T | Promise<T>): Promise<T> {
  const timing = timings.getStore();
  if (!timing || timing.ended) return await run();
  const frame: AccessPreparationFrame = { startedAt: performance.now(), poolCheckoutMs: 0, clockQueryMs: 0 };
  return accessPreparation.run(frame, async () => {
    try {
      return await run();
    } finally {
      const { startedAt: _startedAt, ...measurements } = frame;
      timing.accessPreparations.push({ ...measurements, wallMs: performance.now() - frame.startedAt });
      if (timing.accessPreparations.length > ACCESS_PREPARATION_SAMPLES)
        timing.accessPreparations.splice(0, timing.accessPreparations.length - ACCESS_PREPARATION_SAMPLES);
    }
  });
}

/** Record a nested clock-query breakdown; these submeasurements are not added to phases_ms. */
export function recordAccessClockTiming(poolCheckoutMs: number, clockQueryMs: number): void {
  const sample = accessPreparation.getStore();
  if (!sample) return;
  if (Number.isFinite(poolCheckoutMs) && poolCheckoutMs > 0) sample.poolCheckoutMs += poolCheckoutMs;
  if (Number.isFinite(clockQueryMs) && clockQueryMs > 0) sample.clockQueryMs += clockQueryMs;
}

export function commandPhase(phase: Phase): void {
  const timing = timings.getStore();
  if (!timing || timing.ended) return;
  const now = performance.now();
  timing.durations[timing.phase] += now - timing.boundary;
  timing.boundary = now;
  timing.phase = phase;
}

export async function measureCommandPhase<T>(phase: Phase, run: () => Promise<T>): Promise<T> {
  const previous = timings.getStore()?.phase;
  commandPhase(phase);
  try {
    return await run();
  } finally {
    if (previous) commandPhase(previous);
  }
}

export function countContentionRetry(): void {
  const timing = timings.getStore();
  if (timing && !timing.ended) timing.retries++;
}

export function commandTimingSnapshot(once = false) {
  const timing = timings.getStore();
  if (!timing || timing.ended || (once && timing.logged)) return undefined;
  if (once) timing.logged = true;
  const now = performance.now();
  const durations = { ...timing.durations };
  durations[timing.phase] += now - timing.boundary;
  const dominant = phases.reduce((a, b) => (durations[a] >= durations[b] ? a : b));
  return {
    elapsed_ms: now - timing.started,
    phases_ms: durations,
    ...(timing.accessPreparations.length
      ? {
          access_preparations: timing.accessPreparations.map((sample) => ({
            wall_ms: sample.wallMs,
            pool_checkout_ms: sample.poolCheckoutMs,
            clock_query_after_checkout_ms: sample.clockQueryMs,
          })),
        }
      : {}),
    contention_retries: timing.retries,
    dominant_phase: dominant,
  };
}
