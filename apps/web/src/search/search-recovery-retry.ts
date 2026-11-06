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
  // SSR and the first hydrated render must agree even if the delay expired
  // while the document and its scripts were travelling to the reader.
  const [now, setNow] = useState<number>();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const current = Date.now();
      setNow(current);
      if (retryAt !== undefined && retryAt > current)
        timer = setTimeout(settle, Math.min(retryAt - current, 2_147_483_647));
    };
    settle();
    return () => clearTimeout(timer);
  }, [retryAt]);
  return retryAt !== undefined && (now === undefined || retryAt > now);
}
