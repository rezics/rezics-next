import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { personalRead } from '../../kernel/query';
import { defaultReader, type Reader } from '../../subject/reader';
import type { SubjectOwnRating } from './subject-ratings';
import {
  subjectOwnRatingQuery,
  subjectReaderQuery,
  type SubjectPersonalQueryScope,
  type SubjectPersonalReadTransport,
} from './subject-queries';

type SessionAdmission = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  csrfToken: string | null;
  subject?: string | null;
};

type ScopeState = { observers: number; retirement: number };
type RatingWriteState = {
  revision: number;
  nextId: number;
  sequence: number;
  committedSequence: number;
  committed?: SubjectOwnRating;
  owner: number | null;
  pending: Set<number>;
};

export type SubjectRatingWriteOperation = {
  readonly id: number;
  readonly sequence: number;
  ownsCache(): boolean;
  commit(value: SubjectOwnRating): void;
  rollback(fallback: SubjectOwnRating): SubjectOwnRating | null;
  preserveUncertainty(value: SubjectOwnRating): void;
};

export type SubjectPersonalLease = {
  readonly key: string;
  readonly reader: string;
  readonly subjectId: string;
  readonly locale: string;
  readonly view: string;
  readonly scope: SubjectPersonalQueryScope;
  retire(): void;
  isCurrent(): boolean;
  beginRatingWrite(before: SubjectOwnRating | undefined): SubjectRatingWriteOperation | null;
};

type PersonalScope = {
  scopeKey: string;
  admission: number;
  reader: string;
  subjectId: string;
  locale: string;
  view: string;
  cacheEpoch: number;
  errorEpoch: number;
};

function sessionData(client: QueryClient): SessionAdmission | undefined {
  return client.getQueryData<SessionAdmission>(['session']);
}

function metaString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

class SubjectPersonalReaderRegistry {
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly cacheEpochs = new Map<string, number>();
  private readonly errorEpochs = new Map<string, number>();
  private readonly scopes = new Map<string, ScopeState>();
  private readonly writes = new Map<string, RatingWriteState>();
  private sessionHealthy: boolean;
  private sessionVersion: number;

  constructor(private readonly client: QueryClient) {
    const queryState = client.getQueryState(['session']);
    this.sessionHealthy = queryState?.status === 'success';
    this.sessionVersion = this.sessionHealthy ? 1 : 0;
    client.getQueryCache().subscribe((event) => this.onCacheEvent(event));
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.version;
  getServerSnapshot = () => 0;

  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private onCacheEvent(event: Parameters<ReturnType<QueryClient['getQueryCache']>['subscribe']>[0] extends (
    event: infer T,
  ) => void
    ? T
    : never) {
    const queryKey = event.query.queryKey;
    if (queryKey[0] === 'session') {
      if (event.type === 'removed') {
        this.sessionVersion++;
        this.sessionHealthy = false;
        this.notify();
        return;
      }
      if (event.type === 'updated' && event.action.type === 'error') {
        this.sessionVersion++;
        this.sessionHealthy = false;
        this.notify();
        return;
      }
      if (event.type === 'updated' && event.action.type === 'success') {
        this.sessionVersion++;
        this.sessionHealthy = true;
        this.notify();
        return;
      }
    }

    const meta = event.query.meta as Record<string, unknown> | undefined;
    const scopeKey = metaString(meta?.subjectPersonalScope);
    if (!scopeKey) return;
    const cacheEpoch = typeof meta?.subjectPersonalCacheEpoch === 'number' ? meta.subjectPersonalCacheEpoch : 0;
    if (event.type === 'removed') {
      if (cacheEpoch !== this.getCacheEpoch(scopeKey)) return;
      this.cacheEpochs.set(scopeKey, cacheEpoch + 1);
      this.notify();
      return;
    }
    const errorEpoch = typeof meta?.subjectPersonalErrorEpoch === 'number' ? meta.subjectPersonalErrorEpoch : 0;
    if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      cacheEpoch === this.getCacheEpoch(scopeKey) &&
      errorEpoch === this.getErrorEpoch(scopeKey) &&
      this.hasLiveObserver(scopeKey, cacheEpoch)
    ) {
      this.errorEpochs.set(scopeKey, this.getErrorEpoch(scopeKey) + 1);
      this.notify();
    }
  }

  getAdmission() {
    return this.sessionVersion;
  }

  currentSession(session: SessionAdmission) {
    const state = this.client.getQueryState(['session']);
    const cached = sessionData(this.client);
    const ready =
      this.sessionHealthy &&
      state?.status === 'success' &&
      cached !== undefined &&
      cached.state === session.state &&
      (cached.subject ?? null) === (session.subject ?? null) &&
      cached.csrfToken === session.csrfToken;
    const reader = ready && cached?.state === 'signed-in' && typeof cached.subject === 'string' && cached.subject
      ? cached.subject
      : null;
    return { ready, reader, admission: this.sessionVersion };
  }

