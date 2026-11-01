import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { ReadCredentialMode } from '../kernel/credential';
import { sessionQuery } from '../session/query';
import type { ReaderOrigin, SpacePageData } from './space';

export type SpacePageTarget = { kind: 'space'; address: string } | { kind: 'realm'; id: string };

type SessionRecord = { state: string; subject?: string | null; csrfToken?: string | null };
type SessionSnapshot = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  queryStatus: string;
  errorUpdateCount: number;
};

export type ExpectedReader =
  | { kind: 'anonymous' }
  | { kind: 'signed-in'; subject: string }
  | { kind: 'unknown' };

export type SpacePageSessionSource = {
  /** Local observation handle; it is not a reader identity or hydration proof. */
  readonly id: number;
  readonly nonce: string;
  read(): SessionRecord | undefined;
  dataUpdateCount(): number;
  dataUpdatedAt(): number;
  queryStatus(): string;
  errorUpdateCount(): number;
  revision(): number;
  subscribe(listener: () => void): () => void;
};

/** Serializable loader admission. The actual reader always comes from the server read envelope. */
export type SpacePageAdmission = {
  readonly readId: string;
  readonly sourceId: number;
  readonly sourceNonce: string;
  readonly sessionRevision: number;
  readonly sessionState: string;
  readonly sessionSubject: string | null;
  readonly sessionCredentialFingerprint: string;
  readonly sessionDataUpdateCount: number;
  readonly sessionDataUpdatedAt: number;
  readonly sessionQueryStatus: string;
  readonly sessionErrorUpdateCount: number;
  readonly expectedReader: ExpectedReader;
  readonly readerOrigin?: ReaderOrigin;
  readonly credentialMode: ReadCredentialMode;
  readonly target: SpacePageTarget;
  readonly locale: string;
  readonly realmId: string | null;
};

type AdmissionRuntime = {
  client: QueryClient;
  source: SpacePageSessionSource;
  baseline: SessionSnapshot;
  revision: number;
  initialized: boolean;
};

export type ShelfReadTicket = {
  readonly pageReadId: string;
  readonly ticket: number;
  readonly source: SpacePageSessionSource;
  readonly sourceRevision: number;
  readonly baseline: SessionSnapshot;
  readonly readerOrigin: ReaderOrigin;
  readonly credentialMode: ReadCredentialMode;
  readonly expectedReader: ExpectedReader;
};

const sources = new WeakMap<QueryClient, SpacePageSessionSource>();
const runtimes = new WeakMap<SpacePageAdmission, AdmissionRuntime>();
const resultAdmissions = new WeakMap<object, SpacePageAdmission>();
const realmReadAdmissions = new WeakMap<object, SpacePageAdmission>();
const claimedAdmissions = new WeakSet<SpacePageAdmission>();
const activeAdmissions = new WeakMap<SpacePageAdmission, SpacePageLifetime>();
let nextSourceId = 0;
let nextReadId = 0;

function snapshot(client: QueryClient): SessionSnapshot {
  const session = client.getQueryData<SessionRecord>(sessionQuery.queryKey);
  return {
    state: session?.state ?? 'unknown',
    subject: session?.subject ?? null,
    csrfToken: session?.csrfToken ?? null,
    dataUpdateCount: client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0,
    dataUpdatedAt: client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0,
    queryStatus: client.getQueryState(sessionQuery.queryKey)?.status ?? 'pending',
    errorUpdateCount: client.getQueryState(sessionQuery.queryKey)?.errorUpdateCount ?? 0,
  };
}

function sameSnapshot(left: SessionSnapshot, right: SessionSnapshot) {
  return (
    left.state === right.state &&
    left.subject === right.subject &&
    left.csrfToken === right.csrfToken &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.dataUpdatedAt === right.dataUpdatedAt &&
    left.queryStatus === right.queryStatus &&
    left.errorUpdateCount === right.errorUpdateCount
  );
}

