import { QueryClientContext } from '@tanstack/react-query';
import { useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addressLease } from '../../../../reader/lease';
import { browserObservation } from '../../../../session/observation';

const noSubscribe = () => () => {};
const anonymousSnapshot = () => 'unobserved';

/** Local ownership of one Organization region, using the installed browser observation store. */
export function useOrganizationEpisode(
  source: object,
  descriptor: string,
  viewer: string | null,
  cacheSource: object = source,
) {
  const client = useContext(QueryClientContext);
  const store = client ? browserObservation(client) : undefined;
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getSnapshot ?? (() => undefined),
    store?.getServerSnapshot ?? (() => undefined),
  );
  const session = store?.getSnapshot();
  const cacheSnapshot = useCallback(() => {
    if (!client) return anonymousSnapshot();
    const stamp = (key: readonly unknown[]) => {
      const state = client.getQueryState(key);
      return [state?.status, state?.fetchStatus, state?.isInvalidated, state?.dataUpdateCount, state?.errorUpdateCount];
    };
    return JSON.stringify([
      stamp(['session']),
      client
        .getQueryCache()
        .findAll({
          predicate: (query) => {
            const data: unknown = query.state.data;
            return (
              data === cacheSource ||
              (typeof data === 'object' && data !== null && 'page' in data && data.page === cacheSource)
            );
          },
        })
        .map((query) => [query.queryHash, stamp(query.queryKey)]),
      stamp(['exposure', 'viewer']),
      client
        .getQueryCache()
        .findAll({ queryKey: ['exposure', 'viewer'] })
        .map((query) => [query.queryHash, stamp(query.queryKey)]),
    ]);
  }, [client, session, cacheSource]);
  useSyncExternalStore(store?.subscribeCache ?? noSubscribe, cacheSnapshot, cacheSnapshot);
  // A replaced address binds the current getter, not the previous render's subscription snapshot.
  const cache = cacheSnapshot();
  const ready =
    !client || viewer === null || (session?.state === 'signed-in' && session.observation.subject === viewer);
  const holder = useRef<ReturnType<typeof createEpisode> | undefined>(undefined);
  const next = useRef(0);
  const [, renderRetirement] = useState(0);
  if (!holder.current || holder.current.source !== source) {
    holder.current?.retire();
    holder.current = createEpisode(source, descriptor, viewer, cache, ++next.current);
  }
  const episode = holder.current;
  if (episode.descriptor !== descriptor || episode.viewer !== viewer || episode.cache !== cache) episode.retire();
  if (episode.admitted && (!ready || episode.session !== session)) episode.retire();
  if (ready && !episode.admitted && !episode.retired) {
    episode.admitted = true;
    episode.session = session;
  }
  episode.owns = () =>
    holder.current === episode &&
    cacheSnapshot() === episode.cache &&
    (!episode.admitted || !store || store.getSnapshot() === episode.session);
  useLayoutEffect(() => {
    episode.active = true;
    const depart = () => {
      episode.retire();
      renderRetirement((value) => value + 1);
    };
    window.addEventListener('pagehide', depart);
    return () => {
      window.removeEventListener('pagehide', depart);
      episode.active = false;
      // Effect replay is permitted; a departed address is terminal.
      queueMicrotask(() => {
        if (!episode.active) episode.retire();
      });
    };
  }, [episode]);
  return { episode, available: !episode.retired && ready, current: episode.current };
}

function createEpisode(source: object, descriptor: string, viewer: string | null, cache: string, key: number) {
  const abort = new AbortController();
  const lease = addressLease(() => episode.active && !episode.retired && episode.owns());
  const episode = {
    source,
    descriptor,
    viewer,
    cache,
    key,
    admitted: false,
    session: undefined as ReturnType<ReturnType<typeof browserObservation>['getSnapshot']> | undefined,
    retired: false,
    active: false,
    owns: () => true,
    signal: abort.signal,
    current: () => lease.current(),
    retire: () => {
      episode.retired = true;
      lease.retire();
      abort.abort();
    },
  };
  return episode;
}
export type OrganizationEpisode = ReturnType<typeof createEpisode>;
