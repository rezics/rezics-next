import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ReadCredentialMode } from '../kernel/credential';
import { sessionQuery } from '../session/query';
import type { SpacePageData } from './space';

export type SpacePageTarget = { kind: 'space'; address: string } | { kind: 'realm'; id: string };

type SessionRecord = { state: string; subject?: string | null; csrfToken?: string | null };
type SessionSnapshot = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
  dataUpdateCount: number;
  dataUpdatedAt: number;
};

export type SpacePageSessionSource = {
  readonly id: number;
  read(): SessionRecord | undefined;
  dataUpdateCount(): number;
  dataUpdatedAt(): number;
  revision(): number;
  subscribe(listener: () => void): () => void;
};

/** This serializable portion crosses the route-loader hydration boundary with its original result. */
export type SpacePageAdmission = {
  readonly readId: string;
  readonly sourceId: number;
  readonly sessionRevision: number;
  readonly sessionState: string;
  readonly sessionTupleFingerprint: string;
  readonly sessionDataUpdateCount: number;
  readonly sessionDataUpdatedAt: number;
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
  };
}

function sameSession(left: SessionSnapshot, right: SessionSnapshot) {
  return (
    left.state === right.state &&
    left.subject === right.subject &&
    left.csrfToken === right.csrfToken &&
    left.dataUpdateCount === right.dataUpdateCount &&
    left.dataUpdatedAt === right.dataUpdatedAt
  );
}

function sessionTupleFingerprint(session: SessionSnapshot) {
  const value = JSON.stringify([session.state, session.subject, session.csrfToken]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function observeSession(client: QueryClient): SpacePageSessionSource {
  const read = () => client.getQueryData<SessionRecord>(sessionQuery.queryKey);
  const dataUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const dataUpdatedAt = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
  const identity = () => JSON.stringify(snapshot(client));
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== sessionQuery.queryKey.length) return;
    if (query.queryKey.some((part, index) => part !== sessionQuery.queryKey[index])) return;
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
  };
}

function runtimeMatchesAdmission(admission: SpacePageAdmission, current: SessionSnapshot) {
  return (
    admission.sessionState === current.state &&
    admission.sessionTupleFingerprint === sessionTupleFingerprint(current) &&
    admission.sessionDataUpdateCount === current.dataUpdateCount &&
    admission.sessionDataUpdatedAt === current.dataUpdatedAt
  );
}

function canAdoptInitialSession(admission: SpacePageAdmission, prior: SessionSnapshot, current: SessionSnapshot) {
  return (
    admission.credentialMode === 'anonymous' &&
    admission.sessionState === 'unknown' &&
    prior.state === 'unknown' &&
    prior.dataUpdateCount === 0 &&
    current.dataUpdateCount === 1 &&
    current.state !== 'unknown'
  );
}

function canBridgeInitialSession(admission: SpacePageAdmission, current: SessionSnapshot) {
  return (
    admission.credentialMode === 'anonymous' &&
    admission.sessionState === 'unknown' &&
    admission.sessionDataUpdateCount === 0 &&
    admission.sessionDataUpdatedAt === 0 &&
    current.dataUpdateCount === 1 &&
    current.state !== 'unknown'
  );
}

function resolveRuntime(admission: SpacePageAdmission, client: QueryClient): AdmissionRuntime | null {
  const source = spacePageSessionSource(client);
  let runtime = runtimes.get(admission);
  const current = toSnapshot(source);
  if (runtime) {
    if (runtime.client !== client || runtime.source !== source) return null;
    if (
      runtime.revision === source.revision() &&
      runtimeMatchesAdmission(admission, current) &&
      sameSession(runtime.baseline, current)
    )
      return runtime;
    if (!runtime.initialized && canAdoptInitialSession(admission, runtime.baseline, current)) {
      runtime.baseline = current;
      runtime.revision = source.revision();
      runtime.initialized = true;
      return runtime;
    }
    return runtime;
  }

  // A route loader admission is serialized for browser hydration. Rebind it only when the
  // hydrated session cache preserves the exact tuple and update counters captured by the read.
  const bridged = source.id !== admission.sourceId;
  if (bridged && !runtimeMatchesAdmission(admission, current)) {
    if (!canBridgeInitialSession(admission, current)) return null;
  }
  if (!bridged && (source.revision() !== admission.sessionRevision || !runtimeMatchesAdmission(admission, current))) {
    if (!canBridgeInitialSession(admission, current)) return null;
  }
  runtime = {
    client,
    source,
    baseline: current,
    revision: source.revision(),
    initialized: bridged || current.state !== 'unknown',
  };
  runtimes.set(admission, runtime);
  return runtime;
}