/** This digest only detects a changed cached CSRF value; it never identifies or authenticates a reader. */
function credentialFingerprint(value: string | null) {
  let hash = 0x811c9dc5;
  const input = value ?? '';
  for (let index = 0; index < input.length; index++) hash = Math.imul(hash ^ input.charCodeAt(index), 0x01000193);
  return `${value === null ? 'none' : 'some'}:${(hash >>> 0).toString(16)}`;
}

function expectedReader(session: SessionSnapshot, credentialMode: ReadCredentialMode): ExpectedReader {
  if (credentialMode === 'anonymous') return { kind: 'anonymous' };
  if (session.state === 'signed-out') return { kind: 'anonymous' };
  if (session.state === 'signed-in' && session.subject) return { kind: 'signed-in', subject: session.subject };
  return { kind: 'unknown' };
}

function observeSession(client: QueryClient): SpacePageSessionSource {
  const read = () => client.getQueryData<SessionRecord>(sessionQuery.queryKey);
  const dataUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const dataUpdatedAt = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
  const queryStatus = () => client.getQueryState(sessionQuery.queryKey)?.status ?? 'pending';
  const errorUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.errorUpdateCount ?? 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const matchesSessionQuery = (query: { queryKey: readonly unknown[] }) =>
    query.queryKey.length === sessionQuery.queryKey.length &&
    query.queryKey.every((part, index) => part === sessionQuery.queryKey[index]);
  client.getQueryCache().subscribe((event) => {
    if (!matchesSessionQuery(event.query)) return;
    // Only committed data replacement, failed refresh, and removal change the session
    // observation. Fetch/observer notifications and StrictMode replay do not.
    const action = 'action' in event ? event.action : undefined;
    const changed =
      event.type === 'removed' ||
      (event.type === 'updated' &&
        action &&
        (action.type === 'success' || action.type === 'error' || action.type === 'setState'));
    if (!changed) return;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    id: ++nextSourceId,
    nonce: `session-source:${crypto.randomUUID()}`,
    read,
    dataUpdateCount,
    dataUpdatedAt,
    queryStatus,
    errorUpdateCount,
    revision: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Read-only observation of the existing QueryClient session entry. */
export function spacePageSessionSource(client: QueryClient): SpacePageSessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSession(client);
    sources.set(client, source);
  }
  return source;
}

function toSnapshot(source: SpacePageSessionSource): SessionSnapshot {
  const session = source.read();
  return {
    state: session?.state ?? 'unknown',
    subject: session?.subject ?? null,
    csrfToken: session?.csrfToken ?? null,
    dataUpdateCount: source.dataUpdateCount(),
    dataUpdatedAt: source.dataUpdatedAt(),
    queryStatus: source.queryStatus(),
    errorUpdateCount: source.errorUpdateCount(),
  };
}

function snapshotMatchesAdmission(admission: SpacePageAdmission, current: SessionSnapshot) {
  return (
    admission.sessionState === current.state &&
    admission.sessionSubject === current.subject &&
    admission.sessionCredentialFingerprint === credentialFingerprint(current.csrfToken) &&
    admission.sessionQueryStatus === current.queryStatus &&
    admission.sessionErrorUpdateCount === current.errorUpdateCount
  );
}

function canAdoptInitialSession(admission: SpacePageAdmission, prior: SessionSnapshot, current: SessionSnapshot) {
  return (
    admission.credentialMode === 'anonymous' &&
    admission.readerOrigin?.kind === 'anonymous' &&
    admission.sessionState === 'unknown' &&
    prior.state === 'unknown' &&
    prior.dataUpdateCount === 0 &&
    current.dataUpdateCount === 1 &&
    current.queryStatus === 'success' &&
    current.state !== 'unknown'
  );
}

function canBridgeInitialSession(admission: SpacePageAdmission, current: SessionSnapshot) {
  return (
    admission.credentialMode === 'anonymous' &&
    admission.readerOrigin?.kind === 'anonymous' &&
    admission.sessionState === 'unknown' &&
    admission.sessionDataUpdateCount === 0 &&
    admission.sessionDataUpdatedAt === 0 &&
    current.dataUpdateCount === 1 &&
    current.queryStatus === 'success' &&
    current.state !== 'unknown'
  );
}

function readerOriginMatches(admission: SpacePageAdmission, origin: ReaderOrigin) {
  if (origin.kind === 'unidentified') return false;
  if (admission.credentialMode === 'anonymous') return origin.kind === 'anonymous';
  if (admission.expectedReader.kind === 'anonymous') return origin.kind === 'anonymous';
  return (
    admission.expectedReader.kind === 'signed-in' &&
    origin.kind === 'signed-in' &&
    origin.subject === admission.expectedReader.subject
  );
}

function resolveRuntime(admission: SpacePageAdmission, client: QueryClient): AdmissionRuntime | null {
  const source = spacePageSessionSource(client);
  const current = toSnapshot(source);
  const existing = runtimes.get(admission);
  if (existing) {
    if (existing.client !== client || existing.source !== source) return null;
    if (existing.revision === source.revision() && sameSnapshot(existing.baseline, current)) return existing;
    if (!existing.initialized && canAdoptInitialSession(admission, existing.baseline, current)) {
      existing.baseline = current;
      existing.revision = source.revision();
      existing.initialized = true;
      return existing;
    }
    return null;
  }

  if (!admission.readerOrigin || !readerOriginMatches(admission, admission.readerOrigin)) return null;
  const sameSource = source.nonce === admission.sourceNonce;
  if (sameSource) {
    // Source-local generations catch equal-value writes, errors, removals, and observed ABA.
    // Their serialized values are never used as proof across QueryClients.
    if (source.revision() !== admission.sessionRevision || !snapshotMatchesAdmission(admission, current)) {
      if (!canBridgeInitialSession(admission, current)) return null;
    }
  } else if (!snapshotMatchesAdmission(admission, current) && !canBridgeInitialSession(admission, current)) {
    return null;
  }

  const runtime: AdmissionRuntime = {
    client,
    source,
    baseline: current,
    revision: source.revision(),
    initialized: current.state !== 'unknown' || canBridgeInitialSession(admission, current),
  };
  runtimes.set(admission, runtime);
  return runtime;
}

function runtimeIsCurrent(admission: SpacePageAdmission, runtime: AdmissionRuntime) {
  const current = toSnapshot(runtime.source);
  if (runtime.source.revision() === runtime.revision && sameSnapshot(runtime.baseline, current)) return true;
  if (!runtime.initialized && canAdoptInitialSession(admission, runtime.baseline, current)) {
    runtime.baseline = current;
    runtime.revision = runtime.source.revision();
    runtime.initialized = true;
    return true;
  }
  return false;
}

/** Capture the expected QueryClient/session observation before starting the original read. */
export function captureSpacePageAdmission(
  client: QueryClient,
  input: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
): SpacePageAdmission {
  const source = spacePageSessionSource(client);
  const current = toSnapshot(source);
  const admission: SpacePageAdmission = {
    readId: `${source.id}:${++nextReadId}`,
    sourceId: source.id,
    sourceNonce: source.nonce,
    sessionRevision: source.revision(),
    sessionState: current.state,
    sessionSubject: current.subject,
    sessionCredentialFingerprint: credentialFingerprint(current.csrfToken),
    sessionDataUpdateCount: current.dataUpdateCount,
    sessionDataUpdatedAt: current.dataUpdatedAt,
    sessionQueryStatus: current.queryStatus,
    sessionErrorUpdateCount: current.errorUpdateCount,
    expectedReader: expectedReader(current, input.credentialMode),
    credentialMode: input.credentialMode,
    target: input.target,
    locale: input.locale,
    realmId: null,
  };
  runtimes.set(admission, {
    client,
    source,
    baseline: current,
    revision: source.revision(),
    initialized: current.state !== 'unknown',
  });
  return admission;
}

export function spacePageAdmissionIsCurrent(admission: SpacePageAdmission, client: QueryClient) {
  if (admission.credentialMode === 'session' && admission.expectedReader.kind === 'unknown') return false;
  const runtime = resolveRuntime(admission, client);
  return !!runtime && runtimeIsCurrent(admission, runtime);
}

export function spacePageAdmissionIsAvailable(admission: SpacePageAdmission) {
  if (!claimedAdmissions.has(admission)) return true;
  return activeAdmissions.get(admission)?.current() ?? false;
}

export function bindSpacePageResult(
  page: SpacePageData,
  admission: SpacePageAdmission,
  readerOrigin: ReaderOrigin | undefined = (page as SpacePageData & { readerOrigin?: ReaderOrigin }).readerOrigin,
  client?: QueryClient,
) {
  if (!readerOrigin || !readerOriginMatches(admission, readerOrigin)) return null;
  const runtime = runtimes.get(admission) ?? (client ? resolveRuntime(admission, client) : null);
  if (!runtime || !runtimeIsCurrent(admission, runtime)) return null;
  const bound: SpacePageAdmission = { ...admission, readerOrigin, realmId: page.realm?.id ?? null };
  runtimes.set(bound, runtime);
  resultAdmissions.set(page, bound);
  return bound;
}

export function getSpacePageAdmission(page: SpacePageData) {
  return resultAdmissions.get(page);
}

export function bindRealmPageResult(
  located: ({ kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string }) & {
    readerOrigin?: ReaderOrigin;
  },
  admission: SpacePageAdmission,
  client?: QueryClient,
) {
  if (!located.readerOrigin || !readerOriginMatches(admission, located.readerOrigin)) return null;
  let bound = admission;
  if (located.kind === 'page') {
    const pageAdmission = bindSpacePageResult(located.page, admission, located.readerOrigin, client);
    if (!pageAdmission) return null;
    bound = pageAdmission;
  } else {
    const runtime = runtimes.get(admission) ?? (client ? resolveRuntime(admission, client) : null);
    if (!runtime || !runtimeIsCurrent(admission, runtime)) return null;
    bound = { ...admission, readerOrigin: located.readerOrigin };
    runtimes.set(bound, runtime);
  }
  realmReadAdmissions.set(located, bound);
  return bound;
}

export function getRealmPageAdmission(
  located: { kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string },
) {
  return realmReadAdmissions.get(located);
}

/** Reattach the serialized origin and admission after loader hydration into an independent QueryClient. */
export function bindHydratedSpacePage(
  page: SpacePageData,
  admission: SpacePageAdmission,
  client: QueryClient,
  expected: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
) {
  if (!spacePageAdmissionIsAvailable(admission) || !admission.readerOrigin) return false;
  if (
    admission.target.kind !== expected.target.kind ||
    (admission.target.kind === 'space' &&
      expected.target.kind === 'space' &&
      admission.target.address !== expected.target.address) ||
    (admission.target.kind === 'realm' &&
      expected.target.kind === 'realm' &&
      admission.target.id !== expected.target.id) ||
    admission.locale !== expected.locale ||
    admission.credentialMode !== expected.credentialMode ||
    admission.realmId !== (page.realm?.id ?? null)
  )
    return false;
  const pageOrigin = (page as SpacePageData & { readerOrigin?: ReaderOrigin }).readerOrigin;
  if (pageOrigin && !sameOrigin(pageOrigin, admission.readerOrigin)) return false;
  const runtime = resolveRuntime(admission, client);
  if (!runtime || !runtimeIsCurrent(admission, runtime)) return false;
  runtimes.set(admission, runtime);
  resultAdmissions.set(page, admission);
  return true;
}

function sameOrigin(left: ReaderOrigin, right: ReaderOrigin) {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'signed-in' && right.kind === 'signed-in') return left.subject === right.subject;
  if (left.kind === 'unidentified' && right.kind === 'unidentified') return left.reason === right.reason;
  return true;
}

