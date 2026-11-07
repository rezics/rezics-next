import type { QueryClient } from '@tanstack/react-query';
import type { useSession } from '../session/query';
import { browserObservation } from '../reader/lifetime/index';

/** Observe the existing cache only. Remember transitions even when React batches away/back into one render. */
export function observeReactionSession(client: QueryClient | undefined) {
  // Observe sessionQuery's existing key without importing its server actions into isolated prepared renderers.
  const read = () => client?.getQueryData<ReturnType<typeof useSession>>(['session']);
  const queryState = () => client?.getQueryState(['session']);
  const identity = () => {
    const session = read();
    return JSON.stringify([
      queryState()?.status ?? 'missing',
      session?.state,
      session?.subject ?? null,
      session?.csrfToken ?? null,
    ]);
  };
  let previous = identity();
  let revision = 0;
  const snapshot = () => {
    const next = identity();
    if (next !== previous) {
      previous = next;
      revision++;
    }
    return revision;
  };
  const healthy = () => queryState()?.status === 'success';
  return {
    read,
    snapshot,
    healthy,
    serverSnapshot: () => 0,
    subscribe: (notify: () => void) => {
      if (!client) return () => {};
      const observation = browserObservation(client);
      let active = true;
      const publish = () => {
        if (active) notify();
      };
      const stop = observation.subscribeCache((event) => {
        if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
        if (
          event.type !== 'added' &&
          event.type !== 'removed' &&
          !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
        )
          return;
        const next = identity();
        // Success commits replace this observation, including equal results retained by structural sharing.
        // Fetch starts, invalidations and observer notifications do not replace it.
        if (next === previous && !(event.type === 'updated' && event.action.type === 'success')) return;
        previous = next;
        revision++;
        observation.publish(publish);
      });
      return () => {
        active = false;
        stop();
      };
    },
  };
}
