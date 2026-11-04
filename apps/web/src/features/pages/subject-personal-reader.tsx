import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  addressLease,
  readLease,
  browserObservation,
  type BrowserSession,
  type BrowserCacheEvent,
} from '../../session';
import { personalRead } from '../../kernel/query';
import { defaultReader, type Reader } from '../../subject/reader';
import type { SubjectOwnRating } from './subject-ratings';
import {
  subjectOwnRatingQuery,
  subjectReaderQuery,
  type SubjectPersonalQueryScope,
  type SubjectPersonalReadTransport,
} from './subject-queries';

type SessionAdmission = BrowserSession;

type LeaseState = {
  active: boolean;
  incarnation: number;
  cacheEpoch: number;
  errorEpoch: number;
  operations: Map<number, RatingWriteState>;
};
type ScopeState = {
  incarnation: number;
  observers: Set<LeaseState>;
  retirement: number;
  cacheEpoch: number;
  errorEpoch: number;
  writeState: RatingWriteState;
  retired: boolean;
};
type RatingWriteState = {
  revision: number;
  nextId: number;
  sequence: number;
  committedSequence: number;
  committed?: SubjectOwnRating;
  owner: number | null;
  pending: Map<number, { sequence: number; value: SubjectOwnRating }>;
};

function createRatingWriteState(): RatingWriteState {
  return {
    revision: 0,
    nextId: 0,
    sequence: 0,
    committedSequence: 0,
    owner: null,
    pending: new Map(),
  };
}

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
  beginRatingWrite(before: SubjectOwnRating | undefined, value: SubjectOwnRating): SubjectRatingWriteOperation | null;
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
  incarnation: number;
};

function metaString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

class SubjectPersonalReaderRegistry {
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly scopes = new Map<string, ScopeState>();
  private nextIncarnation = 0;
  private stopCache: (() => void) | undefined;
  private readonly observation;

