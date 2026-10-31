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

/** Never requests IO; only re-enables deliberate controls. A supplied deadline avoids restarting a delay on remount. */
export function usePreferenceRetry(failure: NativePreferenceFailure | undefined, retryAt?: number): boolean {
  const deadline = useMemo(() => retryAt ?? preferenceRetryDeadline(failure?.retryAfter), [failure, retryAt]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (deadline <= now) return;
    const timeout = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [deadline, now]);
  return deadline > now;
}
