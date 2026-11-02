import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { personalRead } from '../kernel/query';
import type { MyRealmsPage, MyRealmsReaderOrigin } from './space';
import { MyRealmsPageView } from './my-realms-page';
import { myRealmsQuery } from './realm-membership-queries';

const sessionKey = ['session'] as const;
const target = '/realms';
const browserHydration = { subscribe: () => () => {}, getSnapshot: () => true, getServerSnapshot: () => false };

type SessionSnapshot = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
};

type SessionCacheRevision = {
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

type RealmCacheRevision = {
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

export type MyRealmsVisit = {
  id: string;
  target: typeof target;
  cursor: string | null;
  locale: string;
  credentialMode: ReadCredentialMode;
  session: { state: string; subject: string | null; ready: boolean; csrfFingerprint: string };
  sessionCacheRevision: SessionCacheRevision;
  sourceRevision: number;
  sourceCacheRevision: RealmCacheRevision | null;
  resultCacheRevision?: RealmCacheRevision;
  readerOrigin?: MyRealmsReaderOrigin;
};

type CacheQuery = object;

type TaggedPage = { callerId: string; sourceRevision: number; query: CacheQuery };
type ContinuationFocus = { callerId: string; cursor: string };
const taggedPages = new WeakMap<object, TaggedPage>();
const retiredVisits = new WeakSet<object>();
const sessions = new WeakMap<QueryClient, MyRealmsSessionSource>();

function sessionFrom(client: QueryClient): SessionSnapshot | null {
  const value = client.getQueryData<Partial<SessionSnapshot>>(sessionKey);
  if (!value || typeof value.state !== 'string') return null;
  return {
    state: value.state,
    subject: typeof value.subject === 'string' ? value.subject : null,
    csrfToken: typeof value.csrfToken === 'string' ? value.csrfToken : null,
  };
}

function sessionCacheRevision(client: QueryClient): SessionCacheRevision {
  const state = client.getQueryState(sessionKey);
  return { dataUpdateCount: state?.dataUpdateCount ?? 0, dataUpdatedAt: state?.dataUpdatedAt ?? 0 };
}

function realmCacheRevision(client: QueryClient, cursor?: string): RealmCacheRevision | null {
  const state = client.getQueryState<MyRealmsPage>(['my-realms', cursor ?? '']);
  return state ? { dataUpdateCount: state.dataUpdateCount, dataUpdatedAt: state.dataUpdatedAt } : null;
}

function sameSession(left: SessionSnapshot | null, right: SessionSnapshot | null): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.state === right.state &&
      left.subject === right.subject &&
      left.csrfToken === right.csrfToken)
  );
}

function isReady(session: SessionSnapshot | null): session is SessionSnapshot & { subject: string } {
  return session?.state === 'signed-in' && typeof session.subject === 'string' && session.subject.length > 0;
}

function fingerprint(token: string | null): Promise<string> {
  const value = token === null ? 'null\u0000' : `token\u0000${token}`;
  return globalThis.crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then((digest) => [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''));
}

function sameVisit(left: MyRealmsVisit, right: MyRealmsVisit): boolean {
  return (
    left.id === right.id &&
    left.target === right.target &&
    left.cursor === right.cursor &&
    left.locale === right.locale &&
    left.credentialMode === right.credentialMode &&
    left.session.state === right.session.state &&
    left.session.subject === right.session.subject &&
    left.session.ready === right.session.ready &&
    left.session.csrfFingerprint === right.session.csrfFingerprint &&
    left.sessionCacheRevision.dataUpdateCount === right.sessionCacheRevision.dataUpdateCount &&
    left.sessionCacheRevision.dataUpdatedAt === right.sessionCacheRevision.dataUpdatedAt &&
    left.sourceRevision === right.sourceRevision &&
    left.sourceCacheRevision?.dataUpdateCount === right.sourceCacheRevision?.dataUpdateCount &&
    left.sourceCacheRevision?.dataUpdatedAt === right.sourceCacheRevision?.dataUpdatedAt &&
    sameReaderOrigin(left.readerOrigin, right.readerOrigin)
  );
}

function sameReaderOrigin(left: MyRealmsReaderOrigin | undefined, right: MyRealmsReaderOrigin | undefined): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  return (
    left.kind !== 'session' ||
    (right.kind === 'session' && left.subject === right.subject && left.csrfFingerprint === right.csrfFingerprint)
  );
}