  getCacheEpoch(scopeKey: string) {
    return this.cacheEpochs.get(scopeKey) ?? 0;
  }

  getErrorEpoch(scopeKey: string) {
    return this.errorEpochs.get(scopeKey) ?? 0;
  }

  private scope(scopeKey: string) {
    let value = this.scopes.get(scopeKey);
    if (!value) {
      value = { observers: 0, retirement: 0 };
      this.scopes.set(scopeKey, value);
    }
    return value;
  }

  hasLiveObserver(scopeKey: string, cacheEpoch: number) {
    return this.getCacheEpoch(scopeKey) === cacheEpoch && (this.scopes.get(scopeKey)?.observers ?? 0) > 0;
  }

  isQueryCurrent(scope: PersonalScope) {
    const current = sessionData(this.client);
    return (
      this.hasLiveObserver(scope.scopeKey, scope.cacheEpoch) &&
      this.sessionHealthy &&
      this.client.getQueryState(['session'])?.status === 'success' &&
      this.sessionVersion === scope.admission &&
      current?.state === 'signed-in' &&
      current.subject === scope.reader &&
      this.getCacheEpoch(scope.scopeKey) === scope.cacheEpoch &&
      this.getErrorEpoch(scope.scopeKey) === scope.errorEpoch
    );
  }

  isScopeCurrent(scope: PersonalScope, isDesired: () => boolean) {
    return isDesired() && this.isQueryCurrent(scope);
  }

  getWriteRevision(scopeKey: string, cacheEpoch: number) {
    return this.writeState(scopeKey, cacheEpoch).revision;
  }

  recordRatingRead(scopeKey: string, cacheEpoch: number, value: SubjectOwnRating) {
    if (this.getCacheEpoch(scopeKey) !== cacheEpoch) return;
    const state = this.writeState(scopeKey, cacheEpoch);
    if (state.owner !== null || state.pending.size > 0) return;
    state.committed = value;
    state.committedSequence = state.sequence;
  }

  private writeState(scopeKey: string, cacheEpoch: number) {
    const key = `${scopeKey}:${cacheEpoch}`;
    let state = this.writes.get(key);
    if (!state) {
      state = {
        revision: 0,
        nextId: 0,
        sequence: 0,
        committedSequence: 0,
        owner: null,
        pending: new Set(),
      };
      this.writes.set(key, state);
    }
    return state;
  }

  register(scope: PersonalScope, isDesired: () => boolean): SubjectPersonalLease {
    const scopeState = this.scope(scope.scopeKey);
    scopeState.observers++;
    scopeState.retirement++;
    let live = true;
    const isCurrent = () => live && this.isScopeCurrent(scope, isDesired);
    const writeState = () => this.writeState(scope.scopeKey, scope.cacheEpoch);
    const key = JSON.stringify([
      scope.scopeKey,
      scope.cacheEpoch,
      scope.errorEpoch,
      scope.admission,
      scope.reader,
      scope.subjectId,
      scope.locale,
      scope.view,
    ]);
    const leaseScope: SubjectPersonalQueryScope = {
      reader: scope.reader,
      admission: scope.admission,
      view: scope.view,
      cacheEpoch: scope.cacheEpoch,
      errorEpoch: scope.errorEpoch,
      scopeKey: scope.scopeKey,
      getWriteRevision: () => writeState().revision,
      hasLiveObserver: () => this.hasLiveObserver(scope.scopeKey, scope.cacheEpoch),
      isCurrent,
      recordRatingRead: (rating) => this.recordRatingRead(scope.scopeKey, scope.cacheEpoch, rating),
    };
    const retire = () => {
      if (!live) return;
      live = false;
      scopeState.observers--;
      if (scopeState.observers !== 0) return;
      const retirement = ++scopeState.retirement;
      queueMicrotask(() => {
        if (scopeState.observers !== 0 || scopeState.retirement !== retirement) return;
        this.cacheEpochs.set(scope.scopeKey, this.getCacheEpoch(scope.scopeKey) + 1);
        this.notify();
      });
    };
    const lease: SubjectPersonalLease = {
      key,
      reader: scope.reader,
      subjectId: scope.subjectId,
      locale: scope.locale,
      view: scope.view,
      scope: leaseScope,
      retire,
      isCurrent,
      beginRatingWrite: (before) => {
        if (!isCurrent()) return null;
        const state = writeState();
        if (state.committed === undefined && before !== undefined) state.committed = before;
        const id = ++state.nextId;
        const sequence = ++state.sequence;
        state.revision++;
        state.owner = id;
        state.pending.add(id);
        return {
          id,
          sequence,
          ownsCache: () => state.owner === id,
          commit: (value) => {
            if (!isCurrent()) return;
            state.pending.delete(id);
            if (sequence >= state.committedSequence) {
              state.committed = value;
              state.committedSequence = sequence;
            }
            if (state.owner === id) state.owner = null;
          },
          rollback: (fallback) => {
            if (!isCurrent()) return null;
            state.pending.delete(id);
            if (state.owner !== id) return null;
            state.owner = null;
            return state.committed ?? fallback;
          },
          preserveUncertainty: (value) => {
            if (!isCurrent()) return;
            state.pending.delete(id);
            if (sequence >= state.committedSequence) {
              state.committed = value;
              state.committedSequence = sequence;
            }
            if (state.owner === id) state.owner = null;
          },
        };
      },
    };
    return lease;
  }
}

