import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../session/query';
import { browserObservation } from '../session/observation';

type InboxSession = { state: string; subject?: string | null };

export type InboxViewer = {
  readonly subject: string;
  readonly epoch: number;
  isCurrent(): boolean;
};

function subject(session: InboxSession | undefined): string | null {
  return session?.state === 'signed-in' && typeof session.subject === 'string' && session.subject.trim()
    ? session.subject
    : null;
}

/** One current identity per query client, shared by the inbox and every badge consumer. */
function createViewerStore(client: QueryClient) {
  let epoch = 0;
  let current: InboxViewer | null = null;
  const listeners = new Set<() => void>();
  let release: (() => void) | undefined;
  const observation = browserObservation(client);
  const publish = () => {
    for (const changed of listeners) changed();
  };
  const disconnect = () => {
    release?.();
    release = undefined;
  };
  const reconcile = () => {
    const query = client.getQueryState<InboxSession>(sessionQuery.queryKey);
    const next = query?.status === 'success' ? subject(query.data) : null;
    if (next !== (current?.subject ?? null)) {
      // Replacing this object permanently retires it, including same-stack loss/recovery.
      current = null;
      if (next) {
        const viewer: InboxViewer = {
          subject: next,
          epoch: ++epoch,
          isCurrent: () => {
            if (current !== viewer) return false;
            reconcile();
            return current === viewer;
          },
        };
        current = viewer;
      }
    }
    if (!current && listeners.size === 0) disconnect();
    return current;
  };
  const connect = () => {
    if (release) return;
    // One cache observation outlives UI subscriptions while an imperative viewer is live.
    // A guard cannot infer an intervening loss from the final retained data alone.
    release = observation.subscribeCache((event) => {
      if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
      reconcile();
      observation.publish(publish);
    });
  };
  return {
    // React render only reads an already installed observation. Imperative callers below
    // explicitly acquire their observation through snapshot(), including without a mounted UI.
    getSnapshot: () => current,
    snapshot: () => {
      connect();
      return reconcile();
    },
    subscribe: (changed: () => void) => {
      listeners.add(changed);
      connect();
      reconcile();
      return () => {
        listeners.delete(changed);
        // StrictMode reconnects in the same stack. A real last unmount disposes the
        // observation and retires its callbacks; a later mount gets a new epoch.
        queueMicrotask(() => {
          if (listeners.size !== 0) return;
          current = null;
          disconnect();
        });
      };
    },
  };
}

const stores = new WeakMap<QueryClient, ReturnType<typeof createViewerStore>>();
export function inboxViewerStore(client: QueryClient) {
  let store = stores.get(client);
  if (!store) {
    store = createViewerStore(client);
    stores.set(client, store);
  }
  return store;
}

export function currentInboxViewer(client: QueryClient): InboxViewer | null {
  return inboxViewerStore(client).snapshot();
}

/** Read current credentials at dispatch, including a refresh before React rerenders. */
export function inboxViewerCsrfToken(client: QueryClient, viewer: InboxViewer): string | null {
  if (!viewer.isCurrent()) return null;
  const query = client.getQueryState<InboxSession & { csrfToken?: string | null }>(sessionQuery.queryKey);
  return query?.status === 'success' && subject(query.data) === viewer.subject ? query.data?.csrfToken || null : null;
}

const serverViewer = () => null;
const serverSessionRead = () => undefined;
export type InboxSessionRead = { status: 'pending' | 'error' | 'success'; fetchStatus: 'fetching' | 'paused' | 'idle' };

/** A failed initial read has no session data, so useSession alone still reports unknown. */
export function inboxEntryState(state: ReturnType<typeof useSession>['state'], read?: InboxSessionRead) {
  if (read?.status === 'error') return 'unavailable';
  if (state === 'signed-out') return 'signed-out';
  if (state === 'unknown') return 'loading';
  return 'unavailable';
}

export function useInboxViewer() {
  const session = useSession();
  const client = useQueryClient();
  const store = inboxViewerStore(client);
  const current = useSyncExternalStore(store.subscribe, store.getSnapshot, serverViewer);
  // Read-only observation: useSession remains the sole owner of the initial browser read.
  const sessionRead = useSyncExternalStore(
    store.subscribe,
    () => client.getQueryState(sessionQuery.queryKey),
    serverSessionRead,
  );
  const viewer = current?.subject === subject(session) ? current : null;
  return { ...session, viewer, sessionRead };
}

/** Guard both dispatch and completion; a CSRF token is never an account identity. */
export async function forInboxViewer<T>(viewer: InboxViewer, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const assertCurrent = () => {
    if (signal?.aborted || !viewer.isCurrent()) throw new DOMException('Inbox viewer changed', 'AbortError');
  };
  assertCurrent();
  try {
    return await read();
  } finally {
    // Failed transports must also lose their old owner's completion authority.
    assertCurrent();
  }
}
