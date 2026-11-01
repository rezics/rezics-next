import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { defaultReader, type Reader } from '../../subject/reader';
import type { AgentReaderResult } from './agent-actions';
import type { AgentReaderQueryKey, AgentReaderQueryScope } from './agent-queries';

export type AgentReaderPath = { kind: 'overview' } | { kind: 'view'; view: string };

type SessionCache = {
  getSnapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  getSession: () => SessionSnapshot | undefined;
  register: (observation: AgentReaderObservation) => () => void;
};

type SessionSnapshot = { state?: unknown; subject?: unknown; csrfToken?: unknown } | undefined;
const sessionCaches = new WeakMap<QueryClient, SessionCache>();
let nextMount = 0;
let nextGeneration = 0;

function sessionCache(client: QueryClient): SessionCache {
  let cache = sessionCaches.get(client);
  if (cache) return cache;

  const getSession = () => {
    const state = client.getQueryState<SessionSnapshot>(['session']);
    if (
      !state ||
      state.status !== 'success' ||
      state.fetchStatus !== 'idle' ||
      state.isInvalidated ||
      !state.data
    )
      return undefined;
    return state.data;
  };
  let revision = 0;
  const listeners = new Set<() => void>();
  const observations = new Set<AgentReaderObservation>();
  client.getQueryCache().subscribe((event) => {
    if (event.query.queryKey.length !== 1 || event.query.queryKey[0] !== 'session') return;
    if (event.type !== 'added' && event.type !== 'removed' && event.type !== 'updated') return;
    revision += 1;
    for (const observation of [...observations]) {
      if (observation.revision !== revision) observation.retire();
    }
    for (const listener of listeners) listener();
  });
  cache = {
    getSnapshot: () => revision,
    getSession,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: (observation) => {
      if (observation.revision !== revision) observation.retire();
      else if (!observation.invalidated()) observations.add(observation);
      return () => observations.delete(observation);
    },
  };
  sessionCaches.set(client, cache);
  return cache;
}

export type AgentReaderObservation = AgentReaderQueryScope & {
  subscribe: (listener: () => void) => () => void;
  version: () => number;
  activate: () => void;
  deactivate: () => void;
  invalidate: (notify: boolean) => void;
  invalidated: () => boolean;
  active: () => boolean;
};

type CurrentObservation = { identity: string; observation: AgentReaderObservation };

function sameQueryKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function removePrivateObservation(client: QueryClient, queryKey: AgentReaderQueryKey): void {
  void client.cancelQueries({ queryKey, exact: true }).finally(() => client.removeQueries({ queryKey, exact: true }));
}

/** The public profile routes share this browser-only private query lifetime. */
export function useAgentReaderScope({
  handle,
  locale,
  path,
  enabled,
}: {
  handle: string;
  locale: string;
  path: AgentReaderPath;
  enabled: boolean;
  session: { state: string; subject?: string | null; csrfToken: string | null };
}): AgentReaderObservation {
  const client = useQueryClient();
  const sessions = sessionCache(client);
  const revision = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot, () => 0);
  const [mount] = useState(() => ++nextMount);
  const cachedSession = sessions.getSession();
  const reader =
    typeof window !== 'undefined' &&
    cachedSession?.state === 'signed-in' &&
    typeof cachedSession.subject === 'string' &&
    cachedSession.subject.length > 0
      ? cachedSession.subject
      : null;
  const route = JSON.stringify([path.kind, path.kind === 'view' ? path.view : null]);
  const admitted = enabled && (path.kind !== 'view' || path.view !== 'realms');
  const identity = JSON.stringify([handle, locale, route, reader, revision, admitted]);
  const current = useRef<CurrentObservation | null>(null);

  if (!current.current || current.current.identity !== identity) {
    current.current?.observation.invalidate(false);
    const generation = ++nextGeneration;
    const queryKey: AgentReaderQueryKey = ['agent-reader', handle, locale, route, reader, revision, mount, generation];
    let observation!: AgentReaderObservation;
    let retired = false;
    let active = true;
    let version = 0;
    const listeners = new Set<() => void>();
    const invalidate = (notify: boolean) => {
      if (retired) return;
      retired = true;
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
      current: () => {
        const liveSession = sessions.getSession();
        return (
          !retired &&
          active &&
          current.current?.observation === observation &&
          sessions.getSnapshot() === revision &&
          typeof window !== 'undefined' &&
          liveSession?.state === 'signed-in' &&
          liveSession.subject === reader &&
          admitted &&
          reader !== null
        );
      },
      retire: () => invalidate(true),
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
      invalidate,
      invalidated: () => retired,
      active: () => active,
    };
    current.current = { identity, observation };
  }

  const observation = current.current.observation;
  const observationVersion = useSyncExternalStore(observation.subscribe, observation.version, observation.version);

  useEffect(() => {
    observation.activate();
    const unregister = sessions.register(observation);
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!sameQueryKey(event.query.queryKey, observation.queryKey)) return;
      if (event.type === 'removed' || (event.type === 'updated' && event.query.state.status === 'error'))
        observation.retire();
    });
    return () => {
      unsubscribe();
      unregister();
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

/** A query failure permanently retires this particular private observation. */
export function useAgentReaderResult(
  observation: AgentReaderObservation,
  result: AgentReaderResult | undefined,
  status: 'pending' | 'error' | 'success',
): Reader {
  useEffect(() => {
    if (status === 'error') observation.retire();
  }, [observation, status]);
  return observation.current() && result?.kind === 'ready' && result.accountId === observation.reader
    ? result.reader
    : defaultReader;
}
