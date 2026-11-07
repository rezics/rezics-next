/** Wall-clock milliseconds for retry admission and absolute deadlines. */
export type SettingsClock = () => number;

/** Fresh command and query identities. Callers keep the returned original. */
export type SettingsId = () => string;

export type SettingsTimerHandle = Readonly<{ cancel: () => void }>;

/** Presentation and request timers. Expiry never starts IO. */
export type SettingsTimer = Readonly<{
  schedule(callback: () => void, delayMs: number): SettingsTimerHandle;
}>;

/** Clock, identifier and timer for Settings recovery. Composition supplies the adapter. */
export type SettingsAmbient = Readonly<{
  now: SettingsClock;
  id: SettingsId;
  timer: SettingsTimer;
}>;

/** Retry-After is either delay-seconds or an HTTP date; an invalid header supplies no delay. */
export function preferenceRetryDeadline(retryAfter: string | undefined, now: number): number {
  if (!retryAfter) return 0;
  const value = retryAfter.trim();
  if (!/^\d+$/.test(value) && !/ GMT$/.test(value)) return 0;
  const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(deadline) && deadline > now ? deadline : 0;
}