function originMatchesVisit(origin: MyRealmsReaderOrigin | undefined, visit: MyRealmsVisit): boolean {
  return (
    visit.session.ready &&
    !!origin &&
    origin.kind === 'session' &&
    origin.subject === visit.session.subject &&
    origin.csrfFingerprint === visit.session.csrfFingerprint
  );
}

function myRealmsRouteKey(visit: MyRealmsVisit): string {
  return JSON.stringify([visit.target, visit.cursor, visit.locale, visit.credentialMode]);
}

function sameRealmCacheRevision(left: RealmCacheRevision | undefined, right: RealmCacheRevision | undefined) {
  return (
    !!left && !!right && left.dataUpdateCount === right.dataUpdateCount && left.dataUpdatedAt === right.dataUpdatedAt
  );
}

class MyRealmsSessionSource {
  private snapshot: SessionSnapshot | null;
  private cacheRevision: SessionCacheRevision;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly visits = new Map<string, MyRealmsCaller>();
  private active: MyRealmsCaller | null = null;
  private hasVisited = false;
  private visitGeneration = 0;
  private continuationFocus: ContinuationFocus | null = null;

  constructor(readonly client: QueryClient) {
    this.snapshot = sessionFrom(client);
    this.cacheRevision = sessionCacheRevision(client);
    client.getQueryCache().subscribe((event) => {
      const { query } = event;
      if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionKey[0]) return;
      if (
        event.type !== 'removed' &&
        !(event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
      )
        return;
      const nextSession = sessionFrom(client);
      const nextRevision = sessionCacheRevision(client);
      this.snapshot = nextSession;
      this.cacheRevision = nextRevision;
      this.revision++;
      this.active?.retire();
      this.notify();
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = () => this.revision;

  publish() {
    this.notify();
  }

  read() {
    return {
      session: this.snapshot,
      cacheRevision: this.cacheRevision,
      sourceRevision: this.revision,
    };
  }

  retireActive(preserveCache = false) {
    this.active?.retire(preserveCache);
  }

  beginVisit(preserveCache = false) {
    this.visitGeneration++;
    this.active?.retire(preserveCache);
    return this.visitGeneration;
  }

  requestContinuationFocus(caller: MyRealmsCaller, cursor: string) {
    if (!cursor || !caller.isCurrent()) return false;
    this.continuationFocus = { callerId: caller.visit.id, cursor };
    return true;
  }

  takeContinuationFocus(cursor?: string) {
    const requested = this.continuationFocus;
    this.continuationFocus = null;
    const caller = this.active;
    return !!(
      requested &&
      requested.cursor === cursor &&
      caller?.visit.id === requested.callerId &&
      caller.isCurrent()
    );
  }

  currentVisitGeneration() {
    return this.visitGeneration;
  }

  isVisitGenerationCurrent(generation: number) {
    return this.visitGeneration === generation;
  }

  ownsVisitGeneration(caller: MyRealmsCaller) {
    return this.visitGeneration === caller.capturedVisitGeneration();
  }

  current(caller: MyRealmsCaller) {
    const captured = caller.capturedSession();
    return (
      this.active === caller &&
      caller.isActive() &&
      this.ownsVisitGeneration(caller) &&
      this.revision === caller.localRevision() &&
      sameSession(this.snapshot, captured) &&
      this.cacheRevision.dataUpdateCount === caller.localCacheRevision().dataUpdateCount &&
      this.cacheRevision.dataUpdatedAt === caller.localCacheRevision().dataUpdatedAt
    );
  }

  activate(caller: MyRealmsCaller, preserveCache = false) {
    if (!this.ownsVisitGeneration(caller)) return false;
    this.active?.retire(preserveCache);
    this.active = caller;
    this.hasVisited = true;
    this.visits.set(caller.visit.id, caller);
    return true;
  }

  adopt(caller: MyRealmsCaller) {
    if (!this.ownsVisitGeneration(caller)) return false;
    this.active?.retire();
    this.active = caller;
    this.hasVisited = true;
    this.visits.set(caller.visit.id, caller);
    return true;
  }

  lookup(id: string) {
    return this.visits.get(id);
  }

  hasPriorVisit() {
    return this.hasVisited;
  }

  remove(caller: MyRealmsCaller) {
    if (this.active === caller) this.active = null;
    if (this.continuationFocus?.callerId === caller.visit.id) this.continuationFocus = null;
    this.visits.delete(caller.visit.id);
  }

  clearRealmCache(cursor?: string, expected?: CacheQuery) {
    const key = ['my-realms', cursor ?? ''] as const;
    const query = this.client.getQueryCache().find({ queryKey: key, exact: true });
    if (expected && query !== expected) return;
    if (!query) return;
    const filters = expected
      ? { queryKey: key, exact: true, predicate: (candidate: unknown) => candidate === expected }
      : { queryKey: key, exact: true };
    void this.client.cancelQueries(filters as never);
    this.client.removeQueries(filters as never);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }
}

function sourceFor(client: QueryClient): MyRealmsSessionSource {
  let source = sessions.get(client);
  if (!source) {
    source = new MyRealmsSessionSource(client);
    sessions.set(client, source);
  }
  return source;
}

export class MyRealmsCaller {
  readonly subscribe: MyRealmsSessionSource['subscribe'];
  readonly getRevision: MyRealmsSessionSource['getRevision'];
  private readonly session: SessionSnapshot | null;
  private readonly localSessionCacheRevision: SessionCacheRevision;
  private active = true;
  private adopted = false;
  private hydrationVerified = true;
  private hydrationPending = false;
  private hydrationVerificationConnection: number | undefined;
  private hydrationVerificationAttempt = 0;
  private attached = false;
  private wasAttached = false;
  private connectionEpoch = 0;
  private ownedQuery: CacheQuery | null = null;
  private stopReadWatching: (() => void) | undefined;
  private readDataUpdateCount = -1;
  private acceptedQueryUpdateCount: number | undefined;
  private publishedCacheRevision: RealmCacheRevision | undefined;
  private readonly localSourceRevision: number;
  private readonly localVisitGeneration: number;
  private resultVisit: MyRealmsVisit | undefined;
  private continuationFocusPending = false;

  private constructor(
    private readonly source: MyRealmsSessionSource,
    readonly visit: MyRealmsVisit,
    session: SessionSnapshot | null,
    options: {
      adopted?: boolean;
      localSourceRevision: number;
      localSessionCacheRevision: SessionCacheRevision;
      localVisitGeneration: number;
      continuationFocus?: boolean;
    } = {
      localSourceRevision: visit.sourceRevision,
      localSessionCacheRevision: visit.sessionCacheRevision,
      localVisitGeneration: source.currentVisitGeneration(),
    },
  ) {
    this.session = session;
    this.localSessionCacheRevision = options.localSessionCacheRevision;
    this.subscribe = source.subscribe;
    this.getRevision = source.getRevision;
    this.adopted = options.adopted ?? false;
    this.hydrationVerified = !this.adopted;
    this.hydrationPending = this.adopted;
    this.localSourceRevision = options.localSourceRevision;
    this.localVisitGeneration = options.localVisitGeneration;
    this.continuationFocusPending = options.continuationFocus ?? false;
  }

  static async capture(
    client: QueryClient,
    input: { cursor?: string | undefined; locale: string; credentialMode: ReadCredentialMode },
    options: { preserveQuery?: boolean } = {},
  ) {
    const source = sourceFor(client);
    const captured = source.read();
    const cache = realmCacheRevision(client, input.cursor);
    const callerId = globalThis.crypto.randomUUID();
    const continuationFocus = source.takeContinuationFocus(input.cursor);
    const visitGeneration = source.beginVisit(options.preserveQuery);
    if (!options.preserveQuery) source.clearRealmCache(input.cursor);
    const queryKey = ['my-realms', input.cursor ?? ''] as const;
    const queryOwner = client.getQueryCache().find({ queryKey, exact: true });
    const queryRevision = realmCacheRevision(client, input.cursor);
    const fingerprintValue = await fingerprint(captured.session?.csrfToken ?? null);
    const afterFingerprint = source.read();
    const currentSession = sessionFrom(client);
    const currentSessionCacheRevision = sessionCacheRevision(client);
    const currentQueryOwner = client.getQueryCache().find({ queryKey, exact: true });
    const currentQueryRevision = realmCacheRevision(client, input.cursor);
    const queryUnchanged =
      currentQueryOwner === queryOwner &&
      (queryOwner
        ? sameRealmCacheRevision(queryRevision ?? undefined, currentQueryRevision ?? undefined)
        : currentQueryRevision === null);
    if (
      !source.isVisitGenerationCurrent(visitGeneration) ||
      !queryUnchanged ||
      afterFingerprint.sourceRevision !== captured.sourceRevision ||
      afterFingerprint.cacheRevision.dataUpdateCount !== captured.cacheRevision.dataUpdateCount ||
      afterFingerprint.cacheRevision.dataUpdatedAt !== captured.cacheRevision.dataUpdatedAt ||
      !sameSession(afterFingerprint.session, captured.session) ||
      !sameSession(currentSession, captured.session) ||
      currentSessionCacheRevision.dataUpdateCount !== captured.cacheRevision.dataUpdateCount ||
      currentSessionCacheRevision.dataUpdatedAt !== captured.cacheRevision.dataUpdatedAt ||
      getLocale() !== input.locale
    )
      throw new Error('My Realms caller inputs changed during capture');
    const ready = isReady(captured.session);
    const visit: MyRealmsVisit = {
      id: callerId,
      target,
      cursor: input.cursor || null,
      locale: input.locale,
      credentialMode: input.credentialMode,
      session: {
        state: captured.session?.state ?? 'unknown',
        subject: captured.session?.subject ?? null,
        ready,
        csrfFingerprint: fingerprintValue,
      },
      sessionCacheRevision: captured.cacheRevision,
      sourceRevision: captured.sourceRevision,
      sourceCacheRevision: cache,
    };
    const caller = new MyRealmsCaller(source, visit, captured.session, {
      localSourceRevision: captured.sourceRevision,
      localSessionCacheRevision: captured.cacheRevision,
      localVisitGeneration: visitGeneration,
      continuationFocus,
    });
    if (!source.activate(caller, options.preserveQuery)) {
      caller.retire();
      throw new Error('My Realms caller was superseded during capture');
    }
    caller.assertCurrent();
    return caller;
  }

  static adopt(client: QueryClient, visit: MyRealmsVisit) {
    const source = sourceFor(client);
    const visitGeneration = source.beginVisit();
    const caller = new MyRealmsCaller(source, visit, sessionFrom(client), {
      adopted: true,
      localSourceRevision: source.getRevision(),
      localSessionCacheRevision: sessionCacheRevision(client),
      localVisitGeneration: visitGeneration,
    });
    caller.ownedQuery =
      (client.getQueryCache().find({
        queryKey: ['my-realms', visit.cursor ?? ''],
        exact: true,
      }) as CacheQuery | undefined) ?? null;
    caller.watchTransferredQuery();
    if (!source.adopt(caller)) {
      caller.retire();
      throw new Error('My Realms result was superseded during adoption');
    }
    return caller;
  }

  static expired(client: QueryClient, visit: MyRealmsVisit) {
    const source = sourceFor(client);
    const caller = new MyRealmsCaller(source, visit, sessionFrom(client), {
      adopted: true,
      localSourceRevision: source.getRevision(),
      localSessionCacheRevision: sessionCacheRevision(client),
      localVisitGeneration: source.currentVisitGeneration(),
    });
    caller.active = false;
    caller.hydrationPending = false;
    caller.hydrationVerified = false;
    return caller;
  }

  capturedSession() {
    return this.session;
  }

  isActive() {
    return this.active;
  }

  localRevision() {
    return this.localSourceRevision;
  }

  capturedVisitGeneration() {
    return this.localVisitGeneration;
  }

  localCacheRevision() {
    return this.localSessionCacheRevision;
  }

  ownsClient(client: QueryClient) {
    return this.source.client === client;
  }

  isCurrent() {
    return (
      this.active &&
      this.visit.session.ready &&
      this.source.current(this) &&
      this.queryOwnerCurrent() &&
      getLocale() === this.visit.locale &&
      (!this.wasAttached || this.attached) &&
      (!this.adopted || this.hydrationVerified)
    );
  }

  requestContinuationFocus(cursor: string) {
    return this.source.requestContinuationFocus(this, cursor);
  }

  hasContinuationFocus() {
    return this.continuationFocusPending && this.isCurrent();
  }

  claimContinuationFocus() {
    const pending = this.continuationFocusPending;
    this.continuationFocusPending = false;
    return pending && this.isCurrent();
  }

  isCurrentAddress(address: {
    target: string;
    cursor?: string | undefined;
    locale: string;
    credentialMode: ReadCredentialMode;
  }) {
    return (
      address.target.replace(/\/$/u, '') === this.visit.target &&
      (address.cursor || null) === this.visit.cursor &&
      address.locale === this.visit.locale &&
      address.credentialMode === this.visit.credentialMode
    );
  }

  acceptsHydrationSeed(visit: MyRealmsVisit, page: MyRealmsPage) {
    return (
      this.active &&
      this.adopted &&
      this.hydrationPending &&
      sameVisit(this.visit, visit) &&
      page.signedIn &&
      originMatchesVisit(page.readerOrigin, visit) &&
      sameReaderOrigin(page.readerOrigin, visit.readerOrigin) &&
      sameReaderOrigin(page.readerAdmission?.readerOrigin, visit.readerOrigin) &&
      page.readerAdmission?.callerId === visit.id &&
      page.readerAdmission?.routeKey === myRealmsRouteKey(visit) &&
      page.readerAdmission?.sourceRevision === visit.sourceRevision &&
      sameRealmCacheRevision(page.readerAdmission?.sessionCacheRevision, visit.sessionCacheRevision) &&
      this.isCurrentAddress({
        target: this.visit.target,
        cursor: this.visit.cursor ?? undefined,
        locale: this.visit.locale,
        credentialMode: this.visit.credentialMode,
      })
    );
  }

  adoptionPending() {
    return this.adopted && this.hydrationPending && this.active;
  }

  acceptsLoaderData(visit: MyRealmsVisit, page: MyRealmsPage) {
    if (
      !this.isCurrent() ||
      !sameVisit(this.visit, visit) ||
      !page.signedIn ||
      !originMatchesVisit(page.readerOrigin, visit) ||
      !sameReaderOrigin(page.readerOrigin, visit.readerOrigin) ||
      page.readerAdmission?.callerId !== visit.id ||
      !sameReaderOrigin(page.readerAdmission?.readerOrigin, visit.readerOrigin) ||
      page.readerAdmission?.sourceRevision !== visit.sourceRevision ||
      !sameRealmCacheRevision(page.readerAdmission?.sessionCacheRevision, visit.sessionCacheRevision)
    )
      return false;
    const expectedVisit = this.resultVisit ?? this.visit;
    if (!sameRealmCacheRevision(expectedVisit.resultCacheRevision, visit.resultCacheRevision)) return false;
    if (this.adopted) return true;
    return taggedPages.get(page)?.callerId === this.visit.id;
  }

  acceptsQueryData(page: MyRealmsPage | undefined) {
    if (!page || !this.isCurrent()) return false;
    const tag = taggedPages.get(page);
    if (!tag || tag.callerId !== this.visit.id || tag.sourceRevision !== this.visit.sourceRevision) return false;
    const query = this.source.client
      .getQueryCache()
      .find({ queryKey: ['my-realms', this.visit.cursor ?? ''], exact: true });
    const state = this.source.client.getQueryState<MyRealmsPage>(['my-realms', this.visit.cursor ?? '']);
    const expectedRevision = this.publishedCacheRevision ?? this.visit.resultCacheRevision;
    return (
      !!query &&
      query === tag.query &&
      state?.data === page &&
      state.status === 'success' &&
      (expectedRevision
        ? sameRealmCacheRevision(expectedRevision, state)
        : state.dataUpdateCount > this.readDataUpdateCount)
    );
  }

  bindRead(query: CacheQuery) {
    this.assertCurrent();
    const current = this.source.client
      .getQueryCache()
      .find({ queryKey: ['my-realms', this.visit.cursor ?? ''], exact: true });
    if (current !== query || (this.ownedQuery && this.ownedQuery !== query)) {
      this.retire();
      throw new Error('My Realms query owner changed');
    }
    this.ownedQuery = query;
    this.readDataUpdateCount =
      this.source.client.getQueryState<MyRealmsPage>(['my-realms', this.visit.cursor ?? ''])?.dataUpdateCount ?? 0;
    this.stopReadWatching?.();
    this.acceptedQueryUpdateCount = undefined;
    this.stopReadWatching = this.source.client.getQueryCache().subscribe((event) => {
      if (event.query !== this.ownedQuery) return;
      if (event.type === 'removed') {
        this.retire();
        return;
      }
      if (event.type !== 'updated') return;
      if (event.action.type === 'success') {
        const page = event.query.state.data;
        const tag = page && typeof page === 'object' ? taggedPages.get(page) : undefined;
        if (
          this.acceptedQueryUpdateCount === undefined &&
          event.query.state.dataUpdateCount > this.readDataUpdateCount &&
          tag?.callerId === this.visit.id &&
          tag.query === this.ownedQuery
        ) {
          this.acceptedQueryUpdateCount = event.query.state.dataUpdateCount;
          return;
        }
        this.retire();
      } else if (event.action.type === 'error') {
        this.retire();
      }
    });
  }

  private watchTransferredQuery() {
    const key = ['my-realms', this.visit.cursor ?? ''] as const;
    if (this.ownedQuery) {
      this.acceptedQueryUpdateCount = this.source.client.getQueryState<MyRealmsPage>(key)?.dataUpdateCount ?? 0;
      this.readDataUpdateCount = this.acceptedQueryUpdateCount;
    }
    this.stopReadWatching?.();
    this.stopReadWatching = this.source.client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey.length !== key.length ||
        event.query.queryKey.some((part: unknown, i: number) => part !== key[i])
      )
        return;
      if (event.type === 'added' && !this.ownedQuery) {
        this.retire();
        return;
      }
      if (event.query !== this.ownedQuery) return;
      if (
        event.type === 'removed' ||
        (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
      )
        this.retire();
    });
  }

  assertCurrent() {
    if (!this.isCurrent()) {
      this.retire();
      throw new Error('My Realms caller retired');
    }
  }

  publishResponse(page: MyRealmsPage, query: CacheQuery): MyRealmsPage {
    this.assertCurrent();
    if (query !== this.ownedQuery || !this.queryOwnerCurrent()) {
      this.retire();
      throw new Error('My Realms query owner changed before publication');
    }
    const readerOrigin = page.readerOrigin;
    if (!originMatchesVisit(readerOrigin, this.visit) || readerOrigin?.kind !== 'session') {
      this.retire();
      throw new Error('My Realms reader did not match its expected session');
    }
    this.visit.readerOrigin = readerOrigin;
    const admitted: MyRealmsPage = {
      ...page,
      readerAdmission: {
        callerId: this.visit.id,
        routeKey: myRealmsRouteKey(this.visit),
        sourceRevision: this.visit.sourceRevision,
        sessionCacheRevision: { ...this.visit.sessionCacheRevision },
        readerOrigin,
      },
    };
    taggedPages.set(admitted, { callerId: this.visit.id, sourceRevision: this.visit.sourceRevision, query });
    return admitted;
  }

  acceptLoaderResult(page: MyRealmsPage): MyRealmsVisit {
    this.assertCurrent();
    const readerOrigin = page.readerOrigin;
    if (
      !this.acceptsQueryData(page) ||
      !originMatchesVisit(readerOrigin, this.visit) ||
      readerOrigin?.kind !== 'session' ||
      page.readerAdmission?.callerId !== this.visit.id ||
      !sameReaderOrigin(page.readerAdmission?.readerOrigin, readerOrigin) ||
      page.readerAdmission?.sourceRevision !== this.visit.sourceRevision ||
      !sameRealmCacheRevision(page.readerAdmission?.sessionCacheRevision, this.visit.sessionCacheRevision)
    )
      throw new Error('My Realms cache publication was not owned by its caller');
    const state = this.source.client.getQueryState<MyRealmsPage>(['my-realms', this.visit.cursor ?? '']);
    if (!state || state.dataUpdateCount <= this.readDataUpdateCount)
      throw new Error('My Realms cache revision did not advance');
    this.publishedCacheRevision = { dataUpdateCount: state.dataUpdateCount, dataUpdatedAt: state.dataUpdatedAt };
    this.resultVisit = {
      ...this.visit,
      resultCacheRevision: this.publishedCacheRevision,
      readerOrigin,
    };
    return this.resultVisit;
  }

  connect() {
    if (!this.active) return () => {};
    this.attached = true;
    this.wasAttached = true;
    this.connectionEpoch++;
    return () => {
      this.attached = false;
      const cleanupEpoch = ++this.connectionEpoch;
      queueMicrotask(() => {
        if (this.connectionEpoch === cleanupEpoch && !this.attached && this.active) this.retire();
      });
    };
  }

  verifyHydration() {
    if (!this.adopted || !this.active || !this.attached) return;
    const connection = this.connectionEpoch;
    if (this.hydrationVerificationConnection === connection) return;
    this.hydrationVerificationConnection = connection;
    const attempt = ++this.hydrationVerificationAttempt;
    void this.finishHydrationVerification(connection, attempt);
  }

  retire(preserveCache = false) {
    if (!this.active) return;
    this.active = false;
    this.continuationFocusPending = false;
    this.hydrationVerified = false;
    this.hydrationPending = false;
    this.stopReadWatching?.();
    this.stopReadWatching = undefined;
    const owned = this.ownedQuery;
    if (this.resultVisit) retiredVisits.add(this.resultVisit);
    this.source.remove(this);
    if (!preserveCache && owned) this.source.clearRealmCache(this.visit.cursor ?? undefined, owned);
    this.source.publish();
  }

  private async finishHydrationVerification(connection: number, attempt: number) {
    const visit = {
      ...this.visit,
      session: { ...this.visit.session },
      sessionCacheRevision: { ...this.visit.sessionCacheRevision },
      ...(this.visit.sourceCacheRevision ? { sourceCacheRevision: { ...this.visit.sourceCacheRevision } } : {}),
      ...(this.visit.resultCacheRevision ? { resultCacheRevision: { ...this.visit.resultCacheRevision } } : {}),
      ...(this.visit.readerOrigin ? { readerOrigin: { ...this.visit.readerOrigin } } : {}),
    } satisfies MyRealmsVisit;
    const ownedQuery = this.ownedQuery;
    const queryKey = ['my-realms', visit.cursor ?? ''] as const;
    const queryAtStart = this.source.client.getQueryCache().find({ queryKey, exact: true });
    const isCurrentAttempt = () =>
      this.active &&
      this.attached &&
      this.connectionEpoch === connection &&
      this.hydrationVerificationAttempt === attempt &&
      sameVisit(this.visit, visit) &&
      this.ownedQuery === ownedQuery &&
      this.source.client.getQueryCache().find({ queryKey, exact: true }) === queryAtStart &&
      getLocale() === visit.locale;
    try {
      if (!isCurrentAttempt()) return;
      const current = sessionFrom(this.source.client);
      const currentCacheRevision = sessionCacheRevision(this.source.client);
      const origin = this.visit.readerOrigin;
      if (
        !current ||
        !this.session ||
        current.state !== this.session.state ||
        current.subject !== this.session.subject ||
        current.state !== this.visit.session.state ||
        current.subject !== this.visit.session.subject ||
        !isReady(current) ||
        currentCacheRevision.dataUpdateCount !== this.localSessionCacheRevision.dataUpdateCount ||
        currentCacheRevision.dataUpdatedAt !== this.localSessionCacheRevision.dataUpdatedAt ||
        !origin ||
        origin.kind !== 'session' ||
        !originMatchesVisit(origin, this.visit)
      ) {
        if (isCurrentAttempt()) this.retire();
        return;
      }
      const currentFingerprint = await fingerprint(current.csrfToken);
      if (!isCurrentAttempt()) return;
      if (
        currentFingerprint !== this.visit.session.csrfFingerprint ||
        currentFingerprint !== origin.csrfFingerprint ||
        !this.source.current(this) ||
        !this.queryOwnerCurrent()
      ) {
        if (isCurrentAttempt()) this.retire();
        return;
      }
      this.hydrationVerified = true;
      this.hydrationPending = false;
      this.notifyHydration();
    } catch {
      if (isCurrentAttempt()) this.retire();
    }
  }

  private notifyHydration() {
    // Query cache notifications are not a caller notification, so use the source's external-store listeners.
    this.source.publish();
  }

  private queryOwnerCurrent() {
    if (!this.ownedQuery) return true;
    const current = this.source.client
      .getQueryCache()
      .find({ queryKey: ['my-realms', this.visit.cursor ?? ''], exact: true });
    return current === this.ownedQuery;
  }
}

export async function captureMyRealmsCaller(
  client: QueryClient,
  input: { cursor?: string | undefined; locale: string; credentialMode: ReadCredentialMode },
  options: { preserveQuery?: boolean } = {},
) {
  return MyRealmsCaller.capture(client, input, options);
}

export function myRealmsCallerForVisit(client: QueryClient, visit: MyRealmsVisit) {
  const source = sourceFor(client);
  const existing = source.lookup(visit.id);
  if (existing) return existing;
  return retiredVisits.has(visit) || source.hasPriorVisit()
    ? MyRealmsCaller.expired(client, visit)
    : MyRealmsCaller.adopt(client, visit);
}

export function beginMyRealmsRead(caller: MyRealmsCaller, client: QueryClient, signal: AbortSignal) {
  caller.assertCurrent();
  if (!caller.ownsClient(client)) throw new Error('My Realms QueryClient changed');
  const query = client.getQueryCache().find({ queryKey: ['my-realms', caller.visit.cursor ?? ''], exact: true });
  if (!query) throw new Error('My Realms query owner is unavailable');
  caller.bindRead(query);
  const onAbort = () => caller.retire();
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    assertCurrent: () => {
      if (signal.aborted) caller.retire();
      caller.assertCurrent();
    },
    publish: (page: MyRealmsPage) => caller.publishResponse(page, query),
    finish: () => signal.removeEventListener('abort', onAbort),
  };
}

