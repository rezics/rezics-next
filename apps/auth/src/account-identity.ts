import { useLayoutEffect, useRef, useState } from 'react';
import { privateAuthRead } from './private-auth-read';
import { readJsonBounded } from './private-auth-json';

// 28 fixed JSON bytes + 36 UUID bytes + 252 escapable UTF-16 units at six
// bytes each + the required one-byte `@` and `.`.
const ACCOUNT_IDENTITY_MAX_BYTES = 1_578;

export type AccountIdentityResult =
  | { kind: 'ready'; accountId: string; email: string | null }
  | { kind: 'signed-out' | 'denied' | 'unavailable' };
export type AccountIdentitySource = (signal: AbortSignal) => Promise<AccountIdentityResult>;
export type AccountIdentityState = AccountIdentityResult | { kind: 'loading' };

/** No account selector, continuation, cache, or mutation authority enters this read. */
export const loadAccountIdentity: AccountIdentitySource = async (signal) => {
  try {
    return await privateAuthRead(async (readSignal): Promise<AccountIdentityResult> => {
      const response = await fetch('/account-identity', {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: readSignal,
      });
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 403) return { kind: 'denied' };
      if (response.status !== 200) return { kind: 'unavailable' };
      const body = await readJsonBounded(response, ACCOUNT_IDENTITY_MAX_BYTES, readSignal);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'unavailable' };
      const value = body as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !== 'account_id,email' ||
        typeof value.account_id !== 'string' ||
        !value.account_id ||
        (value.email !== null &&
          (typeof value.email !== 'string' ||
            value.email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)))
      )
        return { kind: 'unavailable' };
      return { kind: 'ready', accountId: value.account_id, email: value.email };
    }, signal);
  } catch {
    return { kind: 'unavailable' };
  }
};

/** Owns only private display data. The page still owns its original authority and
 * mutation binding. A result must match both that account and that page generation.
 */
export function useAccountIdentity(
  accountId: string,
  generation: number,
  onAuthorityLost: (kind: 'signed-out' | 'denied') => void,
  source: AccountIdentitySource = loadAccountIdentity,
) {
  const [attempt, setAttempt] = useState(0);
  const [bound, setBound] = useState<{
    accountId: string;
    generation: number;
    attempt: number;
    source: AccountIdentitySource;
    result: AccountIdentityResult;
  } | null>(null);
  const authorityLost = useRef(onAuthorityLost);
  useLayoutEffect(() => {
    authorityLost.current = onAuthorityLost;
  });
  useLayoutEffect(() => {
    setBound(null);
    if (!accountId) return;
    let active = true;
    const controller = new AbortController();
    void source(controller.signal)
      .catch((): AccountIdentityResult => ({ kind: 'unavailable' }))
      .then((result) => {
        if (!active) return;
        if (result.kind === 'ready' && result.accountId !== accountId) result = { kind: 'denied' };
        if (result.kind === 'signed-out' || result.kind === 'denied') {
          setBound(null);
          authorityLost.current(result.kind);
          return;
        }
        setBound({ accountId, generation, attempt, source, result });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [accountId, generation, attempt, source]);
  const state: AccountIdentityState =
    accountId &&
    bound?.accountId === accountId &&
    bound.generation === generation &&
    bound.attempt === attempt &&
    bound.source === source
      ? bound.result
      : { kind: 'loading' };
  return { state, retry: () => setAttempt((value) => value + 1) };
}
