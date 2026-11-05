import type { QueryClient } from '@tanstack/react-query';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { sessionQuery, useSession } from '../session/query';
import { useAuthoringDeparture } from '../threads/authoring-departure';

type SessionRecord = {
  state: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type RealmClaimCallerSessionSource = {
  readonly id: number;
  read: () => SessionRecord | undefined;
  dataUpdateCount: () => number;
  dataUpdatedAt: () => number;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

const sources = new WeakMap<QueryClient, RealmClaimCallerSessionSource>();
let nextSourceId = 0;

function observeSession(client: QueryClient): RealmClaimCallerSessionSource {
  const read = () => client.getQueryData<SessionRecord>(sessionQuery.queryKey);
  const dataUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const dataUpdatedAt = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
  const identity = () => {
    const value = read();
    return JSON.stringify([
      value?.state ?? 'unknown',
      value?.subject ?? null,
      value?.csrfToken ?? null,
      dataUpdateCount(),
      dataUpdatedAt(),
    ]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    const next = identity();
    if (next === previous) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    id: ++nextSourceId,
    read,
    dataUpdateCount,
    dataUpdatedAt,
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function realmClaimCallerSessionSource(client: QueryClient): RealmClaimCallerSessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

export type RealmClaimCallerLifetime = {
  readonly id: number;
  current: () => boolean;
  ticket: () => number;
  owns: (ticket: number) => boolean;
  retire: () => void;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  connect: () => () => void;
};

/** Departure only retires the visit; native commands may already have applied. */
export function useRealmClaimDeparture(
  lifetime: RealmClaimCallerLifetime,
  control: { getSnapshot: () => { intent: unknown; outcome: string } },
  ready: boolean,
) {
  const unresolved = () => {
    const state = control.getSnapshot();
    return !!state.intent && ['sending', 'uncertain'].includes(state.outcome);
  };
  useAuthoringDeparture(
    () => ready && lifetime.current() && (unresolved() || control.getSnapshot().outcome === 'confirming'),
    unresolved,
    String(lifetime.id),
    undefined,
    lifetime.retire,
    'realm-claim',
  );
}

let nextLifetimeId = 0;

/** A caller visit is bound to one target and one observed session-cache generation. */
export function createRealmClaimCallerLifetime(
  valid: () => boolean,
  watch?: (listener: () => void) => () => void,
): RealmClaimCallerLifetime {
  const id = ++nextLifetimeId;
  let retired = false;
  let connected = true;
  let serial = 0;
  let revision = 0;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    revision++;
    for (const listener of listeners) listener();
  };
  const retire = () => {
    if (retired) return;
    retired = true;
    serial++;
    stopWatching?.();
    stopWatching = undefined;
    publish();
  };
  const snapshot = () => {
    if (!retired && !valid()) retire();
    return revision;
  };
  const current = () => {
    if (!retired && !valid()) retire();
    return connected && !retired;
  };
  return {
    id,
    current,
    ticket: () => serial,
    owns: (ticket) => current() && serial === ticket,
    retire,
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      snapshot();
      return () => listeners.delete(listener);
    },
    connect() {
      connected = true;
      if (!retired && !stopWatching && watch) {
        stopWatching = watch(() => snapshot());
        snapshot();
      }
      return () => {
        if (!connected) return;
        connected = false;
        serial++;
        stopWatching?.();
        stopWatching = undefined;
        // Strict Mode replays effects synchronously. A genuine unmount stays obsolete.
        queueMicrotask(() => {
          if (!connected) retire();
        });
      };
    },
  };
}

const noSubscribe = () => () => {};
const noRevision = () => 0;
const noHydrationSubscribe = () => () => {};
const useClaimLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Shared cache observation and immutable caller admission for the two claim panels. */
export function useRealmClaimCaller(realmId: string, requestId?: string, visitKey?: unknown) {
  const queryClient = useContext(QueryClientContext);
  const session = useSession();
  const hydrated = useSyncExternalStore(
    noHydrationSubscribe,
    () => true,
    () => false,
  );
  const client = queryClient ?? null;
  const source = client ? realmClaimCallerSessionSource(client) : null;
  const revision = useSyncExternalStore(
    source?.subscribe ?? noSubscribe,
    source?.snapshot ?? noRevision,
    source?.snapshot ?? noRevision,
  );
  const cached = source?.read();
  const dataUpdateCount = source?.dataUpdateCount() ?? 0;
  const dataUpdatedAt = source?.dataUpdatedAt() ?? 0;
  const cacheMatches =
    !!cached &&
    cached.state === session.state &&
    (cached.subject ?? null) === (session.subject ?? null) &&
    (cached.csrfToken ?? null) === session.csrfToken;
  const cacheReady =
    !!cached &&
    cached.state === 'signed-in' &&
    typeof cached.subject === 'string' &&
    cached.subject.length > 0 &&
    typeof cached.csrfToken === 'string' &&
    cached.csrfToken.length > 0;
  const hydrationCacheReady = !hydrated && session.state === 'unknown' && cacheReady;
  const callerSession = hydrationCacheReady ? cached! : session;
  const ready =
    !!source &&
    (cacheMatches || hydrationCacheReady) &&
    callerSession.state === 'signed-in' &&
    typeof callerSession.subject === 'string' &&
    callerSession.subject.length > 0 &&
    typeof callerSession.csrfToken === 'string' &&
    callerSession.csrfToken.length > 0;
  const sessionIdentity = JSON.stringify([
    callerSession.state,
    callerSession.subject ?? null,
    callerSession.csrfToken,
    dataUpdateCount,
    dataUpdatedAt,
  ]);
  const lifetime = useMemo(() => {
    const capturedSession = sessionIdentity;
    const capturedRevision = revision;
    const capturedUpdateCount = dataUpdateCount;
    const capturedUpdatedAt = dataUpdatedAt;
    const valid = () => {
      const current = source?.read();
      return (
        !!source &&
        !!client &&
        realmClaimCallerSessionSource(client) === source &&
        ready &&
        source.snapshot() === capturedRevision &&
        source.dataUpdateCount() === capturedUpdateCount &&
        source.dataUpdatedAt() === capturedUpdatedAt &&
        JSON.stringify([
          current?.state ?? 'unknown',
          current?.subject ?? null,
          current?.csrfToken ?? null,
          source.dataUpdateCount(),
          source.dataUpdatedAt(),
        ]) === capturedSession &&
        current?.state === 'signed-in' &&
        typeof current.subject === 'string' &&
        current.subject.length > 0 &&
        typeof current.csrfToken === 'string' &&
        current.csrfToken.length > 0
      );
    };
    return createRealmClaimCallerLifetime(valid, source?.subscribe);
  }, [client, source, realmId, requestId, visitKey, revision, sessionIdentity, dataUpdateCount, dataUpdatedAt, ready]);

  useClaimLayoutEffect(() => lifetime.connect(), [lifetime]);
  const connectionRevision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  return { source, session: callerSession, ready: ready && lifetime.current(), lifetime, connectionRevision, hydrated };
}
