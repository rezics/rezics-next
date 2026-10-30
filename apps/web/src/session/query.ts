import { queryOptions, useQuery } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import type { SessionEnv } from './client';
import { readSessionState, type SessionState } from './state';

const readSession = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
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
    if (typeof window !== 'undefined') browserCsrfToken = session.csrfToken;
    return session;
  },
  // Document sign-in/out starts a fresh client that reads the new session state.
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

// Exposure is a separate bounded read so a session result never grants a gate implicitly.
const readViewerExposure = createServerFn({ method: 'GET' }).handler(async () => {
  setResponseHeader('Cache-Control', 'private, no-store');
  const { env } = await import('cloudflare:workers');
  const { prepareSession, viewerCredential } = await import('./request');
  const { readAdmitted } = await import('../kernel/exposure');
  try {
    const request = getRequest();
    await prepareSession(request, env as Partial<SessionEnv>, { refresh: false });
    const authorization = viewerCredential(request);
    return authorization ? await readAdmitted(authorization) : [];
  } catch {
    return [];
  }
});
export const exposureQuery = queryOptions({
  ...personalRead,
  queryKey: ['exposure', 'viewer'],
  queryFn: () => readViewerExposure(),
  staleTime: 60_000,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

const subscribe = () => () => {};
type ClientSession = { state: 'unknown' | SessionState; csrfToken: string | null };

function useBrowserSession(): ClientSession {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const { data } = useQuery({ ...sessionQuery, enabled: personalRead.enabled && hydrated });
  // A guard can seed the server cache, so hydration also initializes imperative transports.
  if (hydrated && data) browserCsrfToken = data.csrfToken;
  return hydrated && data ? data : { state: 'unknown', csrfToken: null };
}

export const useSession = createIsomorphicFn()
  .server((): ClientSession => ({ state: 'unknown', csrfToken: null }))
  .client(useBrowserSession);
