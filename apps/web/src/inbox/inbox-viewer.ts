import { useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sessionQuery, useSession } from '../session/query';

type InboxSession = { state: string; subject?: string | null };

export type InboxViewer = {
  readonly subject: string;
  readonly epoch: number;
  isCurrent(): boolean;
};

function subject(session: InboxSession | undefined): string | null {
  return session?.state === 'signed-in' && session.subject ? session.subject : null;
}

/** One current identity per query client, shared by the inbox and every badge consumer. */
function createViewerStore(client: QueryClient) {
  let currentSubject: string | null = null;
  let epoch = 0;
  let current: InboxViewer | null = null;
  const snapshot = (): InboxViewer | null => {
    const next = subject(client.getQueryData<InboxSession>(sessionQuery.queryKey));
    if (next !== currentSubject) {
      currentSubject = next;
      epoch += 1;
      const viewer: InboxViewer | null = next ? { subject: next, epoch, isCurrent: () => snapshot() === viewer } : null;
      current = viewer;
    }
    return current;
  };
  return {
    snapshot,
    subscribe: (changed: () => void) =>
      client.getQueryCache().subscribe((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQuery.queryKey[0]) return;
        // Observe even a loss and recovery that React batches into a single render.
        snapshot();
        changed();
      }),
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

const serverViewer = () => null;
const serverSessionRead = () => undefined;
export type InboxSessionRead = { status: 'pending' | 'error' | 'success'; fetchStatus: 'fetching' | 'paused' | 'idle' };

/** A failed initial read has no session data, so useSession alone still reports unknown. */
export function inboxEntryState(state: ReturnType<typeof useSession>['state'], read?: InboxSessionRead) {
  if (state === 'signed-out') return 'signed-out';
  if (state === 'unknown' && read?.status !== 'error') return 'loading';
  return 'unavailable';
}

export function useInboxViewer() {
  const session = useSession();
  const client = useQueryClient();
  const store = inboxViewerStore(client);
  const current = useSyncExternalStore(store.subscribe, store.snapshot, serverViewer);
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
  const result = await read();
  assertCurrent();
  return result;
}
