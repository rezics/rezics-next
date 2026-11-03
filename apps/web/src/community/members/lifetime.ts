import type { QueryClient } from '@tanstack/react-query';
import { normalizeSessionObservation, sessionStateSnapshot, type BrowserSession } from '../../session/browser-state';

/** Observe the browser's existing queries; a member visit never fetches session or exposure itself. */
export function realmMembersLifetimeSource(client: QueryClient) {
  let revision = 0;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const snapshot = () => revision;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    stop ??= client.getQueryCache().subscribe((event) => {
      // Observer bookkeeping changes no authority. Query replacement, invalidation, errors and
      // successful reads do, even when React batches an away/back pair into a single render.
      if (event.type !== 'updated' && event.type !== 'added' && event.type !== 'removed') return;
      const key = event.query.queryKey;
      if (
        !(key.length === 1 && key[0] === 'session') &&
        !(key.length >= 2 && key[0] === 'exposure' && key[1] === 'viewer')
      )
        return;
      revision++;
      for (const notify of listeners) notify();
    });
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        stop?.();
        stop = undefined;
      }
    };
  };

  return {
    snapshot,
    subscribe,
    capture(expected: BrowserSession, localeCurrent: () => boolean) {
      const captured = revision;
      const observation = sessionStateSnapshot(client);
      // Counters distinguish a new successful session observation with identical credentials.
      const updates = observation?.dataUpdateCount;
      const errors = observation?.errorUpdateCount;
      let retired = false;
      return {
        current: () => {
          const state = sessionStateSnapshot(client);
          const session = state?.status === 'success' ? normalizeSessionObservation(state.data) : null;
          if (
            revision !== captured ||
            !localeCurrent() ||
            state?.isInvalidated ||
            state?.dataUpdateCount !== updates ||
            state?.errorUpdateCount !== errors ||
            expected.state !== 'signed-in' ||
            !expected.subject ||
            !expected.csrfToken ||
            session?.state !== 'signed-in' ||
            session.subject !== expected.subject ||
            session.csrfToken !== expected.csrfToken
          )
            retired = true;
          return !retired;
        },
        retire: () => {
          retired = true;
        },
        subscribe,
      };
    },
  };
}
