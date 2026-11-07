import type { QueryClient } from '@tanstack/react-query';
import { browserObservation } from './observation';
import { normalizeSessionObservation, sessionQueryKey, type BrowserSession } from './contract';

export type ReaderSessionSource = {
  read: () => BrowserSession | undefined;
  snapshot: () => number;
  serverSnapshot: () => 0;
  subscribe: (notify: () => void) => () => void;
};

const absent: ReaderSessionSource = {
  read: () => undefined,
  snapshot: () => 0,
  serverSnapshot: () => 0,
  subscribe: () => () => {},
};
const sources = new WeakMap<QueryClient, ReaderSessionSource>();

/** A read-only view of the existing cache; every successful replacement advances its revision. */
export function readerSessionSource(client: QueryClient | undefined): ReaderSessionSource {
  if (!client) return absent;
  const existing = sources.get(client);
  if (existing) return existing;
  let revision = 0;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const source: ReaderSessionSource = {
    read() {
      const state = client.getQueryState(sessionQueryKey);
      return state?.status === 'success' && state.fetchStatus === 'idle' && !state.isInvalidated
        ? normalizeSessionObservation(state.data)
        : undefined;
    },
    snapshot: () => revision,
    serverSnapshot: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      stop ??= browserObservation(client).subscribeCache((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== sessionQueryKey[0]) return;
        if (
          event.type !== 'removed' &&
          !(
            event.type === 'updated' &&
            ['success', 'error', 'invalidate', 'fetch', 'setState'].includes(event.action.type)
          )
        )
          return;
        revision += 1;
        for (const notify of [...listeners]) notify();
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