function runtimeIsCurrent(admission: SpacePageAdmission, runtime: AdmissionRuntime) {
  const current = toSnapshot(runtime.source);
  if (runtime.source.revision() === runtime.revision && sameSession(runtime.baseline, current)) return true;
  if (!runtime.initialized && canAdoptInitialSession(admission, runtime.baseline, current)) {
    runtime.baseline = current;
    runtime.revision = runtime.source.revision();
    runtime.initialized = true;
    return true;
  }
  return false;
}

/** Capture before a page read starts; the result keeps this exact source, revision and session tuple. */
export function captureSpacePageAdmission(
  client: QueryClient,
  input: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
): SpacePageAdmission {
  const source = spacePageSessionSource(client);
  const current = toSnapshot(source);
  const admission: SpacePageAdmission = {
    readId: `${source.id}:${++nextReadId}`,
    sourceId: source.id,
    sessionRevision: source.revision(),
    sessionState: current.state,
    sessionTupleFingerprint: sessionTupleFingerprint(current),
    sessionDataUpdateCount: current.dataUpdateCount,
    sessionDataUpdatedAt: current.dataUpdatedAt,
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
  const runtime = resolveRuntime(admission, client);
  return !!runtime && runtimeIsCurrent(admission, runtime);
}

export function spacePageAdmissionIsAvailable(admission: SpacePageAdmission) {
  if (!claimedAdmissions.has(admission)) return true;
  return activeAdmissions.get(admission)?.current() ?? false;
}

export function bindSpacePageResult(page: SpacePageData, admission: SpacePageAdmission) {
  const bound: SpacePageAdmission = { ...admission, realmId: page.realm?.id ?? null };
  const runtime = runtimes.get(admission);
  if (runtime) runtimes.set(bound, runtime);
  resultAdmissions.set(page, bound);
  return bound;
}

export function getSpacePageAdmission(page: SpacePageData) {
  return resultAdmissions.get(page);
}

export function bindRealmPageResult(
  located: { kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string },
  admission: SpacePageAdmission,
) {
  realmReadAdmissions.set(located, admission);
  return admission;
}

export function getRealmPageAdmission(
  located: { kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string },
) {
  return realmReadAdmissions.get(located);
}

/** Reattach the serialized loader admission after hydration without granting new authority. */
export function bindHydratedSpacePage(
  page: SpacePageData,
  admission: SpacePageAdmission,
  client: QueryClient,
  expected: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
) {
  if (!spacePageAdmissionIsAvailable(admission)) return false;
  if (
    admission.target.kind !== expected.target.kind ||
    (admission.target.kind === 'space' && expected.target.kind === 'space' && admission.target.address !== expected.target.address) ||
    (admission.target.kind === 'realm' && expected.target.kind === 'realm' && admission.target.id !== expected.target.id) ||
    admission.locale !== expected.locale ||
    admission.credentialMode !== expected.credentialMode ||
    admission.realmId !== (page.realm?.id ?? null)
  )
    return false;
  const runtime = resolveRuntime(admission, client);
  if (!runtime || !runtimeIsCurrent(admission, runtime)) return false;
  runtimes.set(admission, runtime);
  resultAdmissions.set(page, admission);
  return true;
}

export function spacePageAdmissionFor(
  page: SpacePageData,
  client: QueryClient,
  expected: { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode },
) {
  const admission = getSpacePageAdmission(page);
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
    if (!this.claimed && claimedAdmissions.has(this.admission)) this.retire(false);
    return !this.disposed;
  };

  current = () => this.connected && this.admitted();

  ticket = () => this.serial;

  owns = (ticket: number) => this.current() && this.serial === ticket;

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
      this.serial++;
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
    admission.sessionRevision,
    admission.sessionDataUpdateCount,
    admission.sessionDataUpdatedAt,
    admission.sessionState,
    admission.sessionTupleFingerprint,
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
