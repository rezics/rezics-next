import type { QueryClient } from '@tanstack/react-query';
import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery, useSession } from '../session/query';
import type { ContainerTarget } from './container-lifecycle';

type SessionRecord = {
  state: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type ContainerLifecycleSessionSource = Readonly<{
  readonly id: number;
  read: () => SessionRecord | undefined;
  dataUpdateCount: () => number;
  dataUpdatedAt: () => number;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
}>;

const sources = new WeakMap<QueryClient, ContainerLifecycleSessionSource>();
let nextSourceId = 0;

function sessionRecord(client: QueryClient) {
  return client.getQueryData<SessionRecord>(sessionQuery.queryKey);
}

function updateCount(client: QueryClient) {
  return client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
}

function updatedAt(client: QueryClient) {
  return client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
}

function sessionCacheIdentity(client: QueryClient) {
  const value = sessionRecord(client);
  return JSON.stringify([
    value?.state ?? 'unknown',
    value?.subject ?? null,
    value?.csrfToken ?? null,
    updateCount(client),
    updatedAt(client),
  ]);
}

function observeSession(client: QueryClient): ContainerLifecycleSessionSource {
  let previous = sessionCacheIdentity(client);
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    const next = sessionCacheIdentity(client);
    if (next === previous) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    id: ++nextSourceId,
    read: () => sessionRecord(client),
    dataUpdateCount: () => updateCount(client),
    dataUpdatedAt: () => updatedAt(client),
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function containerLifecycleSessionSource(client: QueryClient): ContainerLifecycleSessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

export type ContainerLifecycleCallerLifetime = Readonly<{
  readonly id: number;
  current: () => boolean;
  ticket: () => number;
  owns: (ticket: number) => boolean;
  retire: () => void;
  snapshot: () => number;
  subscribe: (listener: () => void) => () => void;
  connect: () => () => void;
}>;

let nextLifetimeId = 0;

/** A mounted caller visit cannot regain authority after its session, target or connection changes. */
export function createContainerLifecycleCallerLifetime(
  valid: () => boolean,
  watch?: (listener: () => void) => () => void,
): ContainerLifecycleCallerLifetime {
  const id = ++nextLifetimeId;
  let retired = false;
  let connected = false;
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
  const current = () => {
    if (retired) return false;
    if (!valid()) {
      retire();
      return false;
    }
    return connected;
  };
  const snapshot = () => {
    if (!retired && !valid()) retire();
    return revision;
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
      if (retired) return () => {};
      connected = true;
      if (!stopWatching && watch) {
        stopWatching = watch(() => snapshot());
        snapshot();
      }
      publish();
      return () => {
        if (!connected) return;
        connected = false;
        serial++;
        stopWatching?.();
        stopWatching = undefined;
        publish();
        // Strict Mode reconnects this committed caller in the same turn; old tickets stay retired.
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
const useCallerLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type RenderBinding = {
  targetKey: string;
  locale: string;
  adapter: unknown;
  inputRevision: number;
  client: QueryClient | null;
  ready: boolean;
  sessionState: string;
  subject: string | null;
  csrfToken: string | null;
};

function targetKey(target: ContainerTarget) {
  return JSON.stringify([target.kind, target.id]);
}

function sessionViewIdentity(binding: RenderBinding) {
  return JSON.stringify([binding.sessionState, binding.subject, binding.csrfToken]);
}

function useConnectionLifetime(
  key: string,
  locale: string,
  adapter: unknown,
  ready: boolean,
  client: QueryClient | null,
  sessionState: string,
  subject: string | null,
  csrfToken: string | null,
  source: ContainerLifecycleSessionSource | null,
  capturedRevision: number,
  capturedUpdateCount: number,
  capturedUpdatedAt: number,
) {
  const bindingRef = useRef<RenderBinding>({
    targetKey: key,
    locale,
    adapter,
    inputRevision: 0,
    client,
    ready,
    sessionState,
    subject,
    csrfToken,
  });
  const prior = bindingRef.current;
  const inputRevision =
    prior.targetKey === key && prior.locale === locale && prior.adapter === adapter
      ? prior.inputRevision
      : prior.inputRevision + 1;
  bindingRef.current = {
    targetKey: key,
    locale,
    adapter,
    inputRevision,
    client,
    ready,
    sessionState,
    subject,
    csrfToken,
  };

  const capturedSession = JSON.stringify([sessionState, subject, csrfToken]);
  const capturedCache = client ? sessionCacheIdentity(client) : '';
  const lifetime = useMemo(() => {
    const valid = () => {
      const binding = bindingRef.current;
      if (
        binding.targetKey !== key ||
        binding.locale !== locale ||
        getLocale() !== locale ||
        binding.adapter !== adapter ||
        binding.inputRevision !== inputRevision ||
        binding.client !== client ||
        !binding.ready ||
        sessionViewIdentity(binding) !== capturedSession
      )
        return false;
      if (!source || !client) return true;
      const cached = source.read();
      return (
        containerLifecycleSessionSource(client) === source &&
        source.snapshot() === capturedRevision &&
        source.dataUpdateCount() === capturedUpdateCount &&
        source.dataUpdatedAt() === capturedUpdatedAt &&
        sessionCacheIdentity(client) === capturedCache &&
        cached?.state === 'signed-in' &&
        typeof cached.subject === 'string' &&
        cached.subject.length > 0 &&
        typeof cached.csrfToken === 'string' &&
        cached.csrfToken.length > 0 &&
        cached.state === sessionState &&
        cached.subject === subject &&
        cached.csrfToken === csrfToken
      );
    };
    return createContainerLifecycleCallerLifetime(valid, source?.subscribe);
  }, [
    key,
    locale,
    adapter,
    inputRevision,
    client,
    ready,
    sessionState,
    subject,
    csrfToken,
    source,
    capturedRevision,
    capturedUpdateCount,
    capturedUpdatedAt,
    capturedSession,
    capturedCache,
  ]);

  useCallerLayoutEffect(() => lifetime.connect(), [lifetime]);
  const connectionRevision = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  return { lifetime, connectionRevision };
}

/** Default browser transport binding includes the real session-cache generation and captured credential. */
export function useDefaultContainerLifecycleCaller(target: ContainerTarget) {
  const contextClient = useContext(QueryClientContext);
  const client = contextClient ?? null;
  const session = useSession();
  const hydrated = useSyncExternalStore(
    noHydrationSubscribe,
    () => true,
    () => false,
  );
  const locale = getLocale();
  const source = client ? containerLifecycleSessionSource(client) : null;
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
  const ready =
    hydrated &&
    !!source &&
    cacheMatches &&
    cached?.state === 'signed-in' &&
    typeof cached.subject === 'string' &&
    cached.subject.length > 0 &&
    typeof cached.csrfToken === 'string' &&
    cached.csrfToken.length > 0;
  const subject = (session.subject ?? null) as string | null;
  const csrfToken = session.csrfToken;
  const { lifetime, connectionRevision } = useConnectionLifetime(
    targetKey(target),
    locale,
    undefined,
    ready,
    client,
    session.state,
    subject,
    csrfToken,
    source,
    revision,
    dataUpdateCount,
    dataUpdatedAt,
  );
  return {
    lifetime,
    connectionRevision,
    ready: ready && lifetime.current(),
    csrfToken: ready ? csrfToken : null,
    locale,
  };
}

/** Injected adapters remain independent of the browser session and keep a target/locale/mount lifetime. */
export function useInjectedContainerLifecycleCaller(target: ContainerTarget, adapter: unknown) {
  const locale = getLocale();
  const { lifetime, connectionRevision } = useConnectionLifetime(
    targetKey(target),
    locale,
    adapter,
    true,
    null,
    'injected',
    null,
    null,
    null,
    0,
    0,
    0,
  );
  return { lifetime, connectionRevision, ready: lifetime.current(), csrfToken: null, locale };
}
