import { useEffect, useState } from 'react';

/** Native Retry-After is a minimum delay, never a schedule for another request. */
export function searchRetryAt(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return;
  const text = value.trim();
  if (!/^\d+$/.test(text) && !/^[A-Za-z]{3}/.test(text)) return;
  const at = /^\d+$/.test(text) ? now + Number(text) * 1000 : Date.parse(text);
  return Number.isFinite(at) && at <= 8.64e15 ? Math.max(now, at) : undefined;
}

/** Enable a manual action after the native delay, without fetching or polling. */
export function useSearchRetryWait(retryAt?: number): boolean {
  // Server rendering and the first hydration render must agree even if the delay expires in transit.
  // Keep a supplied deadline waiting until the mounted effect samples the current clock.
  const [now, setNow] = useState<number>();
  useEffect(() => {
    if (retryAt === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const current = Date.now();
      setNow(current);
      if (retryAt > current) timer = setTimeout(update, Math.min(retryAt - current, 2_147_483_647));
    };
    update();
    return () => clearTimeout(timer);
  }, [retryAt]);
  return retryAt !== undefined && (now === undefined || retryAt > now);
}