export function spacePageAdmissionFor(
  page: SpacePageData,
  client: QueryClient,
  expected: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
  supplied?: SpacePageAdmission,
) {
  const admission = supplied ?? getSpacePageAdmission(page);
  return admission &&
    admission.target.kind === expected.target.kind &&
    (admission.target.kind === 'space' && expected.target.kind === 'space'
      ? admission.target.address === expected.target.address
      : admission.target.kind === 'realm' && expected.target.kind === 'realm'
        ? admission.target.id === expected.target.id
        : false) &&
    admission.locale === expected.locale &&
    admission.credentialMode === expected.credentialMode &&
    admission.realmId === (page.realm?.id ?? null) &&
    spacePageAdmissionIsAvailable(admission) &&
    spacePageAdmissionIsCurrent(admission, client)
    ? admission
    : null;
}

/** A production shelf mounted outside a route host still captures its own pre-read observation. */
export function captureStandaloneShelfRead(client: QueryClient, credentialMode: ReadCredentialMode): ShelfReadTicket | null {
  const source = spacePageSessionSource(client);
  const baseline = toSnapshot(source);
  const expected = expectedReader(baseline, credentialMode);
  if (credentialMode === 'session' && expected.kind === 'unknown') return null;
  const origin: ReaderOrigin =
    expected.kind === 'signed-in'
      ? { kind: 'signed-in', subject: expected.subject }
      : { kind: 'anonymous' };
  return {
    pageReadId: `standalone:${source.id}:${++nextReadId}`,
    ticket: 0,
    source,
    sourceRevision: source.revision(),
    baseline,
    readerOrigin: origin,
    credentialMode,
    expectedReader: expected,
  };
}

