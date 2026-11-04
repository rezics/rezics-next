import { QueryClientContext, replaceEqualDeep, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ReadCredentialMode } from '../kernel/credential';
import { getLocale } from '../paraglide/runtime.js';
import { sessionQuery } from '../session/query';
import type { LoadedThreadPage } from './thread-page';

type SessionRecord = { state?: unknown; subject?: unknown; csrfToken?: unknown };
type SessionStamp = {
  revision: number;
  tuple: string;
  state: string;
  subject: string | null;
  csrfToken: string | null;
  status: string;
  dataUpdateCount: number;
  errorUpdateCount: number;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
};

export type ThreadPageRouteIdentity = {
  id: string;
  cursor?: string;
  post?: string;
  slug?: string;
  locale: string;
  credentialMode: ReadCredentialMode;
};

export type ThreadPageAdmission = {
  id: string;
  sourceId: string;
  identity: ThreadPageRouteIdentity;
  expectedSlug?: string;
  queryKey: QueryKey;
  session: Omit<SessionStamp, 'revision'> & { revision: number };
  publicRead: boolean;
};

type QueryStamp = {
  query: object;
  status: string;
  fetchStatus: string;
  data: unknown;
  dataUpdateCount: number;
  errorUpdateCount: number;
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  terminalRevision: number;
};

type QueryCacheEvent = {
  type: string;
  query: { queryKey: QueryKey; state?: unknown };
  action?: { type?: string; state?: unknown; data?: unknown; error?: unknown; manual?: boolean };
};

type OwnedPageRead = {
  queryKey: QueryKey;
  query: object | undefined;
  dataUpdateCount: number;
  errorUpdateCount: number;
  result: unknown;
  committedData: unknown;
  error: unknown;
  started: boolean;
  resultReady: boolean;
  commitReady: boolean;
  commitObserved: boolean;
  errorReady: boolean;
};

type RefreshCacheBoundary = {
  kind: 'cancel' | 'remove';
  queries: Set<object>;
  continuation: RefreshContinuationState | undefined;
  cancelEvents: Map<object, object>;
  removeEvents: Map<object, object>;
};

type RefreshContinuationState = {
  active: boolean;
  identity: ThreadPageRouteIdentity;
  session: SessionStamp;
  connectionOwner: object;
  connectionGeneration: number;
  requiresConnection: boolean;
  queryRetired: boolean;
  sourceQuery: QueryStamp | undefined;
  ownedPageRead: OwnedPageRead | undefined;
};

export type ThreadPageRefreshContinuation = {
  readonly client: QueryClient;
  readonly sourceId: string;
  isCurrent(): boolean;
  runOwnedCacheBoundary<T>(kind: 'cancel' | 'remove', operation: () => T, peers?: readonly ThreadPageCaller[]): T;
  beginOwnedPageRead(queryKey: QueryKey): void;
  markOwnedPageReadStarted(queryKey: QueryKey): void;
  recordOwnedPageResult(queryKey: QueryKey, value: unknown): void;
  recordOwnedPageCommit(queryKey: QueryKey, result: unknown, committedData: unknown): void;
  recordOwnedPageError(queryKey: QueryKey, error: unknown): void;
  handoffQueryAuthority(preserveCaller?: boolean): void;
  invalidate(): void;
  release(): void;
};

type SessionSource = ReturnType<typeof observeThreadPageCache>;
const sources = new WeakMap<QueryClient, SessionSource>();
let sourceSequence = 0;
const sourceContextId = crypto.randomUUID();

function sessionCache(client: QueryClient) {
  const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
  const record = query?.state.data as SessionRecord | undefined;
  const state = typeof record?.state === 'string' ? record.state : 'unknown';
  const subject = typeof record?.subject === 'string' && record.subject ? record.subject : null;
  const csrfToken = typeof record?.csrfToken === 'string' && record.csrfToken ? record.csrfToken : null;
  const tuple = JSON.stringify([state, subject, csrfToken]);
  return {
    state,
    subject,
    csrfToken,
    tuple,
    status: query?.state.status ?? 'missing',
    dataUpdateCount: query?.state.dataUpdateCount ?? 0,
    errorUpdateCount: query?.state.errorUpdateCount ?? 0,
    dataUpdatedAt: query?.state.dataUpdatedAt ?? 0,
    errorUpdatedAt: query?.state.errorUpdatedAt ?? 0,
  };
}

function keyId(queryKey: QueryKey) {
  return JSON.stringify(queryKey);
}

