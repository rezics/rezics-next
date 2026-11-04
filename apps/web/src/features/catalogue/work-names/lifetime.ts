import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useRef, useSyncExternalStore } from 'react';
import { browserObservation, type BrowserObservationSnapshot } from '../../../session/observation';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';

const unknown: BrowserObservationSnapshot = { state: 'unknown' };
const unobserved = { subscribe: () => () => {}, getSnapshot: () => unknown, getServerSnapshot: () => unknown };

/** Retire an incarnation permanently, including A-to-B-to-A reuse and caller replacement. */
export function useNamesLifetime(source: object, identity: string, expectedReader?: string | null) {
  const client = useContext(QueryClientContext);
  const store = client ? browserObservation(client) : unobserved;
  const observation = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const seen = useRef(new WeakSet<object>());
  const captured = useRef<{ source: object; identity: string; observation: BrowserObservationSnapshot; retired: boolean; generation: number } | null>(null);
  if (!captured.current || captured.current.source !== source) {
    captured.current = { source, identity, observation, retired: seen.current.has(source), generation: (captured.current?.generation ?? 0) + 1 };
    seen.current.add(source);
  } else {
    if (captured.current.observation.state === 'unknown' && observation.state !== 'unknown' && !captured.current.retired)
      captured.current.observation = observation;
    if (captured.current.observation !== observation || captured.current.identity !== identity) captured.current.retired = true;
  }
  const bound = captured.current;
  if (expectedReader !== undefined && observation.state !== 'unknown' &&
    (observation.state === 'signed-in' ? observation.observation.subject : null) !== expectedReader) bound.retired = true;
  const work = useCatalogueLifetime(JSON.stringify(['supplied-names', identity, bound.generation]));
  const current = () => work.active() && !bound.retired && store.getSnapshot() === bound.observation;
  // Cache incarnation metadata is not a credential and remains stable across route mounts only.
  const session = client?.getQueryState(['session']);
  const caller = session?.status === 'success' && session.fetchStatus === 'idle' && !session.isInvalidated
    ? `${session.dataUpdatedAt}:${session.dataUpdateCount}` : undefined;
  return { observation, current, retired: bound.retired, generation: work.generation, caller };
}