export function standaloneShelfReadIsCurrent(ticket: ShelfReadTicket) {
  return ticket.source.revision() === ticket.sourceRevision && sameSnapshot(ticket.baseline, toSnapshot(ticket.source));
}

export function standaloneShelfReaderMatches(ticket: ShelfReadTicket, origin: ReaderOrigin) {
  if (!standaloneShelfReadIsCurrent(ticket) || origin.kind === 'unidentified') return false;
  if (ticket.credentialMode === 'anonymous') return origin.kind === 'anonymous';
  if (ticket.expectedReader.kind === 'anonymous') return origin.kind === 'anonymous';
  return (
    ticket.expectedReader.kind === 'signed-in' &&
    origin.kind === 'signed-in' &&
    origin.subject === ticket.expectedReader.subject
  );
}

export class ObsoleteSpacePageReadError extends Error {
  constructor() {
    super('Space page read belongs to an obsolete visit');
    this.name = 'ObsoleteSpacePageReadError';
  }
}

export function isObsoleteSpacePageRead(error: unknown): error is ObsoleteSpacePageReadError {
  return error instanceof ObsoleteSpacePageReadError;
}

export class SpacePageLifetime {
  private connected = false;
  private disposed = false;
  private serial = 0;
  private revision = 0;
  private stopWatching: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly runtime: AdmissionRuntime | null;
  private claimed = false;

