import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useSession } from '../session/query';
import type { ReadCredentialMode } from '../kernel/credential';
import { personalRead } from '../kernel/query';
import type { MyRealmsPage } from './space';
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
};

type CacheQuery = object;

type TaggedPage = { callerId: string; sourceRevision: number; query: CacheQuery };
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
    left.sourceCacheRevision?.dataUpdatedAt === right.sourceCacheRevision?.dataUpdatedAt
  );
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

  constructor(readonly client: QueryClient) {
    this.snapshot = sessionFrom(client);
    this.cacheRevision = sessionCacheRevision(client);
    client.getQueryCache().subscribe(({ query }) => {
      if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionKey[0]) return;
      const nextSession = sessionFrom(client);
      const nextRevision = sessionCacheRevision(client);
      if (
        sameSession(this.snapshot, nextSession) &&
        this.cacheRevision.dataUpdateCount === nextRevision.dataUpdateCount &&
        this.cacheRevision.dataUpdatedAt === nextRevision.dataUpdatedAt
      )
        return;
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

  current(caller: MyRealmsCaller) {
    const captured = caller.capturedSession();
    return (
      this.active === caller &&
      caller.isActive() &&
      this.revision === caller.localRevision() &&
      sameSession(this.snapshot, captured) &&
      this.cacheRevision.dataUpdateCount === caller.visit.sessionCacheRevision.dataUpdateCount &&
      this.cacheRevision.dataUpdatedAt === caller.visit.sessionCacheRevision.dataUpdatedAt
    );
  }

  activate(caller: MyRealmsCaller, preserveCache = false) {
    this.active?.retire(preserveCache);
    this.active = caller;
    this.hasVisited = true;
    this.visits.set(caller.visit.id, caller);
  }

  adopt(caller: MyRealmsCaller) {
    this.active?.retire();
    this.active = caller;
    this.hasVisited = true;
    this.visits.set(caller.visit.id, caller);
  }

  lookup(id: string) {
    return this.visits.get(id);
  }

  hasPriorVisit() {
    return this.hasVisited;
  }

  remove(caller: MyRealmsCaller) {
    if (this.active === caller) this.active = null;
    this.visits.delete(caller.visit.id);
  }

  clearRealmCache(cursor?: string, expected?: CacheQuery) {
    const key = ['my-realms', cursor ?? ''] as const;
    const query = this.client.getQueryCache().find({ queryKey: key, exact: true });
    if (expected && query !== expected) return;
    if (!query) return;
    void this.client.cancelQueries({ queryKey: key, exact: true });
    this.client.removeQueries({ queryKey: key, exact: true });
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
  private active = true;
  private adopted = false;
  private hydrationVerified = true;
  private hydrationPending = false;
  private hydrationVerificationStarted = false;
  private attached = false;
  private wasAttached = false;
  private connectionEpoch = 0;
  private ownedQuery: CacheQuery | null = null;
  private readDataUpdateCount = -1;
  private publishedCacheRevision: RealmCacheRevision | undefined;
  private readonly localSourceRevision: number;
  private resultVisit: MyRealmsVisit | undefined;

  private constructor(
    private readonly source: MyRealmsSessionSource,
    readonly visit: MyRealmsVisit,
    session: SessionSnapshot | null,
    options: { adopted?: boolean; localSourceRevision: number } = { localSourceRevision: visit.sourceRevision },
  ) {
    this.session = session;
    this.subscribe = source.subscribe;
    this.getRevision = source.getRevision;
    this.adopted = options.adopted ?? false;
    this.hydrationVerified = !this.adopted;
    this.hydrationPending = this.adopted;
    this.localSourceRevision = options.localSourceRevision;
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
    source.retireActive(options.preserveQuery);
    if (!options.preserveQuery) source.clearRealmCache(input.cursor);
    const fingerprintValue = await fingerprint(captured.session?.csrfToken ?? null);
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
    });
    source.activate(caller, options.preserveQuery);
    caller.assertCurrent();
    return caller;
  }

  static adopt(client: QueryClient, visit: MyRealmsVisit) {
    const source = sourceFor(client);
    const caller = new MyRealmsCaller(source, visit, sessionFrom(client), {
      adopted: true,
      localSourceRevision: source.getRevision(),
    });
    caller.ownedQuery =
      (client.getQueryCache().find({
        queryKey: ['my-realms', visit.cursor ?? ''],
        exact: true,
      }) as CacheQuery | undefined) ?? null;
    source.adopt(caller);
    return caller;
  }

  static expired(client: QueryClient, visit: MyRealmsVisit) {
    const source = sourceFor(client);
    const caller = new MyRealmsCaller(source, visit, sessionFrom(client), {
      adopted: true,
      localSourceRevision: source.getRevision(),
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

  ownsClient(client: QueryClient) {
    return this.source.client === client;
  }

  isCurrent() {
    return (
      this.active &&
      this.visit.session.ready &&
      this.source.current(this) &&
      (!this.wasAttached || this.attached) &&
      (!this.adopted || this.hydrationVerified)
    );
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
    if (!this.isCurrent() || !sameVisit(this.visit, visit) || !page.signedIn) return false;
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
      sameRealmCacheRevision(expectedRevision, state)
    );
  }

  bindRead(query: CacheQuery) {
    this.assertCurrent();
    this.ownedQuery = query;
    this.readDataUpdateCount =
      this.source.client.getQueryState<MyRealmsPage>(['my-realms', this.visit.cursor ?? ''])?.dataUpdateCount ?? 0;
  }

  assertCurrent() {
    if (!this.isCurrent()) {
      this.retire();
      throw new Error('My Realms caller retired');
    }
  }

  publishResponse(page: MyRealmsPage, query: CacheQuery) {
    this.assertCurrent();
    taggedPages.set(page, { callerId: this.visit.id, sourceRevision: this.visit.sourceRevision, query });
  }

  acceptLoaderResult(page: MyRealmsPage): MyRealmsVisit {
    this.assertCurrent();
    if (!this.acceptsQueryData(page)) throw new Error('My Realms cache publication was not owned by its caller');
    const state = this.source.client.getQueryState<MyRealmsPage>(['my-realms', this.visit.cursor ?? '']);
    if (!state || state.dataUpdateCount <= this.readDataUpdateCount)
      throw new Error('My Realms cache revision did not advance');
    this.publishedCacheRevision = { dataUpdateCount: state.dataUpdateCount, dataUpdatedAt: state.dataUpdatedAt };
    this.resultVisit = { ...this.visit, resultCacheRevision: this.publishedCacheRevision };
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
    if (!this.adopted || this.hydrationVerificationStarted || !this.active) return;
    this.hydrationVerificationStarted = true;
    void this.finishHydrationVerification();
  }

  retire(preserveCache = false) {
    if (!this.active) return;
    this.active = false;
    this.hydrationVerified = false;
    this.hydrationPending = false;
    const owned = this.ownedQuery;
    if (this.resultVisit) retiredVisits.add(this.resultVisit);
    this.source.remove(this);
    if (!preserveCache && owned) this.source.clearRealmCache(this.visit.cursor ?? undefined, owned);
    this.source.publish();
  }

  private async finishHydrationVerification() {
    try {
      const current = sessionFrom(this.source.client);
      const currentCacheRevision = sessionCacheRevision(this.source.client);
      if (
        current?.state !== this.visit.session.state ||
        current.subject !== this.visit.session.subject ||
        currentCacheRevision.dataUpdateCount !== this.visit.sessionCacheRevision.dataUpdateCount ||
        currentCacheRevision.dataUpdatedAt !== this.visit.sessionCacheRevision.dataUpdatedAt
      ) {
        this.retire();
        return;
      }
      const currentFingerprint = await fingerprint(current.csrfToken);
      if (currentFingerprint !== this.visit.session.csrfFingerprint || !this.source.current(this)) {
        this.retire();
        return;
      }
      this.hydrationVerified = true;
      this.hydrationPending = false;
      this.notifyHydration();
    } catch {
      this.retire();
    }
  }

  private notifyHydration() {
    // Query cache notifications are not a caller notification, so use the source's external-store listeners.
    this.source.publish();
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
        <MyRealmsPageView page={initial.page} />
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
      <MyRealmsPageView page={page} />
    </div>
  );
}
