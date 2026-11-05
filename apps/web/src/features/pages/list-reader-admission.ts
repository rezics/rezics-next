import { useLayoutEffect, useReducer, useRef } from 'react';
import type { QueryKey, QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../../session/query';
import type { SessionState } from '../../session/state';

export type ListReaderSession = {
  state: 'unknown' | SessionState;
  csrfToken: string | null;
  subject?: string | null;
};

type SessionPhase = 'unobserved' | 'pending' | 'error' | 'removed' | 'success';

type SessionSnapshot = {
  phase: SessionPhase;
  query: object | null;
  status: string;
  fetchStatus: string;
  data: unknown;
  error: unknown;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  dataUpdateCount: number;
  errorUpdateCount: number;
  session?: ListReaderSession;
};

type ListReaderOwner = {
  scope: string;
  sourceFingerprint: string;
  privateReading: boolean;
  observeSession: boolean;
  snapshot: SessionSnapshot;
  incarnation: string;
  active: boolean;
  invalidated: boolean;
  suspended: boolean;
  queryKeys: Map<string, QueryKey>;
};

const unknownSession: ListReaderSession = { state: 'unknown', csrfToken: null };

function isSessionState(value: unknown): value is ListReaderSession['state'] {
  return value === 'unknown' || value === 'signed-in' || value === 'signed-out' || value === 'unavailable';
}

function sessionData(value: unknown): ListReaderSession | undefined {
  if (typeof value !== 'object' || value === null || !('state' in value) || !isSessionState(value.state))
    return undefined;
  const candidate = value as { state: ListReaderSession['state']; csrfToken?: unknown; subject?: unknown };
  if (candidate.csrfToken !== null && candidate.csrfToken !== undefined && typeof candidate.csrfToken !== 'string')
    return undefined;
  if (candidate.subject !== null && candidate.subject !== undefined && typeof candidate.subject !== 'string')
    return undefined;
  return {
    state: candidate.state,
    csrfToken: typeof candidate.csrfToken === 'string' ? candidate.csrfToken : null,
    ...(typeof candidate.subject === 'string' || candidate.subject === null ? { subject: candidate.subject } : {}),
  };
}

function readSessionSnapshot(queryClient: QueryClient): SessionSnapshot {
  if (typeof window === 'undefined')
    return {
      phase: 'unobserved',
      query: null,
      status: 'pending',
      fetchStatus: 'idle',
      data: undefined,
      error: undefined,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      dataUpdateCount: 0,
      errorUpdateCount: 0,
    };
  const query = queryClient.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  if (!query)
    return {
      phase: 'unobserved',
      query: null,
      status: 'pending',
      fetchStatus: 'idle',
      data: undefined,
      error: undefined,
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      dataUpdateCount: 0,
      errorUpdateCount: 0,
    };
  const state = query.state;
  const parsed = sessionData(state.data);
  const phase: SessionPhase =
    state.status === 'error'
      ? 'error'
      : state.fetchStatus !== 'idle'
        ? 'pending'
        : state.status === 'success' && parsed
          ? 'success'
          : state.status === 'success'
            ? 'error'
            : 'unobserved';
  return {
    phase,
    query,
    status: state.status,
    fetchStatus: state.fetchStatus,
    data: state.data,
    error: state.error,
    dataUpdatedAt: state.dataUpdatedAt,
    errorUpdatedAt: state.errorUpdatedAt,
    dataUpdateCount: state.dataUpdateCount,
    errorUpdateCount: state.errorUpdateCount,
    ...(parsed ? { session: parsed } : {}),
  };
}

function sameSnapshot(left: SessionSnapshot, right: SessionSnapshot): boolean {
  return (
    left.phase === right.phase &&
    left.query === right.query &&
    left.status === right.status &&
    left.fetchStatus === right.fetchStatus &&
    left.data === right.data &&
    left.error === right.error &&
    left.dataUpdatedAt === right.dataUpdatedAt &&
    left.errorUpdatedAt === right.errorUpdatedAt &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.errorUpdateCount === right.errorUpdateCount
  );
}

function currentSession(snapshot: SessionSnapshot): ListReaderSession {
  if (snapshot.phase === 'success') return snapshot.session ?? unknownSession;
  if (snapshot.phase === 'error') return { state: 'unavailable', csrfToken: null };
  return unknownSession;
}

function canRemainActive(snapshot: SessionSnapshot): boolean {
  return snapshot.phase === 'unobserved' || snapshot.phase === 'success';
}

function freshIncarnation(): string {
  return crypto.randomUUID();
}

function makeOwner(
  scope: string,
  sourceFingerprint: string,
  privateReading: boolean,
  observeSession: boolean,
  snapshot: SessionSnapshot,
  invalidated = snapshot.phase === 'error' || snapshot.phase === 'removed',
): ListReaderOwner {
  return {
    scope,
    sourceFingerprint,
    privateReading,
    observeSession,
    snapshot,
    incarnation: freshIncarnation(),
    active: !privateReading || !observeSession || canRemainActive(snapshot),
    invalidated,
    suspended: false,
    queryKeys: new Map(),
  };
}

/**
 * Bind a mounted list owner to synchronous session-cache publications. Each mounted owner gets a
 * private incarnation; stale server work and actions cannot borrow a later same-reader admission.
 */
export function useListReaderAdmission(
  queryClient: QueryClient,
  scope: string,
  options: {
    sourceFingerprint: string;
    privateReading: boolean;
    observeSession: boolean;
    fallbackSession: ListReaderSession;
  },
) {
  const [, invalidateRender] = useReducer((version: number) => version + 1, 0);
  const snapshot = options.privateReading && options.observeSession ? readSessionSnapshot(queryClient) : undefined;
  const initialSnapshot = snapshot ?? {
    phase: 'success' as const,
    query: null,
    status: 'success',
    fetchStatus: 'idle',
    data: options.fallbackSession,
    error: undefined,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    dataUpdateCount: 0,
    errorUpdateCount: 0,
    session: options.fallbackSession,
  };
  const ownerRef = useRef<ListReaderOwner | null>(null);
  let owner = ownerRef.current;
  if (!owner || owner.privateReading !== options.privateReading || owner.observeSession !== options.observeSession) {
    if (owner) owner.active = false;
    owner = makeOwner(
      scope,
      options.sourceFingerprint,
      options.privateReading,
      options.observeSession,
      initialSnapshot,
    );
    ownerRef.current = owner;
  } else if (owner.scope !== scope) {
    if (owner.sourceFingerprint === options.sourceFingerprint) {
      owner.active = false;
      owner = makeOwner(
        scope,
        options.sourceFingerprint,
        options.privateReading,
        options.observeSession,
        initialSnapshot,
        true,
      );
      ownerRef.current = owner;
    } else {
      owner.active = false;
      owner = makeOwner(
        scope,
        options.sourceFingerprint,
        options.privateReading,
        options.observeSession,
        initialSnapshot,
      );
      ownerRef.current = owner;
    }
  } else if (owner.sourceFingerprint !== options.sourceFingerprint) {
    owner.active = false;
    owner = makeOwner(
      scope,
      options.sourceFingerprint,
      options.privateReading,
      options.observeSession,
      initialSnapshot,
    );
    ownerRef.current = owner;
  }

  function clearOwnedQueries(target: ListReaderOwner) {
    for (const queryKey of target.queryKeys.values()) {
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      // Observed reads retire through QueryObserver. Only unobserved explicit reads need cancellation here.
      if (query && query.getObserversCount() > 0) continue;
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.removeQueries({ queryKey, exact: true });
    }
    target.queryKeys.clear();
  }

  function retire(target: ListReaderOwner, next: SessionSnapshot) {
    target.active = false;
    target.invalidated = true;
    target.snapshot = next;
    target.incarnation = freshIncarnation();
    clearOwnedQueries(target);
    target.active = canRemainActive(next);
  }

  useLayoutEffect(() => {
    const observesSession = owner.privateReading && owner.observeSession;
    const cache = queryClient.getQueryCache();
    const wasSuspended = owner.suspended;
    const unsubscribe = observesSession
      ? cache.subscribe((event) => {
          const eventKey: QueryKey = event.query.queryKey;
          if (
            ownerRef.current !== owner ||
            eventKey.length !== sessionQuery.queryKey.length ||
            eventKey.some((part: unknown, index: number) => part !== sessionQuery.queryKey[index])
          )
            return;
          let next: SessionSnapshot;
          if (event.type === 'removed') {
            next = {
              phase: 'removed',
              query: null,
              status: 'pending',
              fetchStatus: 'idle',
              data: undefined,
              error: undefined,
              dataUpdatedAt: 0,
              errorUpdatedAt: 0,
              dataUpdateCount: 0,
              errorUpdateCount: 0,
            };
          } else if (event.type === 'added') {
            const observed = readSessionSnapshot(queryClient);
            next = { ...observed, phase: observed.phase === 'unobserved' ? 'pending' : observed.phase };
          } else if (event.type === 'updated') {
            const observed = readSessionSnapshot(queryClient);
            const action = event.action.type;
            if (action === 'error' || action === 'invalidate' || action === 'fetch') {
              const { session: _session, ...withoutSession } = observed;
              next = { ...withoutSession, phase: action === 'error' ? 'error' : 'pending' };
            } else if (action === 'success' || action === 'setState') next = observed;
            else return;
          } else return;
          retire(owner, next);
          invalidateRender();
        })
      : undefined;

    const latest = observesSession ? readSessionSnapshot(queryClient) : owner.snapshot;
    if (!sameSnapshot(owner.snapshot, latest)) {
      retire(owner, latest);
      invalidateRender();
    } else if (wasSuspended) {
      owner.incarnation = freshIncarnation();
      owner.active = canRemainActive(owner.snapshot);
      invalidateRender();
    }
    owner.suspended = false;

    return () => {
      unsubscribe?.();
      if (ownerRef.current !== owner) {
        clearOwnedQueries(owner);
        return;
      }
      owner.active = false;
      owner.suspended = true;
      owner.incarnation = freshIncarnation();
      clearOwnedQueries(owner);
    };
  }, [owner, queryClient, scope]);

  const incarnation = owner.incarnation;
  const active = owner.active;
  const observedSession = options.privateReading && options.observeSession ? currentSession(owner.snapshot) : undefined;
  const session = observedSession ?? options.fallbackSession;
  const canRead =
    !options.privateReading ||
    !options.observeSession ||
    (active && owner.snapshot.phase === 'success' && session.state !== 'unknown');

  return {
    incarnation,
    session,
    active,
    canRead,
    invalidated: owner.invalidated,
    current(token: string) {
      return ownerRef.current === owner && owner.active && owner.incarnation === token;
    },
    initialAllowed(expectedReader: string | null | undefined) {
      if (!options.privateReading || !options.observeSession) return true;
      if (owner.invalidated || owner.snapshot.phase === 'error' || owner.snapshot.phase === 'removed') return false;
      if (owner.snapshot.phase === 'unobserved') return true;
      if (owner.snapshot.phase !== 'success') return false;
      if (expectedReader === undefined || expectedReader === null) return true;
      return session.state === 'signed-in' && session.subject === expectedReader;
    },
    registerQuery(slot: string, queryKey: QueryKey) {
      owner.queryKeys.set(slot, queryKey);
    },
    releaseQuery(slot: string, queryKey: QueryKey) {
      const owned = owner.queryKeys.get(slot);
      if (owned && JSON.stringify(owned) === JSON.stringify(queryKey)) owner.queryKeys.delete(slot);
    },
  };
}
