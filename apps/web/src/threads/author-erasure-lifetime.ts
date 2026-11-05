import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../session/query';
import { browserObservation } from '../session/observation';
import { useRouter } from '@tanstack/react-router';
import { useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import type { ErasureEnqueue, ErasureIntent } from './author-erasure';

export type AuthorErasureSession = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken?: string | null;
};

export type AuthorErasureSessionSource = {
  read: () => AuthorErasureSession | undefined;
  snapshot: () => number;
  serverSnapshot: () => 0;
  subscribe: (notify: () => void) => () => void;
};

const sources = new WeakMap<QueryClient, AuthorErasureSessionSource>();
const emptySource: AuthorErasureSessionSource = {
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};

/** One read-only cache observation preserves transitions which React may batch away. */
export function authorErasureSessionSource(client: QueryClient | undefined): AuthorErasureSessionSource {
  if (!client) return emptySource;
  const known = sources.get(client);
  if (known) return known;

  const read = () => {
    const state = client.getQueryState<AuthorErasureSession>(sessionQuery.queryKey);
    return state?.status === 'success' && state.fetchStatus === 'idle' && !state.isInvalidated ? state.data : undefined;
  };
  let revision = 0;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const source: AuthorErasureSessionSource = {
    read,
    snapshot: () => revision,
    serverSnapshot: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      stop ??= browserObservation(client).subscribeCache((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
        if (
          event.type !== 'removed' &&
          !(
            event.type === 'updated' &&
            ['success', 'error', 'invalidate', 'fetch', 'setState'].includes(event.action.type)
          )
        )
          return;
        // Even structurally shared successful data supplies a new authenticated observation.
        revision += 1;
        for (const notify of listeners) notify();
      });
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
  sources.set(client, source);
  return source;
}

export type AuthorErasureBrowserVisit = {
  locale: ReturnType<typeof getLocale>;
  current: () => boolean;
};

/** Observe departure, including away/back before React gets a render. Never intercept navigation. */
export function useAuthorErasureBrowserVisit(scope = ''): AuthorErasureBrowserVisit {
  const router = useRouter({ warn: false });
  const client = useContext(QueryClientContext);
  const visit = useMemo(() => {
    const locale = getLocale();
    const address = typeof window === 'undefined' ? undefined : window.location.href;
    const route = router?.state.location.href;
    let active = true;
    const listeners = new Set<() => void>();
    const retire = () => {
      if (!active) return;
      active = false;
      for (const notify of listeners) notify();
    };
    const current = () => {
      if (getLocale() !== locale || (address !== undefined && window.location.href !== address)) retire();
      return active;
    };
    return {
      locale,
      current,
      retire,
      subscribe(notify: () => void) {
        listeners.add(notify);
        const changed = () => {
          current();
        };
        const stopCache = client && browserObservation(client).subscribeCache(changed);
        const stop = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
          if (toLocation.href !== route) retire();
        });
        if (typeof window !== 'undefined') {
          window.addEventListener('popstate', changed);
          window.addEventListener('hashchange', changed);
          window.addEventListener('pagehide', retire);
        }
        current();
        return () => {
          listeners.delete(notify);
          stop?.();
          stopCache?.();
          if (typeof window !== 'undefined') {
            window.removeEventListener('popstate', changed);
            window.removeEventListener('hashchange', changed);
            window.removeEventListener('pagehide', retire);
          }
        };
      },
    };
  }, [router, client, scope]);
  const previous = useRef(visit);
  if (previous.current !== visit) previous.current.retire();
  previous.current = visit;
  useSyncExternalStore(visit.subscribe, visit.current, () => true);
  return visit;
}

export function authorErasureSessionIsReady(
  session: AuthorErasureSession | undefined,
  subject: string | null | undefined,
): session is AuthorErasureSession & { state: 'signed-in'; subject: string; csrfToken: string } {
  return authorErasureSessionIsAuthenticated(session) && !!subject && session.subject === subject;
}

export function authorErasureSessionIsAuthenticated(
  session: AuthorErasureSession | undefined,
): session is AuthorErasureSession & { state: 'signed-in'; subject: string; csrfToken: string } {
  return (
    session?.state === 'signed-in' &&
    typeof session.subject === 'string' &&
    session.subject.length > 0 &&
    typeof session.csrfToken === 'string' &&
    session.csrfToken.length > 0
  );
}

export type AuthorErasureTransport = (intent: ErasureIntent, csrfToken: string) => Promise<ErasureEnqueue>;

/** The caller's token and liveness check cross every asynchronous transport-loading boundary together. */
export async function dispatchAuthorErasure(
  intent: ErasureIntent,
  csrfToken: string,
  isCurrent: () => boolean,
  loadTransport: () => Promise<AuthorErasureTransport> = async () => {
    const { beginThreadAuthorErasure } = await import('./author-erasure-server');
    return (original, token) => beginThreadAuthorErasure({ data: original, headers: { 'X-CSRF-Token': token } });
  },
): Promise<ErasureEnqueue | undefined> {
  if (!isCurrent()) return undefined;
  const send = await loadTransport();
  if (!isCurrent()) return undefined;
  // Keep the final guard adjacent to the one call which starts the existing server transport.
  if (!isCurrent()) return undefined;
  return send(intent, csrfToken);
}
