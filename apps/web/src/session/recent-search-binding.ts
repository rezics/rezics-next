import { createElement, useContext, useMemo, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { personalRead } from '../kernel/query';
import {
  normalizeSessionObservation,
  sessionQueryKey,
  sessionStateSnapshot,
  subscribeBrowserSession,
  unknownSession,
} from './browser-state';
import { AnonymousSessionContext, sessionCsrfToken, sessionQuery } from './query';
import {
  RecentSearchHostBoundary,
  recentSearchSessionKey,
  type RecentSearchHost,
  type RecentSearchTransport,
  type RecentSessionView,
} from '../search/recent-host';

const unknownIncarnation = {};
const serverView: RecentSessionView = {
  state: 'unknown',
  subject: null,
  csrfToken: null,
  anonymous: false,
  incarnation: unknownIncarnation,
  sessionKey: null,
};

/** Installed native Recent transport: BFF session preparation and CSRF stay at dispatch. */
export function createRecentNativeTransport(): RecentSearchTransport {
  return {
    async read(cursor, signal) {
      const { readRecent } = await import('../search/recent');
      signal.throwIfAborted();
      return readRecent({ data: cursor, signal });
    },
    async write(input, signal) {
      const { writeRecent } = await import('../search/recent');
      signal.throwIfAborted();
      return writeRecent({ data: input, signal, headers: { 'X-CSRF-Token': sessionCsrfToken() ?? '' } });
    },
  };
}

/** Real session observer, storage events, clock and native transport for one QueryClient owner. */
export function createRecentSearchHost(input: {
  client: QueryClient;
  anonymous: boolean;
  ensureSession?: () => Promise<unknown>;
  transport?: RecentSearchTransport;
}): RecentSearchHost {
  let signature: readonly unknown[] = [];
  let snapshot: RecentSessionView = serverView;
  const transport = input.transport ?? createRecentNativeTransport();
  const derive = (): RecentSessionView => {
    if (input.anonymous) {
      return {
        state: 'signed-out',
        subject: null,
        csrfToken: null,
        anonymous: true,
        incarnation: unknownIncarnation,
        sessionKey: recentSearchSessionKey({ state: 'signed-out', csrfToken: null }),
      };
    }
    const state = sessionStateSnapshot(input.client);
    const data = state?.status === 'success' ? normalizeSessionObservation(state.data) : unknownSession;
    return {
      state: data.state,
      subject: data.subject ?? null,
      csrfToken: data.csrfToken,
      anonymous: false,
      incarnation: state ?? unknownIncarnation,
      sessionKey: recentSearchSessionKey(data),
    };
  };
  const readSession = (): RecentSessionView => {
    const state = input.anonymous ? undefined : sessionStateSnapshot(input.client);
    const next = [input.anonymous, state, state?.status, state?.dataUpdateCount, state?.data];
    if (next.some((value, index) => value !== signature[index])) {
      signature = next;
      snapshot = derive();
    }
    return snapshot;
  };
  return {
    readSession,
    observeSession(notify) {
      return subscribeBrowserSession(input.client, notify, input.ensureSession, !input.anonymous);
    },
    observeRetirement(retire) {
      let key = readSession().sessionKey;
      return input.client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQueryKey[0]) return;
        const next = readSession().sessionKey;
        if (key === next) return;
        key = next;
        retire();
      });
    },
    observeStorage(listener) {
      if (typeof window === 'undefined') return () => {};
      const wrapped = (event: StorageEvent) => listener(event);
      window.addEventListener('storage', wrapped);
      return () => window.removeEventListener('storage', wrapped);
    },
    now: () => Date.now(),
    createId: () => crypto.randomUUID(),
    transport,
  };
}

export function RecentSearchBinding({
  children,
  transport,
}: {
  children: ReactNode;
  transport?: RecentSearchTransport;
}) {
  const client = useQueryClient();
  const anonymous = useContext(AnonymousSessionContext);
  const host = useMemo(() => {
    const ensureSession = !anonymous && personalRead.enabled ? () => client.ensureQueryData(sessionQuery) : undefined;
    return createRecentSearchHost({
      client,
      anonymous,
      ...(ensureSession ? { ensureSession } : {}),
      ...(transport ? { transport } : {}),
    });
  }, [anonymous, client, transport]);
  return createElement(RecentSearchHostBoundary, { host, children });
}

export { recentSearchSessionKey };
