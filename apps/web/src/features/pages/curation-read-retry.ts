import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { searchRetryAt, useSearchRetryWait } from '../../search/search-recovery-retry';

export type CurationReadRetryOwner = { reader: string; generation: number };

export type CurationReadWait = {
  owner: CurationReadRetryOwner;
  retryAt: number;
  retired: boolean;
};

/** Reuse Search's Retry-After parser for the already-decoded native delay in seconds. */
export function curationReadRetryAt(retryAfter: number | undefined, now = Date.now()): number | undefined {
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter < 0) return;
  return searchRetryAt(String(Math.ceil(retryAfter)), now);
}

export function isCurrentCurationReadWait(
  wait: CurationReadWait | null,
  owner: CurationReadRetryOwner,
): wait is CurationReadWait {
  return !!wait && !wait.retired && wait.owner.reader === owner.reader && wait.owner.generation === owner.generation;
}

export function canDispatchCurationRead(
  wait: CurationReadWait | null,
  owner: CurationReadRetryOwner,
  now = Date.now(),
): boolean {
  return !isCurrentCurationReadWait(wait, owner) || wait.retryAt <= now;
}

export function retireCurationReadWait(wait: CurationReadWait | null): void {
  if (wait) wait.retired = true;
}

export function waitAfterCurationRead(
  previous: CurationReadWait | null,
  owner: CurationReadRetryOwner,
  result: { reason: string; retryAfter?: number },
  now = Date.now(),
): CurationReadWait | null {
  retireCurationReadWait(previous);
  if (result.reason !== 'rate-limited') return null;
  const retryAt = curationReadRetryAt(result.retryAfter, now);
  if (retryAt === undefined) return null;
  return { owner, retryAt, retired: false };
}

export function useCurationReadWait(owner: CurationReadRetryOwner | null): {
  waitRef: MutableRefObject<CurationReadWait | null>;
  waiting: boolean;
  replaceWait: (wait: CurationReadWait | null) => void;
} {
  const [wait, setWait] = useState<CurationReadWait | null>(null);
  const waitRef = useRef(wait);
  waitRef.current = wait;
  const current = owner && isCurrentCurationReadWait(wait, owner) ? wait : null;
  const waiting = useSearchRetryWait(current?.retryAt);
  useEffect(
    () => () => {
      retireCurationReadWait(waitRef.current);
    },
    [owner?.reader, owner?.generation],
  );
  return {
    waitRef,
    waiting,
    replaceWait(next) {
      waitRef.current = next;
      setWait(next);
    },
  };
}
