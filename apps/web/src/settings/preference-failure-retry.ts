import { useEffect, useMemo, useState } from 'react';
import type { NativePreferenceFailure } from './preferences';

/** Retry-After is either delay-seconds or an HTTP date; an invalid header supplies no delay. */
export function preferenceRetryDeadline(retryAfter: string | undefined, now = Date.now()): number {
  if (!retryAfter) return 0;
  const value = retryAfter.trim();
  if (!/^\d+$/.test(value) && !/ GMT$/.test(value)) return 0;
  const deadline = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(deadline) && deadline > now ? deadline : 0;
}

/** Only re-enables deliberate retry controls. The timer never makes a request. */
export function usePreferenceRetry(failure: NativePreferenceFailure | undefined): boolean {
  const deadline = useMemo(() => preferenceRetryDeadline(failure?.retryAfter), [failure]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline <= now) return;
    const timeout = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [deadline, now]);
  return deadline > now;
}