  constructor(
    readonly admission: SpacePageAdmission,
    client: QueryClient,
    readonly scopeKey: string,
  ) {
    this.runtime = resolveRuntime(admission, client);
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  retire = (notify = true) => {
    if (this.disposed) return;
    this.disposed = true;
    this.serial++;
    if (activeAdmissions.get(this.admission) === this) activeAdmissions.delete(this.admission);
    this.stopWatching?.();
    this.stopWatching = undefined;
    if (notify) this.publish();
    else this.revision++;
  };

  snapshot = () => {
    if (!this.disposed && (!this.runtime || !runtimeIsCurrent(this.admission, this.runtime))) this.retire(false);
    return this.revision;
  };

  admitted = () => {
    this.snapshot();
    if (!this.admission.readerOrigin) this.retire(false);
    if (!this.claimed && claimedAdmissions.has(this.admission)) this.retire(false);
    return !this.disposed;
  };

  current = () => this.connected && this.admitted();

  ticket = () => this.serial;

  owns = (ticket: number) => this.current() && this.serial === ticket;

  captureShelfRead = (): ShelfReadTicket | null => {
    if (!this.current() || !this.runtime || !this.admission.readerOrigin) return null;
    return {
      pageReadId: this.admission.readId,
      ticket: this.serial,
      source: this.runtime.source,
      sourceRevision: this.runtime.source.revision(),
      baseline: toSnapshot(this.runtime.source),
      readerOrigin: this.admission.readerOrigin,
      credentialMode: this.admission.credentialMode,
      expectedReader: this.admission.expectedReader,
    };
  };

  shelfReadOwns = (ticket: ShelfReadTicket) => {
    if (
      !this.current() ||
      ticket.pageReadId !== this.admission.readId ||
      ticket.ticket !== this.serial ||
      !this.runtime
    )
      return false;
    const current = toSnapshot(this.runtime.source);
    const sameObservation = ticket.sourceRevision === this.runtime.source.revision() && sameSnapshot(ticket.baseline, current);
    return sameObservation || canAdoptInitialSession(this.admission, ticket.baseline, current);
  };

  shelfReaderMatches = (ticket: ShelfReadTicket, origin: ReaderOrigin) =>
    this.shelfReadOwns(ticket) &&
    readerOriginMatches(this.admission, origin) &&
    sameOrigin(ticket.readerOrigin, origin);

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.snapshot();
    return () => this.listeners.delete(listener);
  };

