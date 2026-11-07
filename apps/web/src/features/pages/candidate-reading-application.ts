import {
  createContext,
  createElement,
  Fragment,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  usePageVisitHost,
  type CandidateSessionObservation,
  type CandidateWork,
  type CandidateVisit,
} from './visit-host-port';

export { candidateContext, candidateFailure, expectedCandidateReader } from './visit-host-port';
export type { CandidateFailure, CandidateSessionObservation, CandidateWork, CandidateVisit } from './visit-host-port';

export type CandidateReadingAddress = {
  candidate: string;
  locale: string;
  address: unknown;
};

export type CandidateReading = CandidateVisit & {
  candidate: string;
  locale: string;
  identity: string;
};

export type CandidateReadingDecision<Value> =
  | {
      kind: 'accepted';
      candidate: string;
      locale: string;
      identity: string;
      reader: string;
      generation: number;
      value: Value;
    }
  | { kind: 'retired' };

type Lifetime = CandidateVisit;
const Reader = createContext<Lifetime | null>(null);
let nextGeneration = 0;

/** A single stable identity for the candidate, active locale and actual routed address. */
export function candidateReadingIdentity(input: CandidateReadingAddress): string {
  return JSON.stringify([input.candidate, input.locale, input.address]);
}

/** A read or selection is accepted only for the live visit that requested it. */
export function acceptCandidateReading<Value>(
  reading: CandidateReading,
  input: CandidateReadingAddress,
  value: Value,
): CandidateReadingDecision<Value> {
  const identity = candidateReadingIdentity(input);
  if (reading.identity !== identity || !reading.active()) return { kind: 'retired' };
  return {
    kind: 'accepted',
    candidate: reading.candidate,
    locale: reading.locale,
    identity,
    reader: reading.reader,
    generation: reading.generation,
    value,
  };
}

function useLifetime(identity: string, reader: string, parent?: CandidateWork | null): Lifetime {
  const host = usePageVisitHost();
  const mounted = useRef(true);
  const previous = useRef<{ identity: string; parent: CandidateWork | null | undefined; value: Lifetime } | null>(null);
  if (!previous.current || previous.current.identity !== identity || previous.current.parent !== parent) {
    const generation = ++nextGeneration;
    previous.current?.value.retire();
    const lease = host.createAddressLease(
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
  observed: CandidateSessionObservation;
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
  return createElement(
    Reader.Provider,
    { value: lifetime },
    createElement(CandidateMount, { key: lifetime.generation, children }),
  );
}

function CandidateMount({ children }: { children: ReactNode }) {
  return createElement(Fragment, null, children);
}

/** Install the current browser session observation above a candidate-reading consumer. */
export function candidateSession<Props extends object>(Component: ComponentType<Props>) {
  return function CandidateSession(props: Props) {
    const host = usePageVisitHost();
    const observed = host.useSessionObservation();
    const observation = host.useBrowserObservation();
    const address = JSON.stringify([
      Reflect.get(props, 'id'),
      Reflect.get(props, 'work'),
      Reflect.get(props, 'locale'),
      Reflect.get(props, 'realm'),
      Reflect.get(props, 'context'),
      Reflect.get(props, 'address'),
    ]);
    const admission = useMemo(
      () => ({ reader: observed.subject ?? '', live: () => observation.current() }),
      [observation, observed.subject],
    );
    return createElement(CandidateReaderBoundary, {
      admission,
      observed,
      address,
      children: createElement(Component, props),
    });
  };
}

/** Fixtures may name their reader explicitly; missing production admission always refuses. */
export function useCandidateWork(address: string, fixtureReader?: string): CandidateVisit {
  const parent = useContext(Reader);
  const reader = parent?.reader ?? fixtureReader ?? '';
  return useLifetime(JSON.stringify([address, reader]), reader, parent);
}

/** Public reads still retire with their mount/admission, without requiring sign-in. */
export function useCatalogueLifetime(address: string, ancestor?: Lifetime | null): CandidateVisit {
  const reader = useContext(Reader);
  const parent = ancestor ?? reader;
  return useLifetime(JSON.stringify([address, reader?.generation]), reader?.reader ?? parent?.reader ?? '', parent);
}

/** A page observation is bound to the candidate and locale that selected its native address. */
export function useCandidateReading(
  input: CandidateReadingAddress,
  ancestor?: CandidateVisit | null,
): CandidateReading {
  const identity = candidateReadingIdentity(input);
  const visit = useCatalogueLifetime(identity, ancestor);
  return useMemo(
    () => ({ ...visit, candidate: input.candidate, locale: input.locale, identity }),
    [visit, input.candidate, input.locale, identity],
  );
}
