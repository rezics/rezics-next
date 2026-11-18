import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
  // The document owner checks the live session when this tab resumes or another Web document opens.
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
});

/** Reconcile the document's installed identity without retiring private work on an unchanged focus read. */
export function watchDocumentSession(client: QueryClient): () => void {
  let pending: AbortController | undefined;
  async function check() {
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    // Let the ordinary route or retry read finish before comparing its cache entry.
    const query = client.getQueryCache().find({ queryKey: sessionQueryKey, exact: true });
    if (query?.state.fetchStatus === 'fetching') await query.promise?.catch(() => {});
    if (controller.signal.aborted) return;
    const before = client.getQueryState(sessionQueryKey);
    const session = await readSession({ signal: controller.signal }).catch(() => ({
      state: 'unavailable' as const,
      subject: null,
      csrfToken: null,
    }));
    if (controller.signal.aborted) return;
    const current = client.getQueryState(sessionQueryKey);
    if (current !== before) {
      // Another session read settled or started during this request. Compare against a fresh read.
      void check();
      return;
    }
    const previous = normalizeSessionObservation(current?.data);
    if (
      current?.status !== 'success' ||
      previous.state !== session.state ||
      previous.subject !== session.subject ||
      previous.csrfToken !== session.csrfToken
    ) {
      client.setQueryData(sessionQueryKey, session);
    }
  }

  const visible = () => {
    if (document.visibilityState === 'visible') void check();
  };
  const restored = (event: PageTransitionEvent) => {
    if (event.persisted) void check();
  };
  // A new document can complete an OAuth replacement while other tabs stay visible.
  // Send only a wake-up. Each recipient reads its own same-origin session.
  const peers = window.BroadcastChannel ? new window.BroadcastChannel('rezics-session') : undefined;
  peers?.addEventListener('message', check);
  peers?.postMessage('check');
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('pageshow', restored);
  return () => {
    pending?.abort();
    peers?.close();
    window.removeEventListener('focus', check);
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('pageshow', restored);
  };
}

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