function observeThreadPageCache(client: QueryClient) {
  let sessionRevision = 0;
  let observationRevision = 0;
  const terminalRevisions = new Map<string, number>();
  const previousQueryStates = new WeakMap<object, unknown>();
  const fetchRevertStates = new WeakMap<object, unknown>();
  const cancellationRevertEvents = new WeakSet<object>();
  const listeners = new Set<(event: QueryCacheEvent) => void>();
  for (const query of client.getQueryCache().getAll()) previousQueryStates.set(query, query.state);
  const initial = sessionCache(client);
  let previousSession = JSON.stringify(initial);
  client.getQueryCache().subscribe((event) => {
    observationRevision++;
    const cacheEvent = event as unknown as QueryCacheEvent;
    const { query, type } = cacheEvent;
    const queryObject = query as object;
    const previousQueryState = previousQueryStates.get(queryObject);
    if (type === 'added') {
      previousQueryStates.set(queryObject, query.state);
    } else if (type === 'updated') {
      if (cacheEvent.action?.type === 'fetch' && previousQueryState !== undefined)
        fetchRevertStates.set(queryObject, previousQueryState);
      else if (cacheEvent.action?.type === 'success' || cacheEvent.action?.type === 'error')
        fetchRevertStates.delete(queryObject);
      else if (cacheEvent.action?.type === 'setState') {
        const revertState = fetchRevertStates.get(queryObject);
        const priorFetchStatus =
          previousQueryState && typeof previousQueryState === 'object'
            ? (previousQueryState as Record<string, unknown>).fetchStatus
            : undefined;
        if (
          previousQueryState &&
          typeof previousQueryState === 'object' &&
          revertState &&
          typeof revertState === 'object' &&
          (priorFetchStatus === 'fetching' || priorFetchStatus === 'paused')
        ) {
          const expected = { ...(revertState as Record<string, unknown>), fetchStatus: 'idle' };
          const replacement = cacheEvent.action.state;
          if (
            replacement &&
            typeof replacement === 'object' &&
            query.state &&
            typeof query.state === 'object' &&
            statesMatch(expected, replacement as Record<string, unknown>) &&
            statesMatch(replacement as Record<string, unknown>, query.state as Record<string, unknown>)
          ) {
            cancellationRevertEvents.add(cacheEvent);
            fetchRevertStates.delete(queryObject);
          }
        }
      }
      previousQueryStates.set(queryObject, query.state);
    } else if (type === 'removed') {
      previousQueryStates.delete(queryObject);
      fetchRevertStates.delete(queryObject);
    }
    if (keyId(query.queryKey) === keyId(sessionQuery.queryKey)) {
      const next = JSON.stringify(sessionCache(client));
      const action = type === 'updated' ? cacheEvent.action?.type : undefined;
      const authorityEvent =
        type === 'added' || type === 'removed' || action === 'success' || action === 'error' || action === 'setState';
      if (authorityEvent || next !== previousSession) {
        sessionRevision++;
        previousSession = next;
      }
    }
    const terminalEvent =
      type === 'removed' ||
      (type === 'updated' && (cacheEvent.action?.type === 'error' || cacheEvent.action?.type === 'setState'));
    if (terminalEvent) {
      const id = keyId(query.queryKey);
      terminalRevisions.set(id, (terminalRevisions.get(id) ?? 0) + 1);
    }
    for (const listener of listeners) listener(cacheEvent);
    cancellationRevertEvents.delete(cacheEvent);
  });

  return {
    id: `thread-page-cache-${sourceContextId}-${++sourceSequence}`,
    readSession(): SessionStamp {
      return { ...sessionCache(client), revision: sessionRevision };
    },
    sessionRevision: () => sessionRevision,
    observationRevision: () => observationRevision,
    queryTerminalRevision(queryKey: QueryKey) {
      return terminalRevisions.get(keyId(queryKey)) ?? 0;
    },
    isCancellationRevert(event: QueryCacheEvent) {
      return cancellationRevertEvents.has(event as object);
    },
    queryStamp(queryKey: QueryKey): QueryStamp | undefined {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (!query) return undefined;
      return {
        query,
        status: query.state.status,
        fetchStatus: query.state.fetchStatus,
        data: query.state.data,
        dataUpdateCount: query.state.dataUpdateCount,
        errorUpdateCount: query.state.errorUpdateCount,
        dataUpdatedAt: query.state.dataUpdatedAt,
        errorUpdatedAt: query.state.errorUpdatedAt,
        terminalRevision: terminalRevisions.get(keyId(queryKey)) ?? 0,
      };
    },
    subscribe(listener: (event: QueryCacheEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function sourceFor(client: QueryClient) {
  let source = sources.get(client);
  if (!source) {
    source = observeThreadPageCache(client);
    sources.set(client, source);
  }
  return source;
}

function sameIdentity(left: ThreadPageRouteIdentity, right: ThreadPageRouteIdentity) {
  return (
    left.id === right.id &&
    left.cursor === right.cursor &&
    left.post === right.post &&
    left.slug === right.slug &&
    left.locale === right.locale &&
    left.credentialMode === right.credentialMode
  );
}

function sameSession(left: SessionStamp, right: SessionStamp) {
  return (
    left.revision === right.revision &&
    left.tuple === right.tuple &&
    left.status === right.status &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.errorUpdateCount === right.errorUpdateCount &&
    left.dataUpdatedAt === right.dataUpdatedAt &&
    left.errorUpdatedAt === right.errorUpdatedAt
  );
}

function sameQuery(left: QueryStamp | undefined, right: QueryStamp | undefined) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.query === right.query &&
    left.status === right.status &&
    left.data === right.data &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.errorUpdateCount === right.errorUpdateCount &&
    left.dataUpdatedAt === right.dataUpdatedAt &&
    left.errorUpdatedAt === right.errorUpdatedAt &&
    left.terminalRevision === right.terminalRevision
  );
}

function sessionCanRead(mode: ReadCredentialMode, session: SessionStamp) {
  return mode === 'anonymous' || (session.state === 'signed-in' && session.subject !== null);
}

type PageStamp = {
  sourceId: string;
  session: SessionStamp;
  identity: ThreadPageRouteIdentity;
  query: QueryStamp;
};
const pageStamps = new WeakMap<object, Map<string, PageStamp>>();
const visits = new WeakMap<QueryClient, Map<string, ThreadPageCaller>>();

function setPageStamp(client: QueryClient, queryKey: QueryKey, stamp: PageStamp) {
  const value = stamp.query.data;
  if (!value || typeof value !== 'object') return;
  let known = pageStamps.get(value);
  if (!known) {
    known = new Map();
    pageStamps.set(value, known);
  }
  known.set(keyId(queryKey), stamp);
}

export class ThreadPageCallerRetired extends Error {
  constructor() {
    super('Thread page caller retired');
    this.name = 'ThreadPageCallerRetired';
  }
}

function isThreadPageFor(queryKey: QueryKey, threadId: string) {
  return queryKey[0] === 'thread-page' && queryKey[1] === threadId;
}

function isRetiringQueryEvent(event: QueryCacheEvent) {
  return (
    event.type === 'removed' ||
    (event.type === 'updated' &&
      (event.action?.type === 'cancel' ||
        event.action?.type === 'error' ||
        event.action?.type === 'setState' ||
        event.action?.type === 'success'))
  );
}

function statesMatch(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    rightEntries.every(([key, value]) => Object.hasOwn(left, key) && Object.is(value, left[key]))
  );
}

function matchingKey(left: QueryKey, right: QueryKey) {
  return keyId(left) === keyId(right);
}

type Connection = { owner: object | null; connected: boolean; generation: number; retired: boolean };

/** One original route/query reader. It observes authority and cache state without starting reads of its own. */
export class ThreadPageCaller {
  private currentAdmission: ThreadPageAdmission;
  private readonly source: SessionSource;
  private readonly ownerSession: SessionStamp;
  private queryState: QueryStamp | null | undefined;
  private queryKey: QueryKey;
  private retirementQuery: QueryStamp | undefined;
  private externalQueryMutation: QueryCacheEvent | undefined;
  private ownedPageRead: OwnedPageRead | undefined;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private retired = false;
  private currentIdentity: ThreadPageRouteIdentity;
  private publicResult: boolean;
  private inFlightQuery: object | undefined;
  private queryStarted = false;
  private queryStartTerminalRevision = 0;
  private queryStartDataUpdateCount = 0;
  private queryOwnSuccessObserved = false;
  private releaseSource: (() => void) | undefined;
  private connection: Connection = { owner: null, connected: false, generation: 0, retired: false };
  private personalSequence = 0;
  private personalAttemptRevision = 0;
  private currentPageViewerId: string | null | undefined;
  private readonly refreshContinuations = new Set<RefreshContinuationState>();
  private readonly synchronousCacheBoundaries = new Set<RefreshCacheBoundary>();
  private refreshGuard: (() => boolean) | undefined;
  private readonly personalResults = new WeakMap<object, PersonalReadAttempt>();
  private readonly personalCacheOwners = new Map<string, PersonalCacheOwner>();

  private constructor(
    private readonly client: QueryClient,
    source: SessionSource,
    admission: ThreadPageAdmission,
    queryState?: QueryStamp | null,
    page?: LoadedThreadPage,
  ) {
    this.source = source;
    this.currentAdmission = admission;
    this.currentIdentity = admission.identity;
    this.publicResult = admission.publicRead;
    this.ownerSession = { ...admission.session };
    this.queryKey = admission.queryKey;
    this.queryState = queryState;
    this.setCurrentPage(page);
    this.releaseSource = source.subscribe((event) => {
      const refreshEvent = this.observeRefreshQueryEvent(event);
      const ownedResult = this.observeOwnedPageResultEvent(event);
      const currentKeyEvent = matchingKey(event.query.queryKey, this.queryKey);
      if (isRetiringQueryEvent(event) && (refreshEvent.external || (!refreshEvent.owned && !ownedResult))) {
        if (currentKeyEvent) this.externalQueryMutation = event;
        if (refreshEvent.external || currentKeyEvent) this.retire();
      }
      if (this.queryStarted && !this.inFlightQuery) this.inFlightQuery = this.source.queryStamp(this.queryKey)?.query;
      this.check();
      const personalChanged = !this.retired && this.observePersonalCache();
      // Observer option/result notifications can be emitted by rendering useQuery itself.
      // Only cache state changes should publish another public-reader snapshot.
      const cacheChanged = event.type === 'added' || event.type === 'updated' || event.type === 'removed';
      if (!this.retired && ((this.publicResult && cacheChanged) || personalChanged)) {
        this.notify();
      }
    });
  }

  get admission() {
    return this.currentAdmission;
  }

  private setCurrentPage(page: LoadedThreadPage | undefined) {
    const pageViewerId = page?.composed
      ? page.composed.viewer.kind === 'account'
        ? page.composed.viewer.id
        : null
      : page?.viewerId;
    if (this.currentPageViewerId !== pageViewerId) {
      this.currentPageViewerId = pageViewerId;
      this.personalAttemptRevision++;
    }
  }

  static capture(
    client: QueryClient,
    identity: ThreadPageRouteIdentity,
    expectedSlug: string | undefined,
    queryKey: QueryKey,
  ) {
    const source = sourceFor(client);
    const session = source.readSession();
    const admission: ThreadPageAdmission = {
      id: crypto.randomUUID(),
      sourceId: source.id,
      identity: { ...identity },
      ...(expectedSlug === undefined ? {} : { expectedSlug }),
      queryKey: [...queryKey],
      session,
      publicRead: identity.credentialMode === 'anonymous',
    };
    const caller = new ThreadPageCaller(client, source, admission);
    let byId = visits.get(client);
    if (!byId) {
      byId = new Map();
      visits.set(client, byId);
    }
    byId.set(admission.id, caller);
    return caller;
  }

  static bind(
    client: QueryClient,
    admission: ThreadPageAdmission,
    page: LoadedThreadPage,
    identity: ThreadPageRouteIdentity,
  ): ThreadPageCaller | undefined {
    const source = sourceFor(client);
    const existing = visits.get(client)?.get(admission.id);
    if (existing && existing.source.id === admission.sourceId) {
      existing.setRouteIdentity(identity);
      existing.setCurrentPage(page);
      return sameIdentity(admission.identity, identity) && !existing.retired ? existing : undefined;
    }
    if (!sameIdentity(admission.identity, identity)) return undefined;
    // SSR always starts these pages in anonymous mode. Public anonymous data can hydrate into any
    // browser session because the original read carried no credential. A private result cannot be
    // rebound to a different QueryClient: its original source revision has no browser equivalent.
    if (admission.sourceId !== source.id) {
      if (!admission.publicRead || page.viewerId !== undefined) return undefined;
      const hydrated: ThreadPageAdmission = {
        ...admission,
        sourceId: source.id,
        session: source.readSession(),
      };
      const queryState = source.queryStamp(admission.queryKey);
      const caller = new ThreadPageCaller(client, source, hydrated, queryState ?? null, page);
      return caller;
    }
    return undefined;
  }

  get clientSourceId() {
    return this.source.id;
  }

  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private retire(notify = true) {
    if (this.retired) return;
    this.retired = true;
    const abandonedRead = this.ownedPageRead;
    if (
      abandonedRead?.started &&
      abandonedRead.query &&
      (this.externalQueryMutation?.query === abandonedRead.query ||
        (!this.publicResult && !sameSession(this.ownerSession, this.source.readSession())))
    ) {
      const current = this.source.queryStamp(abandonedRead.queryKey);
      if (current !== undefined && current.query === abandonedRead.query && current.fetchStatus !== 'idle') {
        const query = abandonedRead.query as {
          cancel?: (options: { revert: boolean; silent: boolean }) => unknown;
        };
        query.cancel?.({ revert: false, silent: true });
      }
    }
    const refreshQueries = [...this.refreshContinuations]
      .map((continuation) => continuation.sourceQuery)
      .filter((query): query is QueryStamp => query !== undefined);
    for (const continuation of this.refreshContinuations) continuation.active = false;
    this.refreshContinuations.clear();
    this.connection.retired = true;
    this.connection.connected = false;
    this.connection.generation++;
    this.releaseSource?.();
    this.releaseSource = undefined;
    visits.get(this.client)?.delete(this.currentAdmission.id);
    const current = this.source.queryStamp(this.queryKey);
    const admittedQuery = this.queryState;
    const inFlightQuery = this.inFlightQuery;
    const admittedDataStillCurrent =
      admittedQuery !== undefined &&
      admittedQuery !== null &&
      current?.query === admittedQuery.query &&
      current.data === admittedQuery.data;
    this.queryStarted = false;
    this.inFlightQuery = undefined;
    this.ownedPageRead = undefined;
    const currentWasExternallyChanged = this.externalQueryMutation?.query === current?.query;
    if (
      !this.publicResult &&
      current &&
      !currentWasExternallyChanged &&
      (admittedDataStillCurrent ||
        (admittedQuery !== undefined && admittedQuery !== null && sameQuery(admittedQuery, current)) ||
        (this.retirementQuery !== undefined && sameQuery(this.retirementQuery, current)) ||
        refreshQueries.some((query) => sameQuery(query, current)) ||
        (inFlightQuery !== undefined && current.query === inFlightQuery))
    )
      this.client.removeQueries({ queryKey: this.queryKey, exact: true });
    this.clearPersonalCache();
    if (notify) this.notify();
  }

  private canJoinRefreshBoundary(owner: ThreadPageCaller, state: RefreshContinuationState) {
    return (
      !this.retired &&
      this.client === owner.client &&
      this.source === owner.source &&
      isThreadPageFor(this.queryKey, state.identity.id) &&
      sameIdentity(this.currentAdmission.identity, state.identity) &&
      sameIdentity(this.currentIdentity, state.identity) &&
      sameSession(this.currentAdmission.session, state.session) &&
      sameSession(this.source.readSession(), state.session) &&
      getLocale() === state.identity.locale &&
      (this !== owner ||
        !state.requiresConnection ||
        (this.connection.connected &&
          !this.connection.retired &&
          this.connection.owner === state.connectionOwner &&
          this.connection.generation === state.connectionGeneration))
    );
  }

  private runOwnedPreparationBoundary<T>(queryKey: QueryKey, operation: () => T) {
    const query = this.source.queryStamp(queryKey)?.query;
    const boundary: RefreshCacheBoundary = {
      kind: 'remove',
      queries: query ? new Set([query]) : new Set(),
      continuation: undefined,
      cancelEvents: new Map(),
      removeEvents: new Map(),
    };
    this.synchronousCacheBoundaries.add(boundary);
    try {
      return operation();
    } finally {
      this.synchronousCacheBoundaries.delete(boundary);
    }
  }

  retireFromRouteChange() {
    this.retire(false);
  }

  private clearPersonalCache() {
    for (const owner of this.personalCacheOwners.values()) {
      const personal = this.source.queryStamp(owner.queryKey);
      if (
        personal &&
        owner.query === personal.query &&
        (personal.fetchStatus === 'fetching' ||
          (owner.result !== undefined && personal.data === owner.result) ||
          (owner.initialData !== undefined && personal.data === owner.initialData))
      )
        this.client.removeQueries({ queryKey: owner.queryKey, exact: true });
    }
    this.personalCacheOwners.clear();
  }

  private observePersonalCache() {
    let changed = false;
    const session = this.source.readSession();
    for (const owner of this.personalCacheOwners.values()) {
      const personal = this.source.queryStamp(owner.queryKey);
      if (!owner.query && personal) owner.query = personal.query;
      const stale =
        owner.retired ||
        !sameSession(owner.session, session) ||
        this.source.queryTerminalRevision(owner.queryKey) !== owner.terminalRevision ||
        (owner.query !== undefined && personal !== undefined && owner.query !== personal.query);
      if (!stale) continue;
      if (!owner.retired) {
        owner.retired = true;
        this.personalAttemptRevision++;
        changed = true;
      }
      if (
        personal &&
        ((owner.query === personal.query && personal.fetchStatus === 'fetching') ||
          (owner.result !== undefined && personal.data === owner.result) ||
          (owner.initialData !== undefined && personal.data === owner.initialData))
      )
        this.client.removeQueries({ queryKey: owner.queryKey, exact: true });
    }
    return changed;
  }

  setRouteIdentity(identity: ThreadPageRouteIdentity) {
    this.currentIdentity = identity;
    if (!sameIdentity(this.currentAdmission.identity, identity)) this.retire(false);
  }

  private queryCurrent() {
    if (this.queryStarted) {
      if (this.source.queryTerminalRevision(this.queryKey) !== this.queryStartTerminalRevision) return false;
      const current = this.source.queryStamp(this.queryKey);
      if (this.inFlightQuery)
        return (
          current?.query === this.inFlightQuery &&
          current.dataUpdateCount === this.queryStartDataUpdateCount + (this.queryOwnSuccessObserved ? 1 : 0)
        );
      return current === undefined;
    }
    if (this.queryState === undefined) return true;
    const current = this.source.queryStamp(this.queryKey);
    if (this.queryState === null) return current === undefined;
    return sameQuery(this.queryState, current);
  }

  private authorityCurrent() {
    const session = this.source.readSession();
    return (
      sessionCanRead(this.currentAdmission.identity.credentialMode, session) && sameSession(this.ownerSession, session)
    );
  }

  private check() {
    if (this.retired) return;
    if (
      !sameIdentity(this.currentAdmission.identity, this.currentIdentity) ||
      getLocale() !== this.currentAdmission.identity.locale
    ) {
      this.retire();
      return;
    }
    if (!this.queryCurrent()) {
      this.retire();
      return;
    }
    if (!this.publicResult && !this.authorityCurrent()) this.retire();
  }

  private observeRefreshQueryEvent(event: QueryCacheEvent) {
    let owned = false;
    let external = false;
    const ownedContinuations = new Set<RefreshContinuationState>();
    for (const boundary of this.synchronousCacheBoundaries) {
      if (!this.ownsBoundaryEvent(boundary, event)) continue;
      owned = true;
      if (boundary.continuation?.active) ownedContinuations.add(boundary.continuation);
      if (matchingKey(event.query.queryKey, this.queryKey))
        this.queryState = this.source.queryStamp(this.queryKey) ?? null;
    }
    for (const continuation of this.refreshContinuations) {
      if (!continuation.active || !isThreadPageFor(event.query.queryKey, continuation.identity.id)) continue;
      if (ownedContinuations.has(continuation)) continue;
      if (this.isOwnedPageEvent(continuation.ownedPageRead, event)) {
        continuation.ownedPageRead!.commitObserved = true;
        owned = true;
        continue;
      }
      if (this.isOwnedPageFailure(continuation.ownedPageRead, event)) {
        continuation.ownedPageRead = undefined;
        owned = true;
        continue;
      }
      if (isRetiringQueryEvent(event)) {
        continuation.queryRetired = true;
        external = true;
      }
    }
    return { owned, external };
  }

  private ownsBoundaryEvent(boundary: RefreshCacheBoundary, event: QueryCacheEvent) {
    const query = event.query as object;
    if (!boundary.queries.has(query)) return false;
    if (boundary.kind === 'cancel') {
      if (event.type !== 'updated' || event.action?.type !== 'setState' || !this.source.isCancellationRevert(event))
        return false;
      const previous = boundary.cancelEvents.get(query);
      if (previous !== undefined) return previous === event;
      boundary.cancelEvents.set(query, event);
      return true;
    }
    if (event.type !== 'removed') return false;
    const previous = boundary.removeEvents.get(query);
    if (previous !== undefined) return previous === event;
    boundary.removeEvents.set(query, event);
    return true;
  }

  private isOwnedPageEvent(read: OwnedPageRead | undefined, event: QueryCacheEvent) {
    if (
      event.type !== 'updated' ||
      event.action?.type !== 'success' ||
      event.action.manual === true ||
      !read?.resultReady ||
      !read.commitReady ||
      read.commitObserved
    )
      return false;
    if (!matchingKey(event.query.queryKey, read.queryKey)) return false;
    const current = this.source.queryStamp(read.queryKey);
    if (!read.query && current) read.query = current.query;
    return (
      current?.query === event.query &&
      read.query === event.query &&
      current.data === event.action.data &&
      event.action.data === read.committedData &&
      current.dataUpdateCount === read.dataUpdateCount + 1 &&
      current.errorUpdateCount === read.errorUpdateCount
    );
  }

  private isOwnedPageFailure(read: OwnedPageRead | undefined, event: QueryCacheEvent) {
    if (
      event.type !== 'updated' ||
      event.action?.type !== 'error' ||
      !read?.started ||
      !read.errorReady ||
      event.action.error !== read.error
    )
      return false;
    if (!matchingKey(event.query.queryKey, read.queryKey)) return false;
    const current = this.source.queryStamp(read.queryKey);
    if (!read.query && current) read.query = current.query;
    return (
      current?.query === event.query &&
      read.query === event.query &&
      current.errorUpdateCount === read.errorUpdateCount + 1 &&
      current.dataUpdateCount === read.dataUpdateCount
    );
  }

  private observeOwnedPageResultEvent(event: QueryCacheEvent) {
    const read = this.ownedPageRead;
    if (!read) return false;
    if (this.isOwnedPageEvent(read, event)) {
      this.queryOwnSuccessObserved = true;
      read!.commitObserved = true;
      return true;
    }
    if (this.isOwnedPageFailure(read, event)) {
      this.ownedPageRead = undefined;
      return true;
    }
    return false;
  }

  snapshot = () => {
    this.check();
    return this.revision;
  };
  serverSnapshot = () => 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  connect(owner: object) {
    if (this.retired || this.connection.retired) return () => {};
    if (this.connection.owner && this.connection.owner !== owner) {
      this.retire();
      return () => {};
    }
    this.connection.owner = owner;
    this.connection.connected = true;
    const generation = ++this.connection.generation;
    this.notify();
    return () => {
      if (!this.connection.connected || this.connection.generation !== generation) return;
      this.connection.connected = false;
      const disconnectedAt = ++this.connection.generation;
      this.notify();
      queueMicrotask(() => {
        if (!this.connection.connected && this.connection.generation === disconnectedAt) this.retire();
      });
    };
  }

  get connectionTicket() {
    return this.connection.generation;
  }

  get sessionRevision() {
    return this.source.sessionRevision();
  }

  get personalRevision() {
    return this.personalAttemptRevision;
  }

  personalSessionReady() {
    const session = this.source.readSession();
    return (
      session.state === 'signed-in' &&
      session.subject !== null &&
      this.currentPageViewerId !== null &&
      (this.currentPageViewerId === undefined || this.currentPageViewerId === session.subject)
    );
  }

  isConnectedCurrent(ticket = this.connection.generation) {
    this.check();
    return (
      !this.retired && !this.connection.retired && this.connection.connected && ticket === this.connection.generation
    );
  }

  isDisclosureCurrent() {
    this.check();
    return !this.retired && !this.connection.retired && (this.publicResult || this.connection.connected);
  }

  isEffectCurrent(session = this.source.readSession(), ticket = this.connection.generation) {
    this.check();
    return (
      this.isConnectedCurrent(ticket) &&
      sameSession(session, this.source.readSession()) &&
      getLocale() === this.currentAdmission.identity.locale
    );
  }

  captureEffects() {
    return { session: this.source.readSession(), ticket: this.connection.generation };
  }

  assertReadCurrent() {
    this.check();
    if (
      this.retired ||
      (this.refreshGuard !== undefined && !this.refreshGuard()) ||
      !sessionCanRead(this.currentAdmission.identity.credentialMode, this.source.readSession())
    )
      throw new ThreadPageCallerRetired();
  }

  setRefreshGuard(guard: () => boolean) {
    this.refreshGuard = guard;
  }

  clearRefreshGuard() {
    this.refreshGuard = undefined;
  }

  async read<T>(work: () => Promise<T>) {
    this.assertReadCurrent();
    const value = await work();
    this.assertReadCurrent();
    return value;
  }

  prepareCachedQuery(queryKey: QueryKey) {
    this.assertReadCurrent();
    if (keyId(queryKey) !== keyId(this.currentAdmission.queryKey)) throw new ThreadPageCallerRetired();
    const cached = this.source.queryStamp(queryKey);
    if (!cached || cached.status !== 'success' || cached.data === undefined) return;
    const stamp =
      cached.data && typeof cached.data === 'object'
        ? pageStamps.get(cached.data as object)?.get(keyId(queryKey))
        : undefined;
    const currentSession = this.source.readSession();
    const reusable =
      stamp !== undefined &&
      stamp.sourceId === this.source.id &&
      sameIdentity(stamp.identity, this.currentAdmission.identity) &&
      sameSession(stamp.session, currentSession) &&
      sameQuery(stamp.query, cached);
    if (reusable) return;
    if (this.currentAdmission.identity.credentialMode === 'session') {
      this.runOwnedPreparationBoundary(queryKey, () => this.client.removeQueries({ queryKey, exact: true }));
      this.assertReadCurrent();
    }
  }

  finishQuery(queryKey: QueryKey, result: unknown, before: QueryStamp | undefined, beforeTerminalRevision: number) {
    this.assertReadCurrent();
    const current = this.source.queryStamp(queryKey);
    const ownedRead = this.ownedPageRead;
    const ownCommit =
      ownedRead?.resultReady === true &&
      ownedRead.result === result &&
      ownedRead.commitReady &&
      ownedRead.commitObserved &&
      current !== undefined &&
      ownedRead.query === current?.query &&
      current.data === ownedRead.committedData &&
      current.dataUpdateCount === ownedRead.dataUpdateCount + 1 &&
      current.errorUpdateCount === ownedRead.errorUpdateCount;
    const unchangedCacheHit =
      ownedRead?.resultReady !== true &&
      before !== undefined &&
      before.status === 'success' &&
      result === before.data &&
      current !== undefined &&
      current.query === before.query &&
      current.data === before.data &&
      current.dataUpdateCount === before.dataUpdateCount &&
      current.errorUpdateCount === before.errorUpdateCount &&
      before.terminalRevision === beforeTerminalRevision;
    if (
      !current ||
      current.status !== 'success' ||
      (!ownCommit && !unchangedCacheHit) ||
      (before && current.query !== before.query) ||
      current.terminalRevision !== beforeTerminalRevision ||
      (ownCommit && current.dataUpdateCount !== (before?.dataUpdateCount ?? 0) + 1)
    )
      throw new ThreadPageCallerRetired();
    const page = result && typeof result === 'object' && 'thread' in result ? (result as LoadedThreadPage) : undefined;
    if (
      page?.viewerId !== undefined &&
      (this.currentAdmission.identity.credentialMode !== 'session' || page.viewerId !== this.ownerSession.subject)
    ) {
      this.publicResult = false;
      throw new ThreadPageCallerRetired();
    }
    this.queryStarted = false;
    this.inFlightQuery = undefined;
    this.ownedPageRead = undefined;
    this.queryKey = queryKey;
    this.queryState = current;
    this.setCurrentPage(page);
    const publicRead =
      this.currentAdmission.identity.credentialMode === 'anonymous' && (!page || page.viewerId === undefined);
    const nextAdmission: ThreadPageAdmission = {
      ...this.currentAdmission,
      session: this.source.readSession(),
      queryKey: [...queryKey],
      publicRead,
    };
    this.currentAdmission = nextAdmission;
    this.publicResult = publicRead;
    setPageStamp(this.client, queryKey, {
      sourceId: this.source.id,
      session: this.source.readSession(),
      identity: this.currentAdmission.identity,
      query: current,
    });
  }

  beginQuery(queryKey: QueryKey) {
    this.assertReadCurrent();
    if (keyId(queryKey) !== keyId(this.currentAdmission.queryKey)) throw new ThreadPageCallerRetired();
    const query = this.source.queryStamp(queryKey);
    this.inFlightQuery = query?.query;
    this.queryStartTerminalRevision = this.source.queryTerminalRevision(queryKey);
    this.queryStartDataUpdateCount = query?.dataUpdateCount ?? 0;
    this.queryOwnSuccessObserved = false;
    this.queryStarted = true;
    this.ownedPageRead = {
      queryKey: [...queryKey],
      query: query?.query,
      dataUpdateCount: query?.dataUpdateCount ?? 0,
      errorUpdateCount: query?.errorUpdateCount ?? 0,
      result: undefined,
      committedData: undefined,
      error: undefined,
      started: false,
      resultReady: false,
      commitReady: false,
      commitObserved: false,
      errorReady: false,
    };
  }

  markOwnedPageReadStarted(queryKey: QueryKey) {
    if (!this.ownedPageRead || !matchingKey(queryKey, this.ownedPageRead.queryKey)) throw new ThreadPageCallerRetired();
    this.ownedPageRead.started = true;
    const query = this.source.queryStamp(queryKey);
    if (query && !this.ownedPageRead.query) this.ownedPageRead.query = query.query;
    if (query && this.ownedPageRead.query !== query.query) throw new ThreadPageCallerRetired();
  }

  recordOwnedPageResult(queryKey: QueryKey, value: unknown) {
    if (!this.ownedPageRead || !matchingKey(queryKey, this.ownedPageRead.queryKey) || value === undefined)
      throw new ThreadPageCallerRetired();
    const query = this.source.queryStamp(queryKey);
    if (query && !this.ownedPageRead.query) this.ownedPageRead.query = query.query;
    if (query && this.ownedPageRead.query !== query.query) throw new ThreadPageCallerRetired();
    this.ownedPageRead.result = value;
    this.ownedPageRead.resultReady = true;
  }

  recordOwnedPageCommit(queryKey: QueryKey, result: unknown, committedData: unknown) {
    const read = this.ownedPageRead;
    if (!read || !matchingKey(queryKey, read.queryKey) || !read.resultReady || read.result !== result) return;
    const query = this.source.queryStamp(queryKey);
    if (query && !read.query) read.query = query.query;
    if (query && read.query !== query.query) return;
    read.committedData = committedData;
    read.commitReady = true;
  }

  recordOwnedPageError(queryKey: QueryKey, error: unknown) {
    if (!this.ownedPageRead || !matchingKey(queryKey, this.ownedPageRead.queryKey)) return;
    this.ownedPageRead.error = error;
    this.ownedPageRead.errorReady = true;
  }

  failQuery() {
    this.queryStarted = false;
    this.inFlightQuery = undefined;
    this.ownedPageRead = undefined;
    this.retire();
  }

  observeQuery(query: QueryStamp | undefined) {
    this.retirementQuery = query;
  }

  beginPersonalRead(queryKey: QueryKey, target: string) {
    this.check();
    const identity = this.currentAdmission.identity;
    const targetKey = JSON.stringify([identity.id, identity.cursor ?? null, ...queryKey.slice(4)]);
    if (
      queryKey[0] !== 'thread-personal' ||
      queryKey[1] !== identity.id ||
      (queryKey[2] ?? null) !== (identity.cursor ?? null) ||
      typeof queryKey[3] !== 'boolean' ||
      targetKey !== target
    )
      throw new ThreadPageCallerRetired();
    const session = this.source.readSession();
    const pageViewerId =
      this.currentPageViewerId === undefined
        ? session.state === 'signed-in'
          ? session.subject
          : null
        : this.currentPageViewerId;
    const ticket = this.connection.generation;
    const query = this.source.queryStamp(queryKey);
    const owner: PersonalCacheOwner = {
      queryKey: [...queryKey],
      query: query?.query,
      result: undefined,
      initialData: query?.data && typeof query.data === 'object' ? query.data : undefined,
      session,
      terminalRevision: this.source.queryTerminalRevision(queryKey),
      retired: false,
    };
    this.personalCacheOwners.set(keyId(queryKey), owner);
    return {
      id: ++this.personalSequence,
      idValue: identity.id,
      pageViewerId,
      ...(identity.cursor === undefined ? {} : { cursor: identity.cursor }),
      queryKey: [...queryKey],
      target,
      session,
      ticket,
      query,
      terminalRevision: this.source.queryTerminalRevision(queryKey),
      owner,
    } satisfies PersonalReadAttempt;
  }

  async readPersonal<T extends object>(attempt: PersonalReadAttempt, work: () => Promise<T> | T): Promise<T> {
    if (!this.personalCurrent(attempt)) throw new ThreadPageCallerRetired();
    attempt.owner.query = this.source.queryStamp(attempt.queryKey)?.query ?? attempt.owner.query;
    const value = await work();
    if (!this.personalCurrent(attempt)) throw new ThreadPageCallerRetired();
    this.personalResults.set(value, attempt);
    attempt.owner.result = value;
    return value;
  }

  selectPersonal<T extends object>(value: T | undefined, attempt: PersonalReadAttempt) {
    if (!value || this.personalResults.get(value) !== attempt || !this.personalCurrent(attempt)) return undefined;
    const query = this.source.queryStamp(attempt.queryKey);
    if (
      !query ||
      query.status !== 'success' ||
      query.data !== value ||
      query.terminalRevision !== attempt.terminalRevision ||
      query.dataUpdateCount <= (attempt.query?.dataUpdateCount ?? 0) ||
      query.query !== attempt.owner.query ||
      (attempt.query &&
        (query.query !== attempt.query.query || query.errorUpdateCount !== attempt.query.errorUpdateCount))
    )
      return undefined;
    const viewerId = 'viewerId' in value && typeof value.viewerId === 'string' ? value.viewerId : null;
    const session = this.source.readSession();
    const pageViewerId = this.currentPageViewerId === undefined ? session.subject : this.currentPageViewerId;
    if (
      session.state !== 'signed-in' ||
      !session.subject ||
      viewerId !== session.subject ||
      viewerId !== attempt.pageViewerId ||
      pageViewerId !== attempt.pageViewerId
    )
      return undefined;
    return value;
  }

  isEffectTicketCurrent(ticket: { session: SessionStamp; ticket: number }) {
    return this.isEffectCurrent(ticket.session, ticket.ticket);
  }

  /** A read continuation remains bound to its caller, source, session, and mounted owner. */
  isRefreshContinuationCurrent(ticket: { session: SessionStamp; ticket?: number }) {
    this.check();
    return (
      !this.retired &&
      sameIdentity(this.currentAdmission.identity, this.currentIdentity) &&
      sameSession(ticket.session, this.source.readSession()) &&
      getLocale() === this.currentAdmission.identity.locale &&
      (ticket.ticket === undefined ||
        (this.connection.connected && !this.connection.retired && this.connection.generation === ticket.ticket)) &&
      (this.refreshGuard === undefined || this.refreshGuard())
    );
  }

  /** Admit a refresh from this mounted caller and distinguish its own cache boundaries from external retirement. */
  beginRefreshContinuation(ticket: { session: SessionStamp; ticket?: number }): ThreadPageRefreshContinuation {
    this.check();
    if (
      ticket.ticket === undefined
        ? this.retired || !sameSession(ticket.session, this.source.readSession())
        : !this.isEffectTicketCurrent({ session: ticket.session, ticket: ticket.ticket }) || !this.connection.owner
    )
      throw new ThreadPageCallerRetired();
    const state: RefreshContinuationState = {
      active: true,
      identity: { ...this.currentAdmission.identity },
      session: { ...ticket.session },
      connectionOwner: this.connection.owner ?? this,
      connectionGeneration: ticket.ticket ?? this.connection.generation,
      requiresConnection: ticket.ticket !== undefined,
      queryRetired: false,
      sourceQuery: this.source.queryStamp(this.queryKey),
      ownedPageRead: undefined,
    };
    this.refreshContinuations.add(state);
    const remove = () => this.refreshContinuations.delete(state);
    return {
      client: this.client,
      sourceId: this.source.id,
      isCurrent: () => {
        this.check();
        return (
          state.active &&
          !this.retired &&
          (!state.requiresConnection ||
            (this.connection.connected &&
              !this.connection.retired &&
              this.connection.owner === state.connectionOwner &&
              this.connection.generation === state.connectionGeneration)) &&
          sameIdentity(state.identity, this.currentAdmission.identity) &&
          sameIdentity(state.identity, this.currentIdentity) &&
          sameSession(state.session, this.source.readSession()) &&
          getLocale() === state.identity.locale &&
          !state.queryRetired
        );
      },
      runOwnedCacheBoundary: <T,>(
        kind: 'cancel' | 'remove',
        operation: () => T,
        peers: readonly ThreadPageCaller[] = [],
      ) => {
        if (!state.active) throw new ThreadPageCallerRetired();
        const participants = [...new Set([this, ...peers])];
        if (
          !this.isRefreshContinuationCurrent({
            session: state.session,
            ...(state.requiresConnection ? { ticket: state.connectionGeneration } : {}),
          }) ||
          participants.some((participant) => !participant.canJoinRefreshBoundary(this, state))
        )
          throw new ThreadPageCallerRetired();
        const queries = new Set(
          this.client
            .getQueryCache()
            .findAll({ queryKey: ['thread-page', state.identity.id] })
            .map((query) => query as object),
        );
        const boundary: RefreshCacheBoundary = {
          kind,
          queries,
          continuation: state,
          cancelEvents: new Map(),
          removeEvents: new Map(),
        };
        for (const participant of participants) participant.synchronousCacheBoundaries.add(boundary);
        try {
          return operation();
        } finally {
          for (const participant of participants) participant.synchronousCacheBoundaries.delete(boundary);
        }
      },
      beginOwnedPageRead: (queryKey) => {
        if (!state.active || state.queryRetired) throw new ThreadPageCallerRetired();
        const query = this.source.queryStamp(queryKey);
        state.ownedPageRead = {
          queryKey: [...queryKey],
          query: query?.query,
          dataUpdateCount: query?.dataUpdateCount ?? 0,
          errorUpdateCount: query?.errorUpdateCount ?? 0,
          result: undefined,
          committedData: undefined,
          error: undefined,
          started: false,
          resultReady: false,
          commitReady: false,
          commitObserved: false,
          errorReady: false,
        };
      },
      markOwnedPageReadStarted: (queryKey) => {
        const read = state.ownedPageRead;
        if (!state.active || !read || !matchingKey(queryKey, read.queryKey)) throw new ThreadPageCallerRetired();
        read.started = true;
        const query = this.source.queryStamp(queryKey);
        if (query && !read.query) read.query = query.query;
        if (query && read.query !== query.query) throw new ThreadPageCallerRetired();
      },
      recordOwnedPageResult: (queryKey, value) => {
        const read = state.ownedPageRead;
        if (!state.active || !read || !matchingKey(queryKey, read.queryKey) || value === undefined)
          throw new ThreadPageCallerRetired();
        const query = this.source.queryStamp(queryKey);
        if (query && !read.query) read.query = query.query;
        if (query && read.query !== query.query) throw new ThreadPageCallerRetired();
        read.result = value;
        read.resultReady = true;
      },
      recordOwnedPageCommit: (queryKey, result, committedData) => {
        const read = state.ownedPageRead;
        if (
          !state.active ||
          !read ||
          !matchingKey(queryKey, read.queryKey) ||
          !read.resultReady ||
          read.result !== result
        )
          return;
        const query = this.source.queryStamp(queryKey);
        if (query && !read.query) read.query = query.query;
        if (query && read.query !== query.query) return;
        read.committedData = committedData;
        read.commitReady = true;
      },
      recordOwnedPageError: (queryKey, error) => {
        const read = state.ownedPageRead;
        if (!state.active || !read || !matchingKey(queryKey, read.queryKey)) return;
        read.error = error;
        read.errorReady = true;
      },
      handoffQueryAuthority: (preserveCaller = false) => {
        if (preserveCaller) {
          this.queryState = undefined;
          this.queryStarted = false;
          this.inFlightQuery = undefined;
          this.ownedPageRead = undefined;
        }
      },
      invalidate: () => {
        if (!state.active) return;
        state.active = false;
        remove();
      },
      release: () => {
        if (!state.active) return;
        state.active = false;
        remove();
        this.check();
      },
    };
  }

  private personalCurrent(attempt: PersonalReadAttempt) {
    this.check();
    const session = this.source.readSession();
    return (
      !this.retired &&
      !this.connection.retired &&
      this.connection.connected &&
      !attempt.owner.retired &&
      this.personalCacheOwners.get(keyId(attempt.queryKey)) === attempt.owner &&
      this.source.queryTerminalRevision(attempt.queryKey) === attempt.terminalRevision &&
      this.connection.generation === attempt.ticket &&
      this.personalSequence === attempt.id &&
      this.currentAdmission.identity.id === attempt.idValue &&
      this.currentAdmission.identity.cursor === attempt.cursor &&
      this.currentPageViewerId !== null &&
      (this.currentPageViewerId === undefined ? session.subject : this.currentPageViewerId) === attempt.pageViewerId &&
      attempt.pageViewerId === session.subject &&
      sessionCanRead('session', session) &&
      sameSession(attempt.session, session) &&
      getLocale() === this.currentAdmission.identity.locale
    );
  }
}

type PersonalReadAttempt = {
  id: number;
  idValue: string;
  pageViewerId: string | null;
  cursor?: string;
  terminalRevision: number;
  queryKey: QueryKey;
  target: string;
  session: SessionStamp;
  ticket: number;
  query: QueryStamp | undefined;
  owner: PersonalCacheOwner;
};

type PersonalCacheOwner = {
  queryKey: QueryKey;
  query: object | undefined;
  result: object | undefined;
  initialData: object | undefined;
  session: SessionStamp;
  terminalRevision: number;
  retired: boolean;
};

export async function runThreadPageQuery<T extends { queryKey: QueryKey }, TResult>(
  client: QueryClient,
  caller: ThreadPageCaller,
  query: T,
  read: (guarded: T) => Promise<TResult>,
  continuation?: ThreadPageRefreshContinuation,
) {
  caller.prepareCachedQuery(query.queryKey);
  const source = sourceFor(client);
  const before = source.queryStamp(query.queryKey);
  caller.observeQuery(before);
  const beforeTerminalRevision = source.queryTerminalRevision(query.queryKey);
  const original = (query as T & { queryFn?: unknown }).queryFn;
  if (typeof original !== 'function') throw new Error('Thread page query has no reader');
  const configuredSharing = client.defaultQueryOptions(query as never).structuralSharing;
  caller.beginQuery(query.queryKey);
  continuation?.beginOwnedPageRead(query.queryKey);
  const guarded = {
    ...query,
    structuralSharing: (previous: unknown | undefined, next: unknown) => {
      const committed =
        configuredSharing === false
          ? next
          : typeof configuredSharing === 'function'
            ? configuredSharing(previous, next)
            : replaceEqualDeep(previous, next);
      caller.recordOwnedPageCommit(query.queryKey, next, committed);
      continuation?.recordOwnedPageCommit(query.queryKey, next, committed);
      return committed;
    },
    queryFn: async (context: unknown) => {
      caller.assertReadCurrent();
      caller.markOwnedPageReadStarted(query.queryKey);
      continuation?.markOwnedPageReadStarted(query.queryKey);
      let value: unknown;
      try {
        value = await (original as (context: unknown) => unknown)(context);
      } catch (error) {
        caller.recordOwnedPageError(query.queryKey, error);
        continuation?.recordOwnedPageError(query.queryKey, error);
        throw error;
      }
      caller.assertReadCurrent();
      caller.recordOwnedPageResult(query.queryKey, value);
      continuation?.recordOwnedPageResult(query.queryKey, value);
      return value;
    },
  } as T;
  try {
    const result = await caller.read(() => read(guarded));
    caller.finishQuery(query.queryKey, result, before, beforeTerminalRevision);
    return result;
  } catch (error) {
    caller.failQuery();
    throw error;
  }
}

export function useThreadPageCaller(
  admission: ThreadPageAdmission,
  page: LoadedThreadPage,
  identity: ThreadPageRouteIdentity,
) {
  const client = useContext(QueryClientContext);
  const caller = useMemo(
    () => (client ? ThreadPageCaller.bind(client, admission, page, identity) : undefined),
    [
      client,
      admission,
      page,
      identity.id,
      identity.cursor,
      identity.post,
      identity.slug,
      identity.locale,
      identity.credentialMode,
    ],
  );
  const previousCaller = useRef<ThreadPageCaller | undefined>(undefined);
  if (previousCaller.current && previousCaller.current !== caller) previousCaller.current.retireFromRouteChange();
  previousCaller.current = caller;
  caller?.setRouteIdentity(identity);
  const owner = useRef<object | null>(null);
  owner.current ??= {};
  const subscribe = useMemo(() => (notify: () => void) => caller?.subscribe(notify) ?? (() => {}), [caller]);
  const snapshot = useMemo(() => caller?.snapshot ?? (() => 0), [caller]);
  const serverSnapshot = useMemo(() => caller?.serverSnapshot ?? (() => 0), [caller]);
  useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useLayoutEffect(() => (caller ? caller.connect(owner.current!) : undefined), [caller]);
  const current = caller?.isDisclosureCurrent() === true;
  return { caller, current, hydrationConflict: !caller && admission.sourceId !== undefined };
}
