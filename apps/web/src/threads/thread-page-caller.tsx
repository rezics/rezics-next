import { QueryClientContext, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
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
  const listeners = new Set<() => void>();
  const initial = sessionCache(client);
  let previousSession = JSON.stringify(initial);
  client.getQueryCache().subscribe((event) => {
    observationRevision++;
    const { query, type } = event;
    if (keyId(query.queryKey) === keyId(sessionQuery.queryKey)) {
      const next = JSON.stringify(sessionCache(client));
      const action = type === 'updated' ? event.action.type : undefined;
      const authorityEvent =
        type === 'added' ||
        type === 'removed' ||
        action === 'success' ||
        action === 'error' ||
        action === 'setState';
      if (authorityEvent || next !== previousSession) {
        sessionRevision++;
        previousSession = next;
      }
    }
    const terminalEvent =
      type === 'removed' ||
      (type === 'updated' && (event.action.type === 'error' || event.action.type === 'setState'));
    if (terminalEvent) {
      const id = keyId(query.queryKey);
      terminalRevisions.set(id, (terminalRevisions.get(id) ?? 0) + 1);
    }
    for (const listener of listeners) listener();
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
    subscribe(listener: () => void) {
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
    left.fetchStatus === right.fetchStatus &&
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

type Connection = { owner: object | null; connected: boolean; generation: number; retired: boolean };

/** One original route/query reader. It observes authority and cache state without starting reads of its own. */
export class ThreadPageCaller {
  private currentAdmission: ThreadPageAdmission;
  private readonly source: SessionSource;
  private readonly ownerSession: SessionStamp;
  private queryState: QueryStamp | null | undefined;
  private queryKey: QueryKey;
  private retirementQuery: QueryStamp | undefined;
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private retired = false;
  private currentIdentity: ThreadPageRouteIdentity;
  private publicResult: boolean;
  private inFlightQuery: object | undefined;
  private queryStarted = false;
  private queryStartTerminalRevision = 0;
  private releaseSource: (() => void) | undefined;
  private connection: Connection = { owner: null, connected: false, generation: 0, retired: false };
  private personalSequence = 0;
  private personalAttemptRevision = 0;
  private readonly personalResults = new WeakMap<object, PersonalReadAttempt>();
  private readonly personalCacheOwners = new Map<string, PersonalCacheOwner>();

  private constructor(
    private readonly client: QueryClient,
    source: SessionSource,
    admission: ThreadPageAdmission,
    queryState?: QueryStamp | null,
  ) {
    this.source = source;
    this.currentAdmission = admission;
    this.currentIdentity = admission.identity;
    this.publicResult = admission.publicRead;
    this.ownerSession = { ...admission.session };
    this.queryKey = admission.queryKey;
    this.queryState = queryState;
    this.releaseSource = source.subscribe(() => {
      if (this.queryStarted && !this.inFlightQuery)
        this.inFlightQuery = this.source.queryStamp(this.queryKey)?.query;
      this.check();
      const personalChanged = !this.retired && this.observePersonalCache();
      if (!this.retired && (this.publicResult || personalChanged)) {
        this.notify();
      }
    });
  }

  get admission() {
    return this.currentAdmission;
  }

  static capture(client: QueryClient, identity: ThreadPageRouteIdentity, expectedSlug: string | undefined, queryKey: QueryKey) {
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
      const caller = new ThreadPageCaller(client, source, hydrated, queryState ?? null);
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
    if (
      !this.publicResult &&
      current &&
      (admittedDataStillCurrent ||
        (admittedQuery !== undefined && admittedQuery !== null && sameQuery(admittedQuery, current)) ||
        (this.retirementQuery !== undefined && sameQuery(this.retirementQuery, current)) ||
        (inFlightQuery !== undefined && current.query === inFlightQuery))
    )
      this.client.removeQueries({ queryKey: this.queryKey, exact: true });
    this.clearPersonalCache();
    if (notify) this.notify();
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
      if (this.inFlightQuery) return current?.query === this.inFlightQuery;
      return current === undefined;
    }
    if (this.queryState === undefined) return true;
    const current = this.source.queryStamp(this.queryKey);
    if (this.queryState === null) return current === undefined;
    return sameQuery(this.queryState, current);
  }

  private authorityCurrent() {
    const session = this.source.readSession();
    return sessionCanRead(this.currentAdmission.identity.credentialMode, session) && sameSession(this.ownerSession, session);
  }

  private check() {
    if (this.retired) return;
    if (
      !sameIdentity(this.currentAdmission.identity, this.currentIdentity) ||
      getLocale() !== this.currentAdmission.identity.locale ||
      !this.queryCurrent()
    ) {
      this.retire();
      return;
    }
    if (!this.publicResult && !this.authorityCurrent()) this.retire();
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
    return session.state === 'signed-in' && session.subject !== null;
  }

  isConnectedCurrent(ticket = this.connection.generation) {
    this.check();
    return (
      !this.retired &&
      !this.connection.retired &&
      this.connection.connected &&
      ticket === this.connection.generation
    );
  }

  isDisclosureCurrent() {
    this.check();
    return (
      !this.retired &&
      !this.connection.retired &&
      (this.publicResult || this.connection.connected)
    );
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
    if (this.retired || !sessionCanRead(this.currentAdmission.identity.credentialMode, this.source.readSession()))
      throw new ThreadPageCallerRetired();
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
      this.client.removeQueries({ queryKey, exact: true });
      this.assertReadCurrent();
    }
  }

  finishQuery(
    queryKey: QueryKey,
    result: unknown,
    before: QueryStamp | undefined,
    beforeTerminalRevision: number,
  ) {
    this.assertReadCurrent();
    const current = this.source.queryStamp(queryKey);
    if (
      !current ||
      current.status !== 'success' ||
      current.data !== result ||
      (before && current.query !== before.query) ||
      current.terminalRevision !== beforeTerminalRevision ||
      current.dataUpdateCount > (before?.dataUpdateCount ?? 0) + 1
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
    this.queryKey = queryKey;
    this.queryState = current;
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
    this.inFlightQuery = this.source.queryStamp(queryKey)?.query;
    this.queryStartTerminalRevision = this.source.queryTerminalRevision(queryKey);
    this.queryStarted = true;
  }

  failQuery() {
    this.queryStarted = false;
    this.inFlightQuery = undefined;
    this.retire();
  }

  observeQuery(query: QueryStamp | undefined) {
    this.retirementQuery = query;
  }

  beginPersonalRead(queryKey: QueryKey, target: string) {
    this.check();
    const identity = this.currentAdmission.identity;
    const targetKey = JSON.stringify([identity.id, identity.cursor ?? null, ...queryKey.slice(3)]);
    if (
      queryKey[0] !== 'thread-personal' ||
      queryKey[1] !== identity.id ||
      (queryKey[2] ?? null) !== (identity.cursor ?? null) ||
      targetKey !== target
    )
      throw new ThreadPageCallerRetired();
    const session = this.source.readSession();
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
        (query.query !== attempt.query.query ||
          query.errorUpdateCount !== attempt.query.errorUpdateCount))
    )
      return undefined;
    const viewerId = 'viewerId' in value && typeof value.viewerId === 'string' ? value.viewerId : null;
    const session = this.source.readSession();
    if (session.state !== 'signed-in' || !session.subject || viewerId !== session.subject) return undefined;
    return value;
  }

  isEffectTicketCurrent(ticket: { session: SessionStamp; ticket: number }) {
    return this.isEffectCurrent(ticket.session, ticket.ticket);
  }

  /** A refresh already admitted before its own cache cancellation may finish only under the same route/session. */
  isRefreshContinuationCurrent(ticket: { session: SessionStamp }) {
    return (
      sameIdentity(this.currentAdmission.identity, this.currentIdentity) &&
      sameSession(ticket.session, this.source.readSession()) &&
      getLocale() === this.currentAdmission.identity.locale
    );
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
      sessionCanRead('session', session) &&
      sameSession(attempt.session, session) &&
      getLocale() === this.currentAdmission.identity.locale
    );
  }
}

type PersonalReadAttempt = {
  id: number;
  idValue: string;
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
) {
  caller.prepareCachedQuery(query.queryKey);
  const source = sourceFor(client);
  const before = source.queryStamp(query.queryKey);
  caller.observeQuery(before);
  const beforeTerminalRevision = source.queryTerminalRevision(query.queryKey);
  const original = (query as T & { queryFn?: unknown }).queryFn;
  if (typeof original !== 'function') throw new Error('Thread page query has no reader');
  caller.beginQuery(query.queryKey);
  const guarded = {
    ...query,
    queryFn: async (context: unknown) => {
      caller.assertReadCurrent();
      const value = await (original as (context: unknown) => unknown)(context);
      caller.assertReadCurrent();
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
    [client, admission, page, identity.id, identity.cursor, identity.slug, identity.locale, identity.credentialMode],
  );
  const previousCaller = useRef<ThreadPageCaller | undefined>(undefined);
  if (previousCaller.current && previousCaller.current !== caller)
    previousCaller.current.retireFromRouteChange();
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
