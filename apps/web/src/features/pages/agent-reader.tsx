import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { addressLease, readLease } from '../../reader/lease';
import { browserObservation } from '../../session/observation';
import { defaultReader, type Reader } from '../../subject/reader';
import type { AgentReaderResult } from './agent-actions';
import type { AgentReaderQueryKey, AgentReaderQueryScope } from './agent-queries';

export type AgentReaderPath = { kind: 'overview' } | { kind: 'view'; view: string };
export type ReaderFailure = 'unavailable' | 'rejected' | 'signed-out' | 'closed' | 'preparing' | 'retired';
let nextMount = 0;
let nextGeneration = 0;

export type AgentReaderObservation = AgentReaderQueryScope & {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  activate: () => void;
  deactivate: () => void;
  invalidate: (notify: boolean) => void;
  invalidated: () => boolean;
  active: () => boolean;
  failure: () => ReaderFailure | undefined;
  retry: () => void;
  canRetry: () => boolean;
};

type CurrentObservation = { identity: string; owner: unknown; observation: AgentReaderObservation };

function removePrivateObservation(client: QueryClient, queryKey: AgentReaderQueryKey): void {
  void client.cancelQueries({ queryKey, exact: true }).finally(() => client.removeQueries({ queryKey, exact: true }));
}

/** One mounted public route consumes the shared session authority, never its own session subscription. */
export function useAgentReaderScope({
  handle,
  locale,
  path,
  enabled,
  owner,
}: {
  handle: string;
  locale: string;
  path: AgentReaderPath;
  enabled: boolean;
  owner?: unknown;
  session: { state: string; subject?: string | null; csrfToken: string | null };
}): AgentReaderObservation {
  const client = useQueryClient();
  const sessions = browserObservation(client);
  const snapshot = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, sessions.getServerSnapshot);
  const [mount] = useState(() => ++nextMount);
  const [activation, setActivation] = useState(0);
  const reader = typeof window !== 'undefined' && snapshot.state === 'signed-in' ? snapshot.observation.subject : null;
  const revision = snapshot.state === 'signed-in' ? snapshot.observation.id : 0;
  const route = JSON.stringify([path.kind, path.kind === 'view' ? path.view : null]);
  const admitted = enabled && (path.kind !== 'view' || path.view !== 'realms');
  const identity = JSON.stringify([handle, locale, route, reader, revision, admitted, activation]);
  const current = useRef<CurrentObservation | null>(null);

  if (!current.current || current.current.identity !== identity || current.current.owner !== owner) {
    current.current?.observation.invalidate(false);
    const generation = ++nextGeneration;
    const queryKey: AgentReaderQueryKey = ['agent-reader', handle, locale, route, reader, revision, mount, generation];
    let observation!: AgentReaderObservation;
    let retired = false;
    let active = true;
    let version = 0;
    let failure: ReaderFailure | undefined;
    let response: AgentReaderResult | undefined;
    const listeners = new Set<() => void>();
    const ownsRoute = () =>
      active &&
      current.current?.observation === observation &&
      sessions.getSnapshot() === snapshot &&
      admitted &&
      !!reader;
    // Active effect replay is separate from permanent address retirement.
    const address = addressLease(
      () => current.current?.observation === observation && sessions.getSnapshot() === snapshot && admitted,
    );
    const read = readLease(reader ?? '', address, () => !retired);
    const retire = (notify: boolean, reason: ReaderFailure = 'retired') => {
      if (retired) return;
      retired = true;
      failure = reason;
      response = undefined;
      address.retire();
      version += 1;
      if (notify) for (const listener of listeners) listener();
    };
    observation = {
      reader,
      route,
      revision,
      mount,
      generation,
      enabled: admitted && reader !== null,
      queryKey,
      current: () => active && typeof window !== 'undefined' && read.current(),
      retire: (reason) => retire(true, reason),
      accept: (result) => {
        if (observation.current()) response = result;
      },
      accepts: (result) => observation.current() && response === result,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      version: () => version,
      activate: () => {
        if (!retired) active = true;
      },
      deactivate: () => {
        active = false;
      },
      invalidate: (notify) => retire(notify),
      invalidated: () => retired,
      active: () => active,
      failure: () => failure,
      canRetry: ownsRoute,
      retry: () => {
        if (!ownsRoute()) return;
        retire(true);
        // A new scope acquires a new lease and query. No retired lease is reactivated.
        setActivation((value) => value + 1);
      },
    };
    current.current = { identity, owner, observation };
  }

  const observation = current.current.observation;
  const observationVersion = useSyncExternalStore(observation.subscribe, observation.version, observation.version);

  useEffect(() => {
    observation.activate();
    const unsubscribe = sessions.subscribeCache(() => {
      if (!observation.current()) {
        if (observation.enabled && !observation.invalidated()) observation.retire();
        return;
      }
      const query = client.getQueryState<AgentReaderResult>(observation.queryKey);
      if (!query) {
        observation.retire();
      } else if (query.status === 'error') {
        observation.retire('unavailable');
      } else if (
        query.isInvalidated ||
        (query.status === 'success' && (query.fetchStatus !== 'idle' || !observation.accepts(query.data)))
      ) {
        observation.retire();
      }
    });
    return () => {
      unsubscribe();
      observation.deactivate();
      queueMicrotask(() => {
        if (observation.active()) return;
        observation.retire();
        removePrivateObservation(client, observation.queryKey);
      });
    };
  }, [client, observation, sessions]);

  useEffect(() => {
    if (observationVersion > 0 || observation.invalidated()) removePrivateObservation(client, observation.queryKey);
  }, [client, observation, observationVersion]);

  return observation;
}

/** Only this episode's admitted native response supplies private presentation. */
export function useAgentReaderResult(
  observation: AgentReaderObservation,
  result: AgentReaderResult | undefined,
  status: 'pending' | 'error' | 'success',
): Reader {
  useEffect(() => {
    if (status === 'error') observation.retire('unavailable');
  }, [observation, status]);
  return observation.accepts(result) && result?.kind === 'ready' && result.accountId === observation.reader
    ? result.reader
    : defaultReader;
}