  constructor(private readonly client: QueryClient) {
    this.observation = browserObservation(client);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.stopCache) {
      this.stopCache = this.observation.subscribeCache(this.onCacheEvent);
      // Subscribing enrolls the existing browser observation on the first mount.
      this.notify();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size !== 0) return;
      this.stopCache?.();
      this.stopCache = undefined;
      for (const scope of this.scopes.values()) {
        this.retireWrites(scope);
        scope.retired = true;
      }
      this.scopes.clear();
    };
  };

  getSnapshot = () => this.version;
  getServerSnapshot = () => 0;

  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private onCacheEvent = (event: BrowserCacheEvent) => {
    if (event.query.queryKey.length === 1 && event.query.queryKey[0] === 'session') {
      this.notify();
      return;
    }

    const meta = event.query.meta as Record<string, unknown> | undefined;
    const scopeKey = metaString(meta?.subjectPersonalScope);
    if (!scopeKey) return;
    const scopeState = this.scopes.get(scopeKey);
    if (!scopeState || scopeState.retired) return;
    const incarnation = typeof meta?.subjectPersonalIncarnation === 'number' ? meta.subjectPersonalIncarnation : 0;
    if (incarnation !== scopeState.incarnation) return;
    const cacheEpoch = typeof meta?.subjectPersonalCacheEpoch === 'number' ? meta.subjectPersonalCacheEpoch : 0;
    const errorEpoch = typeof meta?.subjectPersonalErrorEpoch === 'number' ? meta.subjectPersonalErrorEpoch : 0;
    if (event.type === 'removed') {
      if (cacheEpoch !== scopeState.cacheEpoch || errorEpoch !== scopeState.errorEpoch) return;
      this.retireWrites(scopeState);
      scopeState.cacheEpoch++;
      scopeState.errorEpoch = 0;
      scopeState.writeState = createRatingWriteState();
      this.notify();
      return;
    }
    if (
      event.type === 'updated' &&
      event.action.type === 'error' &&
      cacheEpoch === scopeState.cacheEpoch &&
      errorEpoch === scopeState.errorEpoch &&
      this.hasLiveObserver(scopeKey, cacheEpoch, errorEpoch, incarnation)
    ) {
      this.retireWrites(scopeState);
      scopeState.errorEpoch++;
      scopeState.writeState = createRatingWriteState();
      this.notify();
    }
  };

  currentSession(session: SessionAdmission) {
    const snapshot = this.observation.getSnapshot();
    const reader = snapshot.state === 'signed-in' ? snapshot.observation.subject : null;
    const ready =
      (snapshot.state === 'signed-in' && session.state === 'signed-in' && reader === session.subject) ||
      (snapshot.state === 'signed-out' && session.state === 'signed-out');
    return { ready, reader, admission: snapshot.state === 'signed-in' ? snapshot.observation.id : 0 };
  }

  getCacheEpoch(scopeKey: string) {
    return this.scopes.get(scopeKey)?.cacheEpoch ?? 0;
  }

  getErrorEpoch(scopeKey: string) {
    return this.scopes.get(scopeKey)?.errorEpoch ?? 0;
  }

  getIncarnation(scopeKey: string) {
    return this.scopes.get(scopeKey)?.incarnation ?? 0;
  }

  prepareScope(scopeKey: string) {
    const scope = this.scope(scopeKey);
    return { cacheEpoch: scope.cacheEpoch, errorEpoch: scope.errorEpoch, incarnation: scope.incarnation };
  }

  nextRouteIncarnation() {
    return ++this.nextIncarnation;
  }

  private scope(scopeKey: string) {
    let value = this.scopes.get(scopeKey);
    if (!value) {
      value = {
        incarnation: ++this.nextIncarnation,
        observers: new Set(),
        retirement: 0,
        cacheEpoch: 0,
        errorEpoch: 0,
        writeState: createRatingWriteState(),
        retired: false,
      };
      this.scopes.set(scopeKey, value);
    }
    return value;
  }

  private matchingScope(scopeKey: string, cacheEpoch: number, errorEpoch: number, incarnation: number) {
    const state = this.scopes.get(scopeKey);
    return state &&
      !state.retired &&
      state.incarnation === incarnation &&
      state.cacheEpoch === cacheEpoch &&
      state.errorEpoch === errorEpoch
      ? state
      : undefined;
  }

  hasLiveObserver(scopeKey: string, cacheEpoch: number, errorEpoch: number, incarnation: number) {
    const state = this.matchingScope(scopeKey, cacheEpoch, errorEpoch, incarnation);
    if (!state) return false;
    for (const observer of state.observers)
      if (
        observer.active &&
        observer.incarnation === incarnation &&
        observer.cacheEpoch === cacheEpoch &&
        observer.errorEpoch === errorEpoch
      )
        return true;
    return false;
  }

  isQueryCurrent(scope: PersonalScope) {
    const current = this.observation.getSnapshot();
    return (
      this.hasLiveObserver(scope.scopeKey, scope.cacheEpoch, scope.errorEpoch, scope.incarnation) &&
      current.state === 'signed-in' &&
      current.observation.id === scope.admission &&
      current.observation.subject === scope.reader &&
      this.getCacheEpoch(scope.scopeKey) === scope.cacheEpoch &&
      this.getErrorEpoch(scope.scopeKey) === scope.errorEpoch &&
      this.getIncarnation(scope.scopeKey) === scope.incarnation
    );
  }

  getWriteRevision(scopeKey: string, cacheEpoch: number, errorEpoch: number, incarnation: number) {
    return this.matchingScope(scopeKey, cacheEpoch, errorEpoch, incarnation)?.writeState.revision ?? -1;
  }

  recordRatingRead(
    scopeKey: string,
    cacheEpoch: number,
    errorEpoch: number,
    incarnation: number,
    value: SubjectOwnRating,
  ) {
    if (!this.hasLiveObserver(scopeKey, cacheEpoch, errorEpoch, incarnation)) return;
    const state = this.matchingScope(scopeKey, cacheEpoch, errorEpoch, incarnation)?.writeState;
    if (!state) return;
    if (state.owner !== null || state.pending.size > 0) return;
    state.committed = value;
    state.committedSequence = state.sequence;
  }

  private selectCurrentOwner(state: RatingWriteState) {
    let owner: number | null = null;
    let sequence = state.committedSequence;
    for (const [id, pending] of state.pending) {
      if (pending.sequence > sequence) {
        owner = id;
        sequence = pending.sequence;
      }
    }
    state.owner = owner;
  }

  private releaseOperation(state: RatingWriteState, id: number) {
    if (!state.pending.delete(id)) return false;
    const ownedCache = state.owner === id;
    if (ownedCache) this.selectCurrentOwner(state);
    state.revision++;
    return ownedCache;
  }

  private retireWrites(scopeState: ScopeState) {
    for (const observer of scopeState.observers) {
      for (const [id, state] of observer.operations) this.releaseOperation(state, id);
      observer.operations.clear();
    }
  }

  private inertLease(scope: PersonalScope): SubjectPersonalLease {
    return {
      key: JSON.stringify([scope.scopeKey, scope.incarnation, scope.cacheEpoch, scope.errorEpoch]),
      reader: scope.reader,
      subjectId: scope.subjectId,
      locale: scope.locale,
      view: scope.view,
      scope: {
        reader: scope.reader,
        admission: scope.admission,
        view: scope.view,
        cacheEpoch: scope.cacheEpoch,
        errorEpoch: scope.errorEpoch,
        incarnation: scope.incarnation,
        scopeKey: scope.scopeKey,
      },
      retire: () => {},
      isCurrent: () => false,
      beginRatingWrite: () => null,
    };
  }

  register(scope: PersonalScope, isDesired: () => boolean): SubjectPersonalLease {
    const scopeState = this.scopes.get(scope.scopeKey);
    if (
      !scopeState ||
      scopeState.retired ||
      scopeState.incarnation !== scope.incarnation ||
      scopeState.cacheEpoch !== scope.cacheEpoch ||
      scopeState.errorEpoch !== scope.errorEpoch
    ) {
      if (scopeState && scopeState.observers.size === 0) {
        const retirement = ++scopeState.retirement;
        queueMicrotask(() => {
          if (scopeState.observers.size !== 0 || scopeState.retirement !== retirement) return;
          scopeState.retired = true;
          if (this.scopes.get(scope.scopeKey) === scopeState) this.scopes.delete(scope.scopeKey);
        });
      }
      return this.inertLease(scope);
    }
    const observer: LeaseState = {
      active: true,
      incarnation: scope.incarnation,
      cacheEpoch: scope.cacheEpoch,
      errorEpoch: scope.errorEpoch,
      operations: new Map(),
    };
    scopeState.observers.add(observer);
    scopeState.retirement++;
    const address = addressLease(() => observer.active && isDesired());
    const reading = readLease(scope.reader, address, () => this.isQueryCurrent(scope));
    const isCurrent = reading.current;
    const writeState = () => scopeState.writeState;
    const key = JSON.stringify([
      scope.scopeKey,
      scope.incarnation,
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
      incarnation: scope.incarnation,
      scopeKey: scope.scopeKey,
      getWriteRevision: () =>
        this.getWriteRevision(scope.scopeKey, scope.cacheEpoch, scope.errorEpoch, scope.incarnation),
      hasLiveObserver: () =>
        this.hasLiveObserver(scope.scopeKey, scope.cacheEpoch, scope.errorEpoch, scope.incarnation),
      isCurrent,
      recordRatingRead: (rating) =>
        this.recordRatingRead(scope.scopeKey, scope.cacheEpoch, scope.errorEpoch, scope.incarnation, rating),
    };
    const ownRatingKey = subjectOwnRatingQuery(scope.subjectId, scope.locale, leaseScope).queryKey;
    const retire = () => {
      if (!observer.active) return;
      observer.active = false;
      address.retire();
      scopeState.observers.delete(observer);
      let restoreRating = false;
      for (const [id, state] of observer.operations) if (this.releaseOperation(state, id)) restoreRating = true;
      observer.operations.clear();
      if (
        restoreRating &&
        this.hasLiveObserver(scope.scopeKey, scope.cacheEpoch, scope.errorEpoch, scope.incarnation)
      ) {
        const owner = scopeState.writeState.owner;
        const rating =
          (owner === null ? undefined : scopeState.writeState.pending.get(owner)?.value) ??
          scopeState.writeState.committed;
        if (rating !== undefined) this.client.setQueryData(ownRatingKey, rating);
      }
      if (scopeState.observers.size !== 0) return;
      const retirement = ++scopeState.retirement;
      queueMicrotask(() => {
        if (scopeState.observers.size !== 0 || scopeState.retirement !== retirement) return;
        scopeState.retired = true;
        if (this.scopes.get(scope.scopeKey) === scopeState) this.scopes.delete(scope.scopeKey);
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
      beginRatingWrite: (before, value) => {
        if (!isCurrent()) return null;
        const state = writeState();
        if (state.committed === undefined && before !== undefined) state.committed = before;
        const id = ++state.nextId;
        const sequence = ++state.sequence;
        state.revision++;
        state.owner = id;
        state.pending.set(id, { sequence, value });
        observer.operations.set(id, state);
        return {
          id,
          sequence,
          ownsCache: () => isCurrent() && state.owner === id,
          commit: (value) => {
            if (!isCurrent()) return;
            observer.operations.delete(id);
            state.pending.delete(id);
            if (sequence >= state.committedSequence) {
              state.committed = value;
              state.committedSequence = sequence;
            }
            if (state.owner === id) this.selectCurrentOwner(state);
            state.revision++;
          },
          rollback: (fallback) => {
            if (!isCurrent()) return null;
            observer.operations.delete(id);
            state.pending.delete(id);
            state.revision++;
            if (state.owner !== id) return null;
            this.selectCurrentOwner(state);
            const owner = state.owner;
            return (owner === null ? undefined : state.pending.get(owner)?.value) ?? state.committed ?? fallback;
          },
          preserveUncertainty: (value) => {
            if (!isCurrent()) return;
            observer.operations.delete(id);
            state.pending.delete(id);
            if (sequence >= state.committedSequence) {
              state.committed = value;
              state.committedSequence = sequence;
            }
            if (state.owner === id) this.selectCurrentOwner(state);
            state.revision++;
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
  const routeAdmission = useRef({ enabled: routeEnabled, incarnation: 0 });
  if (routeAdmission.current.enabled !== routeEnabled) {
    routeAdmission.current = { enabled: routeEnabled, incarnation: registry.nextRouteIncarnation() };
  }
  const routeIncarnation = routeAdmission.current.incarnation;
  const scopeKey = JSON.stringify([subjectId, locale, view, reader, admission, routeIncarnation]);
  const enabled = personalRead.enabled && routeEnabled && sessionReady && reader !== null;
  const scopeIdentity = enabled
    ? registry.prepareScope(scopeKey)
    : { cacheEpoch: 0, errorEpoch: 0, incarnation: routeIncarnation };
  const { cacheEpoch, errorEpoch, incarnation } = scopeIdentity;
  const bindingToken = JSON.stringify([scopeKey, incarnation, cacheEpoch, errorEpoch, routeEnabled]);
  const desiredRef = useRef(bindingToken);
  desiredRef.current = bindingToken;
  const [leaseState, setLeaseState] = useState<{ token: string; lease: SubjectPersonalLease } | null>(null);

  useLayoutEffect(() => {
    if (!enabled || !reader) {
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
      incarnation,
    };
    const lease = registry.register(personalScope, () => desiredRef.current === bindingToken);
    setLeaseState({ token: bindingToken, lease });
    return () => lease.retire();
  }, [
    registry,
    scopeKey,
    admission,
    reader,
    subjectId,
    locale,
    view,
    routeEnabled,
    cacheEpoch,
    errorEpoch,
    incarnation,
    sessionReady,
    bindingToken,
  ]);

  const queryScope: SubjectPersonalQueryScope = {
    reader,
    admission,
    view,
    cacheEpoch,
    errorEpoch,
    incarnation,
    scopeKey,
    getWriteRevision: () => registry.getWriteRevision(scopeKey, cacheEpoch, errorEpoch, incarnation),
    hasLiveObserver: () => registry.hasLiveObserver(scopeKey, cacheEpoch, errorEpoch, incarnation),
    isCurrent: () =>
      registry.isQueryCurrent({
        scopeKey,
        admission,
        reader: reader ?? '',
        subjectId,
        locale,
        view,
        cacheEpoch,
        errorEpoch,
        incarnation,
      }),
    recordRatingRead: (rating) => registry.recordRatingRead(scopeKey, cacheEpoch, errorEpoch, incarnation, rating),
  };
  const preferencesOptions = subjectReaderQuery(subjectId, locale, queryScope, transport);
  const ownRatingOptions = subjectOwnRatingQuery(subjectId, locale, queryScope, transport);
  const preferencesQuery = useQuery({
    ...preferencesOptions,
    enabled: enabled && preferencesOptions.enabled !== false,
  });
  const ownRatingQuery = useQuery({
    ...ownRatingOptions,
    enabled: includeOwnRating && enabled && ownRatingOptions.enabled !== false,
  });
  const currentLease =
    leaseState?.token === bindingToken && leaseState.lease.isCurrent() ? leaseState.lease : undefined;
  const preferences =
    enabled && !preferencesQuery.isError && preferencesQuery.data?.reader === reader && currentLease?.isCurrent()
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
