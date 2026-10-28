import { queryOptions, useQuery } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import type { SessionEnv } from './client';
import { readSessionState, type SessionState } from './state';

const readSession = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store');
  const { state, csrfToken } = await readSessionState(getRequest(), env as Partial<SessionEnv>);
  return { state, csrfToken };
});

// Imperative transports (including image uploads) share the browser query's token.
// This value is never populated during a server render.
let browserCsrfToken: string | null = null;
export function sessionCsrfToken(): string | null {
  return typeof window === 'undefined' ? null : browserCsrfToken;
}

export const sessionQuery = queryOptions({
  ...personalRead,
  queryKey: ['session'],
  queryFn: async () => {
    const session = await readSession();
    browserCsrfToken = session.csrfToken;
    return session;
  },
  // Document sign-in/out starts a fresh client that reads the new session state.
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

const subscribe = () => () => {};
export function useSession(): { state: 'unknown' | SessionState; csrfToken: string | null } {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { data } = useQuery({ ...sessionQuery, enabled: personalRead.enabled && hydrated });
  return hydrated && data ? data : { state: 'unknown', csrfToken: null };
}
