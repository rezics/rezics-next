import type { QueryClient } from '@tanstack/react-query';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import type { RealmAppearanceAdapter } from './realm-presentation';

type SessionRecord = {
  state: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type RealmAppearanceCallerSessionSource = {
  readonly id: number;
  read: () => SessionRecord | undefined;
  dataUpdateCount: () => number;
  dataUpdatedAt: () => number;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
};

const sources = new WeakMap<QueryClient, RealmAppearanceCallerSessionSource>();
let nextSourceId = 0;

function observeSession(client: QueryClient): RealmAppearanceCallerSessionSource {
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

export function realmAppearanceCallerSessionSource(client: QueryClient): RealmAppearanceCallerSessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

export type RealmAppearanceCallerLifetime = {
  readonly id: number;
  readonly realmId: string;
  readonly sourceId: number | null;
  readonly revision: number;
  readonly subject: string | null;
  readonly csrfToken: string | null;
  readonly locale: string;
  readonly ready: boolean;
  current: () => boolean;
  ticket: () => number;
  owns: (ticket: number) => boolean;
  retire: () => void;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  connect: () => () => void;
};

let nextLifetimeId = 0;

/** One mounted appearance visit, one Realm, and one exact session-cache generation. */
export function createRealmAppearanceCallerLifetime(input: {
  realmId: string;
  source: RealmAppearanceCallerSessionSource | null;
  client: QueryClient | null;
  revision: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  subject: string | null;
  csrfToken: string | null;
  locale: string;
  ready: boolean;
  adapter: RealmAppearanceAdapter;
  valid: () => boolean;
}): RealmAppearanceCallerLifetime {
  const id = ++nextLifetimeId;
  const { realmId, source, revision, subject, csrfToken, locale, ready, valid } = input;
  let retired = false;
  let connected = true;
  let serial = 0;
  let version = 0;
  let stopWatching: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    version++;
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
    return version;
  };
  const current = () => {
    if (!retired && !valid()) retire();
    return connected && !retired;
  };
  return {
    id,
    realmId,
    sourceId: source?.id ?? null,
    revision,
    subject,
    csrfToken,
    locale,
    ready,
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
      serial++;
      if (!retired && !stopWatching && source) {
        stopWatching = source.subscribe(() => snapshot());
        snapshot();
      }
      return () => {
        if (!connected) return;
        connected = false;
        serial++;
        stopWatching?.();
        stopWatching = undefined;
        // React Strict Mode reconnects synchronously; an actual unmount remains retired.
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
const useAppearanceLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Bind a panel to the source used to read the session and to the adapter that owns its credentials. */
export function useRealmAppearanceCaller(
  realmId: string,
  adapter: RealmAppearanceAdapter,
  session: { state: string; subject?: string | null; csrfToken: string | null },
) {
  const queryClient = useContext(QueryClientContext);
  const hydrated = useSyncExternalStore(
    noHydrationSubscribe,
    () => true,
    () => false,
  );
  const client = queryClient ?? null;
  const source = client ? realmAppearanceCallerSessionSource(client) : null;
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
  const locale = getLocale();
  const cacheIdentity = JSON.stringify([
    cached?.state ?? 'unknown',
    cached?.subject ?? null,
    cached?.csrfToken ?? null,
  ]);
  const sessionIdentity = JSON.stringify([
    callerSession.state,
    callerSession.subject ?? null,
    callerSession.csrfToken,
    dataUpdateCount,
    dataUpdatedAt,
  ]);
  const renderIdentity = useMemo(
    () => ({
      realmId,
      client,
      source,
      revision,
      dataUpdateCount,
      dataUpdatedAt,
      subject: callerSession.subject ?? null,
      locale,
      ready,
      adapter,
    }),
    [realmId, client, source, revision, dataUpdateCount, dataUpdatedAt, callerSession.subject, locale, ready, adapter],
  );
  const currentIdentity = useRef(renderIdentity);
  currentIdentity.current = renderIdentity;
  const lifetime = useMemo(() => {
    const capturedRevision = revision;
    const capturedUpdateCount = dataUpdateCount;
    const capturedUpdatedAt = dataUpdatedAt;
    const capturedSession = sessionIdentity;
    const capturedCache = cacheIdentity;
    const capturedLocale = locale;
    const capturedSubject = callerSession.subject ?? null;
    const valid = () => {
      const current = source?.read();
      return (
        !!client &&
        !!source &&
        realmAppearanceCallerSessionSource(client) === source &&
        currentIdentity.current === renderIdentity &&
        ready &&
        getLocale() === capturedLocale &&
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
        JSON.stringify([current?.state ?? 'unknown', current?.subject ?? null, current?.csrfToken ?? null]) ===
          capturedCache &&
        current?.state === 'signed-in' &&
        current.subject === capturedSubject &&
        typeof current.subject === 'string' &&
        current.subject.length > 0 &&
        typeof current.csrfToken === 'string' &&
        current.csrfToken.length > 0
      );
    };
    return createRealmAppearanceCallerLifetime({
      realmId,
      source,
      client,
      revision,
      dataUpdateCount,
      dataUpdatedAt,
      subject: callerSession.subject ?? null,
      csrfToken: callerSession.csrfToken ?? null,
      locale,
      ready,
      adapter,
      valid,
    });
  }, [
    realmId,
    adapter,
    renderIdentity,
    client,
    source,
    revision,
    sessionIdentity,
    cacheIdentity,
    dataUpdateCount,
    dataUpdatedAt,
    callerSession.subject,
    callerSession.csrfToken,
    locale,
    ready,
  ]);
  useAppearanceLayoutEffect(() => lifetime.connect(), [lifetime]);
  const connectionRevision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  return {
    source,
    session: callerSession,
    ready: ready && lifetime.current(),
    lifetime,
    connectionRevision,
    hydrated,
    cacheRevision: revision,
  };
}
