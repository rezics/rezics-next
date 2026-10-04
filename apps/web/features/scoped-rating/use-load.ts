'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Failure, Outcome } from './types.ts';

export type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'failed'; failure: Failure };
const loading: Load<never> = { state: 'loading' };

/**
 * One read, started when the component mounts or `key` changes and read again on demand. A read that was overtaken
 * by a newer one is dropped, so a slow answer for the last choice never replaces the answer for this one, and what
 * `key` no longer names is never shown. Reading again keeps the old answer on screen until the new one arrives. The
 * read may close over anything `key` names; it is not a dependency itself.
 */
export function useLoad<T>(read: () => Promise<Outcome<T>>, key: string): [Load<T>, () => void] {
  const [state, setState] = useState<{ key: string; load: Load<T> }>({ key, load: loading });
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    let current = true;
    const settle = (load: Load<T>) => { if (current) setState({ key, load }); };
    void latest.current().then(
      answer => settle(answer.ok ? { state: 'ready', data: answer.data } : { state: 'failed', failure: answer.failure }),
      () => settle({ state: 'failed', failure: 'unavailable' }));
    return () => { current = false; };
  }, [key, attempt]);
  return [state.key === key ? state.load : loading, useCallback(() => setAttempt(count => count + 1), [])];
}
