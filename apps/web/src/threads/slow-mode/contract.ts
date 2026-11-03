/** Native slow-mode units. Content owns policy; Web only displays and forwards these values. */
export const SLOW_MODE_INTERVALS = [0, 30, 60, 300] as const;
export type SlowModeInterval = (typeof SLOW_MODE_INTERVALS)[number];

export type SlowModePolicy = {
  intervalSeconds: SlowModeInterval;
  nextEligibleAt: string | null;
  canChange: boolean;
  exempt: boolean;
};

export type SlowModeRead = { kind: 'available'; policy: SlowModePolicy } | { kind: 'denied' } | { kind: 'unavailable' };

export type SlowModeChange =
  | { kind: 'applied'; policy: SlowModePolicy }
  | { kind: 'denied' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' }
  | { kind: 'unknown' };

export type SlowModePort = {
  read(input: { boardId: string; signal?: AbortSignal }): Promise<SlowModeRead>;
  change(input: {
    boardId: string;
    intervalSeconds: SlowModeInterval;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<SlowModeChange>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validBoardId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function isSlowModeInterval(value: unknown): value is SlowModeInterval {
  return value === 0 || value === 30 || value === 60 || value === 300;
}

function isoTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Accept only the documented native fields. Unknown shapes stay unavailable. */
export function parseSlowModePolicy(body: unknown): SlowModePolicy | undefined {
  const source =
    body && typeof body === 'object' && !Array.isArray(body)
      ? 'slowMode' in body && body.slowMode && typeof body.slowMode === 'object'
        ? body.slowMode
        : 'postingInterval' in body && body.postingInterval && typeof body.postingInterval === 'object'
          ? body.postingInterval
          : 'policy' in body && body.policy && typeof body.policy === 'object'
            ? body.policy
            : body
      : null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const interval =
    'intervalSeconds' in source
      ? source.intervalSeconds
      : 'interval' in source
        ? source.interval
        : 'seconds' in source
          ? source.seconds
          : undefined;
  if (!isSlowModeInterval(interval)) return undefined;
  const next =
    'nextEligibleAt' in source
      ? isoTime(source.nextEligibleAt)
      : 'nextPermittedAt' in source
        ? isoTime(source.nextPermittedAt)
        : null;
  if (next === undefined) return undefined;
  return {
    intervalSeconds: interval,
    nextEligibleAt: next,
    canChange: 'canChange' in source && source.canChange === true,
    exempt: 'exempt' in source && source.exempt === true,
  };
}

export function deadlineFromRetryAfter(retryAfterSeconds: number, receivedAt: number): number {
  return receivedAt + Math.min(3600, Math.max(0, retryAfterSeconds)) * 1000;
}

export function remainingSeconds(waitUntil: number, now: number): number {
  return Math.max(0, Math.ceil((waitUntil - now) / 1000));
}

export function waitUntilFromPolicy(policy: SlowModePolicy, now: number): number | null {
  if (policy.intervalSeconds === 0 || policy.exempt || !policy.nextEligibleAt) return null;
  const time = Date.parse(policy.nextEligibleAt);
  if (!Number.isFinite(time) || time <= now) return null;
  return time;
}
