import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useSession } from '../session/query';
import { addressLease, browserObservation } from '../session';

export type CandidateWork = { reader: string; live: () => boolean };
type Lifetime = CandidateWork & { generation: number; retire: () => void; active: () => boolean };
export type CandidateSessionLease = {
  reader: string;
  current: () => boolean;
  subscribe: (listener: () => void) => () => void;
};
let nextGeneration = 0;
const Reader = createContext<Lifetime | null>(null);

/** A browser observation fences work; only the prepared server request authenticates it. */
function useLifetime(identity: string, reader: string, parent?: CandidateWork | null): Lifetime {
  const mounted = useRef(true);
  const previous = useRef<{ identity: string; parent: CandidateWork | null | undefined; value: Lifetime } | null>(null);
  if (!previous.current || previous.current.identity !== identity || previous.current.parent !== parent) {
    const generation = ++nextGeneration;
    previous.current?.value.retire();
    const lease = addressLease(
      () => !parent || ('active' in parent && typeof parent.active === 'function' ? parent.active() : parent.live()),
    );
    const value: Lifetime = {
      reader,
      generation,
      retire: lease.retire,
      active: () => mounted.current && lease.current(),
      live: () => !!reader && value.active(),
    };
    previous.current = { identity, parent, value };
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return previous.current.value;
}

export function CandidateReaderBoundary({
  observed,
  address,
  children,
  admission,
}: {
  observed: ReturnType<typeof useSession>;
  address: string;
  children: ReactNode;
  admission?: CandidateWork;
}) {
  const reader = observed.state === 'signed-in' ? (observed.subject ?? '') : '';
  const lifetime = useLifetime(
    JSON.stringify([observed.state, reader, observed.csrfToken, address]),
    reader,
    admission,
  );
  return (
    <Reader.Provider value={lifetime}>
      <CandidateMount key={lifetime.generation}>{children}</CandidateMount>
    </Reader.Provider>
  );
}

function CandidateMount({ children }: { children: ReactNode }) {
  return children;
}

/** Install the existing session observation once above every production candidate caller. */
export function candidateSession<Props extends object>(Component: ComponentType<Props>) {
  return function CandidateSession(props: Props) {
    const observed = useSession();
    const client = useQueryClient();
    const store = browserObservation(client);
    const revision = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
    const admission = useMemo(
      () => ({ reader: observed.subject ?? '', live: () => store.getSnapshot() === revision }),
      [store, revision, observed.subject],
    );
    return (
      <CandidateReaderBoundary
        admission={admission}
        observed={observed}
        address={JSON.stringify([
          Reflect.get(props, 'id'),
          Reflect.get(props, 'work'),
          Reflect.get(props, 'locale'),
          Reflect.get(props, 'realm'),
          Reflect.get(props, 'context'),
          Reflect.get(props, 'address'),
        ])}
      >
        <Component {...props} />
      </CandidateReaderBoundary>
    );
  };
}

/** Fixtures may name their reader explicitly; missing production admission always refuses. */
export function useCandidateWork(address: string, fixtureReader?: string) {
  const parent = useContext(Reader);
  const reader = parent?.reader ?? fixtureReader ?? '';
  return useLifetime(JSON.stringify([address, reader]), reader, parent);
}

/** A route-return lease subscribes through the common observation, never a second cache listener. */
export function captureCandidateSession(client: QueryClient, reader: string): CandidateSessionLease {
  const store = browserObservation(client);
  const snapshot = store.getSnapshot();
  return {
    reader,
    current: () =>
      !!reader &&
      snapshot.state === 'signed-in' &&
      snapshot.observation.subject === reader &&
      store.getSnapshot() === snapshot,
    subscribe: store.subscribe,
  };
}

/** Public reads still retire with their mount/admission, without requiring sign-in. */
export function useCatalogueLifetime(address: string, ancestor?: Lifetime | null) {
  const reader = useContext(Reader);
  const parent = ancestor ?? reader;
  return useLifetime(JSON.stringify([address, reader?.generation]), reader?.reader ?? parent?.reader ?? '', parent);
}
