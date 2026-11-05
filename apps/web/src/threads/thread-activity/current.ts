import { QueryClientContext, type QueryKey } from '@tanstack/react-query';
import { useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { addressLease } from '../../reader/lease';
import { browserObservation } from '../../session/observation';
import { sessionQueryKey } from '../../session/browser-state';

/** Activity advice retires on fetching too; the enclosing reader still owns bodies and refresh. */
export function useThreadActivityCurrent(publication: object | undefined, queryKey?: QueryKey) {
  const client = useContext(QueryClientContext);
  const signature = JSON.stringify(queryKey);
  const observation = useMemo(() => {
    const lease = addressLease();
    const shared = client ? browserObservation(client) : undefined;
    const selected = client && queryKey ? client.getQueryCache().find({ queryKey, exact: true }) : undefined;
    const data = selected?.state.data;
    const count = selected?.state.dataUpdateCount;
    let session = shared?.getSnapshot();
    let connected = false;
    const read = () => {
      if (client && queryKey) {
        const actual = client.getQueryCache().find({ queryKey, exact: true });
        if (
          !actual ||
          actual !== selected ||
          actual.state.status !== 'success' ||
          actual.state.fetchStatus !== 'idle' ||
          actual.state.isInvalidated ||
          actual.state.data !== data ||
          actual.state.dataUpdateCount !== count ||
          (connected && shared?.getSnapshot() !== session)
        )
          lease.retire();
      }
      return lease.current();
    };
    return {
      retire: lease.retire,
      read,
      serverRead: () => true,
      subscribe: (notify: () => void) => {
        if (!shared || !queryKey) return () => {};
        const stop = shared.subscribeCache((event) => {
          if (!connected) return;
          const key = JSON.stringify(event.query.queryKey);
          if (key !== signature && key !== JSON.stringify(sessionQueryKey)) return;
          // Signed-out successful replacements have no reader ID, but still retire this visit.
          if (
            key === JSON.stringify(sessionQueryKey) &&
            (event.type === 'removed' ||
              (event.type === 'updated' &&
                ['success', 'error', 'invalidate', 'fetch', 'setState'].includes(event.action.type)))
          )
            lease.retire();
          read();
          notify();
        });
        session = shared.getSnapshot();
        connected = true;
        read();
        return () => {
          connected = false;
          lease.retire();
          stop();
        };
      },
    };
  }, [client, signature, publication]);
  const previous = useRef(observation);
  if (previous.current !== observation) previous.current.retire();
  previous.current = observation;
  return useSyncExternalStore(observation.subscribe, observation.read, observation.serverRead);
}
