import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { createIsomorphicFn, createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { personalRead } from '../kernel/query';
import type { SessionEnv } from './client';
import {
  normalizeSessionObservation,
  sessionQueryKey,
  sessionStateSnapshot,
  signedOutSession,
  subscribeBrowserSession,
  unknownSession,
  type BrowserSession,
} from './browser-state';
import { readSessionState } from './state';

export { sessionCsrfToken } from './browser-state';

const readSession = createServerFn({ method: 'GET' }).handler(async () => {
  const { env } = await import('cloudflare:workers');
  setResponseHeader('Cache-Control', 'private, no-store');
  const { state, csrfToken, subject } = await readSessionState(getRequest(), env as Partial<SessionEnv>);
  return { state, csrfToken, subject: subject ?? null };
});

export const sessionQuery = queryOptions({
  ...personalRead,
  queryKey: sessionQueryKey,
  queryFn: () => readSession(),
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

/** Read-only registry hosts use an isolated client seeded with an anonymous session. */
export const AnonymousSessionContext = createContext(false);

function useBrowserSession(): BrowserSession {
  const anonymous = useContext(AnonymousSessionContext);
  const client = useQueryClient();
  const read = useCallback(() => client.ensureQueryData(sessionQuery), [client]);
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeBrowserSession(client, listener, personalRead.enabled ? read : undefined, !anonymous),
    [anonymous, client, read],
  );
  const getSnapshot = useCallback(() => (anonymous ? undefined : sessionStateSnapshot(client)), [anonymous, client]);
  const queryState = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  // Anonymous preview clients still perform their isolated session read, but cannot own or lend it.
  if (anonymous) return signedOutSession;
  if (queryState?.status === 'error') return normalizeSessionObservation({ state: 'unavailable' });
  if (!queryState || queryState.status !== 'success') return unknownSession;
  return normalizeSessionObservation(queryState.data);
}

export const useSession = createIsomorphicFn()
  .server((): BrowserSession => ({ state: 'unknown', csrfToken: null }))
  .client(useBrowserSession);
