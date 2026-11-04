/** Native slow-mode units. Content owns policy; Web only displays and forwards these values. */
export const SLOW_MODE_INTERVALS = [0, 30, 60, 300] as const;
export type SlowModeInterval = number;

/** DTO from the installed shared publisher; parse it at the transport boundary. */
export type SlowModePolicy = NonNullable<
  Awaited<ReturnType<ReturnType<import('@rezics/client').KernelClient['boards']>['slowMode']['get']>>['data']
>;

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
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 86400;
}

function isoTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Accept only the documented native fields. Unknown shapes stay unavailable. */
export function parseSlowModePolicy(body: unknown): SlowModePolicy | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const source = body as Record<string, unknown>;
  const fields = [
    'intervalSeconds',
    'retryAt',
    'nextEligibleAt',
    'canChange',
    'exempt',
    'admissionState',
    'retryAfterSeconds',
  ];
  if (Object.keys(source).length !== fields.length || fields.some((field) => !(field in source))) return undefined;
  if (!isSlowModeInterval(source.intervalSeconds) || !isSlowModeInterval(source.retryAfterSeconds)) return undefined;
  const retryAt = isoTime(source.retryAt);
  const nextEligibleAt = isoTime(source.nextEligibleAt);
  if (
    retryAt === undefined ||
    nextEligibleAt === undefined ||
    typeof source.canChange !== 'boolean' ||
    typeof source.exempt !== 'boolean' ||
    (source.admissionState !== 'ready' && source.admissionState !== 'interval' && source.admissionState !== 'pending')
  )
    return undefined;
  return {
    intervalSeconds: source.intervalSeconds,
    retryAt,
    nextEligibleAt,
    canChange: source.canChange,
    exempt: source.exempt,
    admissionState: source.admissionState,
    retryAfterSeconds: source.retryAfterSeconds,
  };
}

export function deadlineFromRetryAfter(retryAfterSeconds: number, receivedAt: number): number {
  return receivedAt + Math.min(86400, Math.max(0, retryAfterSeconds)) * 1000;
}

export function remainingSeconds(waitUntil: number, now: number): number {
  return Math.max(0, Math.ceil((waitUntil - now) / 1000));
}

export function waitUntilFromPolicy(policy: SlowModePolicy, now: number): number | null {
  if (policy.admissionState === 'pending' || policy.intervalSeconds === 0 || policy.exempt || !policy.nextEligibleAt)
    return null;
  const time = Date.parse(policy.nextEligibleAt);
  if (!Number.isFinite(time) || time <= now) return null;
  return time;
}
