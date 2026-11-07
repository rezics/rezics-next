import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  createElement,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { addressLease, browserObservation } from '../session';
import { useSession } from '../session/query';
import { sessionQueryKey } from '../session/browser-state';
import {
  PageVisitHostProvider,
  type CandidateSessionLease,
  type PageVisitHost,
} from '../features/pages/visit-host-port';

function createWebPageVisitHost(client: QueryClient): PageVisitHost {
  const store = browserObservation(client);

  function useBrowserObservation() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
    return useMemo(
      () => ({
        reader: snapshot.state === 'signed-in' ? snapshot.observation.subject : '',
        generation: snapshot.state === 'signed-in' ? snapshot.observation.id : 0,
        current: () => store.getSnapshot() === snapshot,
      }),
      [snapshot],
    );
  }

  function captureBrowserObservation() {
    const snapshot = store.getSnapshot();
    const sessionState = client.getQueryState(sessionQueryKey);
    return {
      reader: snapshot.state === 'signed-in' ? snapshot.observation.subject : '',
      generation: snapshot.state === 'signed-in' ? snapshot.observation.id : 0,
      current: () => store.getSnapshot() === snapshot && client.getQueryState(sessionQueryKey) === sessionState,
    };
  }

  function useExposureObservation() {
    const queries = useRef(new WeakMap<object, number>());
    const nextQuery = useRef(0);
    const identity = useCallback((query: object) => {
      let value = queries.current.get(query);
      if (value === undefined) {
        value = ++nextQuery.current;
        queries.current.set(query, value);
      }
      return value;
    }, []);
    const snapshot = useCallback(
      () =>
        JSON.stringify(
          client
            .getQueryCache()
            .findAll({ queryKey: ['exposure', 'viewer'] })
            .map((query) => [
              identity(query),
              query.queryHash,
              query.state.status,
              query.state.fetchStatus,
              query.state.isInvalidated,
              query.state.dataUpdateCount,
              query.state.errorUpdateCount,
            ]),
        ),
      [client, identity],
    );
    const revision = useSyncExternalStore(store.subscribeCache, snapshot, snapshot);
    return useMemo(() => ({ revision, current: () => snapshot() === revision }), [revision, snapshot]);
  }

  return {
    useSessionObservation: () => useSession(),
    useBrowserObservation,
    captureBrowserObservation,
    useExposureObservation,
    createAddressLease: addressLease,
  };
}

/** Isolated legacy fixtures may exercise the page lifetime without a browser QueryClient. */
const fixtureHost: PageVisitHost = {
  useSessionObservation: () => ({ state: 'unknown' }),
  useBrowserObservation: () => ({ reader: '', generation: 0, current: () => true }),
  captureBrowserObservation: () => ({ reader: '', generation: 0, current: () => true }),
  useExposureObservation: () => ({ revision: '', current: () => true }),
  createAddressLease: addressLease,
};

/** The Web composition root installs its browser capabilities for page-owned visit applications. */
export function PageVisitBinding({ children }: { children: ReactNode }) {
  const client = useContext(QueryClientContext);
  const host = useMemo(() => (client ? createWebPageVisitHost(client) : fixtureHost), [client]);
  return createElement(PageVisitHostProvider, { host, children });
}

/** Compatibility wrapper for older Web readers and focused component fixtures. */
export function withPageVisitHost<Props extends object>(Component: ComponentType<Props>) {
  return function BoundPageVisit(props: Props) {
    return createElement(PageVisitBinding, { children: createElement(Component, props) });
  };
}

/** A route-return lease shares the browser's current observation and does not subscribe twice. */
export function captureCandidateSession(client: QueryClient, reader: string): CandidateSessionLease {
  const store = browserObservation(client);
  const snapshot = store.getSnapshot();
  return {
    reader,
    generation: snapshot.state === 'signed-in' ? snapshot.observation.id : 0,
    current: () =>
      !!reader &&
      snapshot.state === 'signed-in' &&
      snapshot.observation.subject === reader &&
      store.getSnapshot() === snapshot,
    subscribe: store.subscribe,
  };
}