const registries = new WeakMap<QueryClient, SubjectPersonalReaderRegistry>();

function registryFor(client: QueryClient) {
  let registry = registries.get(client);
  if (!registry) {
    registry = new SubjectPersonalReaderRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}

export function useSubjectPersonalReader(input: {
  subjectId: string;
  locale: string;
  view: string;
  session: SessionAdmission;
  enabled?: boolean;
  includeOwnRating?: boolean;
  transport?: SubjectPersonalReadTransport;
}) {
  const { subjectId, locale, view, session, enabled: routeEnabled = true, includeOwnRating = false, transport } = input;
  const queryClient = useQueryClient();
  const registry = useMemo(() => registryFor(queryClient), [queryClient]);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getServerSnapshot);
  const current = registry.currentSession(session);
  const { reader, admission, ready: sessionReady } = current;
  const scopeKey = JSON.stringify([subjectId, locale, view, reader, admission]);
  const cacheEpoch = registry.getCacheEpoch(scopeKey);
  const errorEpoch = registry.getErrorEpoch(scopeKey);
  const bindingToken = JSON.stringify([scopeKey, cacheEpoch, errorEpoch]);
  const desiredRef = useRef(bindingToken);
  desiredRef.current = bindingToken;
  const [leaseState, setLeaseState] = useState<{ token: string; lease: SubjectPersonalLease } | null>(null);

  useLayoutEffect(() => {
    if (!sessionReady || !reader) {
      setLeaseState(null);
      return;
    }
    const personalScope: PersonalScope = {
      scopeKey,
      admission,
      reader,
      subjectId,
      locale,
      view,
      cacheEpoch,
      errorEpoch,
    };
    const lease = registry.register(personalScope, () => desiredRef.current === bindingToken);
    setLeaseState({ token: bindingToken, lease });
    return () => lease.retire();
  }, [registry, scopeKey, admission, reader, subjectId, locale, view, cacheEpoch, errorEpoch, sessionReady, bindingToken]);

  const queryScope: SubjectPersonalQueryScope = {
    reader,
    admission,
    view,
    cacheEpoch,
    errorEpoch,
    scopeKey,
    getWriteRevision: () => registry.getWriteRevision(scopeKey, cacheEpoch),
    hasLiveObserver: () => registry.hasLiveObserver(scopeKey, cacheEpoch),
    isCurrent: () => registry.isQueryCurrent({
      scopeKey,
      admission,
      reader: reader ?? '',
      subjectId,
      locale,
      view,
      cacheEpoch,
      errorEpoch,
    }),
    recordRatingRead: (rating) => registry.recordRatingRead(scopeKey, cacheEpoch, rating),
  };
  const enabled = personalRead.enabled && routeEnabled && sessionReady && reader !== null;
  const preferencesOptions = subjectReaderQuery(subjectId, locale, queryScope, transport);
  const ownRatingOptions = subjectOwnRatingQuery(subjectId, locale, queryScope, transport);
  const preferencesQuery = useQuery({ ...preferencesOptions, enabled: enabled && preferencesOptions.enabled !== false });
  const ownRatingQuery = useQuery({
    ...ownRatingOptions,
    enabled: includeOwnRating && enabled && ownRatingOptions.enabled !== false,
  });
  const currentLease =
    leaseState?.token === bindingToken && leaseState.lease.isCurrent() ? leaseState.lease : undefined;
  const preferences =
    enabled &&
    !preferencesQuery.isError &&
    preferencesQuery.data?.reader === reader &&
    currentLease?.isCurrent()
      ? preferencesQuery.data.preferences
      : defaultReader;
  const ownRating =
    includeOwnRating &&
    enabled &&
    !ownRatingQuery.isError &&
    ownRatingQuery.data?.reader === reader &&
    currentLease?.isCurrent()
      ? ownRatingQuery.data
      : undefined;

  return { reader: preferences as Reader, ownRating, binding: currentLease, sessionReady, readerId: reader };
}