function normalizedTarget(pathname: string) {
  return pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/u, '').replace(/\/$/u, '') || '/';
}

export function MyRealmsCallerHost({
  initial,
  cursor,
}: {
  initial: { page: MyRealmsPage; visit: MyRealmsVisit };
  cursor?: string | undefined;
}) {
  const client = useQueryClient();
  const location = useLocation();
  const session = useSession();
  const locale = getLocale();
  const caller = useMemo(() => myRealmsCallerForVisit(client, initial.visit), [client, initial.visit.id]);
  const hydrated = useSyncExternalStore(
    browserHydration.subscribe,
    browserHydration.getSnapshot,
    browserHydration.getServerSnapshot,
  );
  const query = useQuery({ ...myRealmsQuery(cursor, caller), enabled: false });
  useSyncExternalStore(caller.subscribe, caller.getRevision, caller.getRevision);
  const address = {
    target: normalizedTarget(location.pathname),
    cursor,
    locale,
    credentialMode: 'session' as const,
  };
  const matchingAddress = caller.isCurrentAddress(address);
  const focusContinuation = caller.hasContinuationFocus() ? () => caller.claimContinuationFocus() : undefined;
  const onKeyboardNext = (nextCursor: string) => caller.requestContinuationFocus(nextCursor);

  useEffect(() => {
    const disconnect = caller.connect();
    caller.verifyHydration();
    return disconnect;
  }, [caller]);

  if (!matchingAddress) throw new Error('My Realms route changed');
  if (!hydrated && caller.acceptsHydrationSeed(initial.visit, initial.page))
    return (
      <div className="space-y-6">
        <Link to="/realms/new" className="inline-flex min-h-10 items-center text-primary underline underline-offset-4">
          {m.space_setup_heading()}
        </Link>
        <MyRealmsPageView page={initial.page} onKeyboardNext={onKeyboardNext} focusContinuation={focusContinuation} />
      </div>
    );
  if (hydrated && caller.adoptionPending()) return null;
  if (hydrated && (session.state !== 'signed-in' || !caller.isCurrent())) throw new Error('Realm list is unavailable');
  if (query.isError) throw query.error;
  const page = caller.acceptsQueryData(query.data)
    ? query.data
    : caller.acceptsLoaderData(initial.visit, initial.page)
      ? initial.page
      : undefined;
  if (!page) throw new Error('Realm list is unavailable');

  return (
    <div className="space-y-6">
      <Link to="/realms/new" className="inline-flex min-h-10 items-center text-primary underline underline-offset-4">
        {m.space_setup_heading()}
      </Link>
      <MyRealmsPageView page={page} onKeyboardNext={onKeyboardNext} focusContinuation={focusContinuation} />
    </div>
  );
}