  connect = () => {
    if (this.disposed) return () => {};
    if (!this.claimed) {
      if (claimedAdmissions.has(this.admission)) {
        this.retire();
        return () => {};
      }
      claimedAdmissions.add(this.admission);
      this.claimed = true;
    }
    const wasConnected = this.connected;
    this.connected = true;
    activeAdmissions.set(this.admission, this);
    if (!this.stopWatching && this.runtime) {
      this.stopWatching = this.runtime.source.subscribe(() => {
        if (!this.disposed && (!this.runtime || !runtimeIsCurrent(this.admission, this.runtime))) this.retire();
        else this.publish();
      });
      this.snapshot();
    }
    if (!wasConnected && !this.disposed) this.publish();
    return () => {
      if (!this.connected) return;
      this.connected = false;
      if (activeAdmissions.get(this.admission) === this) activeAdmissions.delete(this.admission);
      this.stopWatching?.();
      this.stopWatching = undefined;
      this.publish();
      queueMicrotask(() => {
        if (!this.connected) this.retire();
      });
    };
  };
}

export const SpacePageLifetimeContext = createContext<SpacePageLifetime | null>(null);

export function useSpacePageLifetime() {
  return useContext(SpacePageLifetimeContext);
}

/** Route-only host: original loader/query admission is checked before SpacePage can render. */
export function SpacePageLifetimeHost({
  page,
  admission,
  target,
  locale,
  credentialMode,
  children,
}: {
  page: SpacePageData;
  admission: SpacePageAdmission;
  target: SpacePageTarget;
  locale: string;
  credentialMode: ReadCredentialMode;
  children: ReactNode;
}) {
  const client = useContext(QueryClientContext);
  if (!client) throw new Error('Space page lifetime requires the route QueryClient');
  const attached = bindHydratedSpacePage(page, admission, client, { target, locale, credentialMode });
  const scopeKey = JSON.stringify([
    admission.readId,
    admission.sourceId,
    admission.sourceNonce,
    admission.sessionRevision,
    admission.sessionDataUpdateCount,
    admission.sessionDataUpdatedAt,
    admission.sessionQueryStatus,
    admission.sessionErrorUpdateCount,
    admission.sessionState,
    admission.sessionSubject,
    admission.sessionCredentialFingerprint,
    admission.expectedReader,
    admission.readerOrigin,
    admission.credentialMode,
    admission.target,
    admission.realmId,
    admission.locale,
  ]);
  const lifetime = useMemo(() => new SpacePageLifetime(admission, client, scopeKey), [admission, client, scopeKey]);
  const previous = useRef<SpacePageLifetime | null>(null);
  if (previous.current && previous.current !== lifetime) previous.current.retire(false);
  previous.current = lifetime;
  useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  useEffect(() => lifetime.connect(), [lifetime]);
  if (!attached) lifetime.retire(false);
  if (!attached || !lifetime.admitted()) return null;
  return <SpacePageLifetimeContext.Provider value={lifetime}>{children}</SpacePageLifetimeContext.Provider>;
}
