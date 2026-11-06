import { useEffect, useState } from 'react';

/** Native Retry-After is a minimum delay, never a schedule for another request. */
export function searchRetryAt(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^[A-Za-z]{3}/.test(text)) return;
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at <= 8.64e15 ? Math.max(now, at) : undefined;
}

/** Train conflict resolution keeps the later deadline so a narrowed increment cannot schedule an earlier retry. */
export function narrowSearchRetryAt(existing: number | undefined, incoming: number | undefined): number | undefined {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  return Math.max(existing, incoming);
}

/** Enable a manual action after the native delay, without fetching or polling. */
export function useSearchRetryWait(retryAt?: number): boolean {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (retryAt === undefined || retryAt <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(retryAt - Date.now(), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [retryAt, now]);
  return retryAt !== undefined && retryAt > Math.max(now, Date.now());
}
