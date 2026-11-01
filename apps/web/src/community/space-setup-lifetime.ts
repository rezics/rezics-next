import { createContext } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../session/query';

export type SpaceSetupSessionRecord = {
  state: string;
  subject?: string | null;
  csrfToken?: string | null;
};

export type SpaceSetupSessionSource = {
  readonly id: number;
  read(): SpaceSetupSessionRecord | undefined;
  observation(): SpaceSetupSessionObservation;
  dataUpdateCount(): number;
  dataUpdatedAt(): number;
  snapshot(): number;
  subscribe(listener: () => void): () => void;
};

export type SpaceSetupSessionObservation = {
  present: boolean;
  status: 'pending' | 'error' | 'success' | 'missing';
  dataUpdateCount: number;
  dataUpdatedAt: number;
  errorUpdateCount: number;
  errorUpdatedAt: number;
};

const sources = new WeakMap<QueryClient, SpaceSetupSessionSource>();
let nextSourceId = 0;
const consumedInitialSnapshots = new WeakSet<object>();
const initialAdmissionSources = new WeakMap<object, SpaceSetupSessionSource>();
export type SpaceSetupInitialAdmission = {
  state: string;
  subject: string | null;
  csrfAvailable: boolean;
  sessionRevision: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
  queryStatus: SpaceSetupSessionObservation['status'];
  errorUpdateCount: number;
  errorUpdatedAt: number;
  observationScope: 'query-client-local';
};

/** A loader snapshot seeds only its first browser visit, even if its caller remounts. */
export function claimSpaceSetupInitialSnapshot(snapshot: object) {
  if (consumedInitialSnapshots.has(snapshot)) return false;
  consumedInitialSnapshots.add(snapshot);
  return true;
}

/** Render-time check; the mounted page claims after commit so StrictMode's render replay is harmless. */
export function spaceSetupInitialSnapshotAvailable(snapshot: object) {
  return !consumedInitialSnapshots.has(snapshot);
}

/** Capture admission before the route loader starts its private setup read. */
export function captureSpaceSetupInitialAdmission(client: QueryClient): SpaceSetupInitialAdmission {
  const source = spaceSetupSessionSource(client);
  const session = source.read();
  const observation = source.observation();
  const admission: SpaceSetupInitialAdmission = {
    state: session?.state ?? 'unknown',
    subject: session?.subject ?? null,
    csrfAvailable: typeof session?.csrfToken === 'string' && session.csrfToken.length > 0,
    sessionRevision: source.snapshot(),
    dataUpdateCount: observation.dataUpdateCount,
    dataUpdatedAt: observation.dataUpdatedAt,
    queryStatus: observation.status,
    errorUpdateCount: observation.errorUpdateCount,
    errorUpdatedAt: observation.errorUpdatedAt,
    observationScope: 'query-client-local',
  };
  initialAdmissionSources.set(admission, source);
  return admission;
}

/** The serializable route envelope and its actual server reader must agree before hydration. */
export function spaceSetupInitialAdmissionMatchesReader(
  snapshot: { reader?: { kind: string; subject?: string } },
  admission: SpaceSetupInitialAdmission | undefined,
) {
  return Boolean(
    admission &&
    admission.observationScope === 'query-client-local' &&
    admission.queryStatus === 'success' &&
    admission.state === 'signed-in' &&
    admission.subject &&
    snapshot.reader?.kind === 'session' &&
    snapshot.reader.subject === admission.subject,
  );
}

/**
 * Cross-cache admission compares the expected identity and actual reader. QueryClient-local counters
 * are recorded for the original observation but cannot prove an unobserved cross-cache ABA.
 */
export function spaceSetupInitialSnapshotMatches(
  snapshot: { reader?: { kind: string; subject?: string } },
  source: SpaceSetupSessionSource | null,
  session: SpaceSetupSessionRecord | undefined,
  admission: SpaceSetupInitialAdmission | undefined,
) {
  const originalSource = admission ? initialAdmissionSources.get(admission) : undefined;
  const currentObservation = source?.observation();
  const sameObservedSource = originalSource === source && !!source;
  return (
    spaceSetupInitialAdmissionMatchesReader(snapshot, admission) &&
    !!source &&
    !!session &&
    currentObservation?.status === 'success' &&
    session.state === admission!.state &&
    (session.subject ?? null) === admission!.subject &&
    (typeof session.csrfToken === 'string' && session.csrfToken.length > 0) === admission!.csrfAvailable &&
    (!sameObservedSource ||
      (source.snapshot() === admission!.sessionRevision &&
        currentObservation.dataUpdateCount === admission!.dataUpdateCount &&
        currentObservation.dataUpdatedAt === admission!.dataUpdatedAt &&
        currentObservation.status === admission!.queryStatus &&
        currentObservation.errorUpdateCount === admission!.errorUpdateCount &&
        currentObservation.errorUpdatedAt === admission!.errorUpdatedAt))
  );
}

function observeSpaceSetupSession(client: QueryClient): SpaceSetupSessionSource {
  const read = () => client.getQueryData<SpaceSetupSessionRecord>(sessionQuery.queryKey);
  const observation = (): SpaceSetupSessionObservation => {
    const state = client.getQueryState(sessionQuery.queryKey);
    return {
      present: !!state,
      status: state?.status ?? 'missing',
      dataUpdateCount: state?.dataUpdateCount ?? 0,
      dataUpdatedAt: state?.dataUpdatedAt ?? 0,
      errorUpdateCount: state?.errorUpdateCount ?? 0,
      errorUpdatedAt: state?.errorUpdatedAt ?? 0,
    };
  };
  const dataUpdateCount = () => observation().dataUpdateCount;
  const dataUpdatedAt = () => observation().dataUpdatedAt;
  const identity = () => {
    const session = read();
    const seen = observation();
    return JSON.stringify([
      seen.present,
      seen.status,
      session?.state ?? 'unknown',
      session?.subject ?? null,
      session?.csrfToken ?? null,
      seen.dataUpdateCount,
      seen.dataUpdatedAt,
      seen.errorUpdateCount,
      seen.errorUpdatedAt,
    ]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe((event) => {
    const { query } = event;
    if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
    if (event.type === 'removed') {
      const next = identity();
      previous = next;
      revision++;
      for (const listener of listeners) listener();
      return;
    }
    const next = identity();
    if (next === previous) return;
    previous = next;
    revision++;
    for (const listener of listeners) listener();
  });
  return {
    id: ++nextSourceId,
    read,
    observation,
    dataUpdateCount,
    dataUpdatedAt,
    snapshot: () => revision,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Read-only observation of the existing QueryClient session entry. */
export function spaceSetupSessionSource(client: QueryClient): SpaceSetupSessionSource {
  let source = sources.get(client);
  if (!source) {
    source = observeSpaceSetupSession(client);
    sources.set(client, source);
  }
  return source;
}

export type SpaceSetupCallerBinding = {
  readonly targetSpaceId: string | null;
  readonly subject: string | null;
  readonly csrfToken: string | null;
  /** Read preparation can be healthy even when CSRF is unavailable for commands. */
  readonly readReady: boolean;
  readonly commandReady: boolean;
  /** Compatibility alias for callers that use ready to mean write authority. */
  readonly ready: boolean;
  readonly locale: string;
  readonly sessionSource: SpaceSetupSessionSource | null;
  readonly sessionRevision: number;
  readonly sessionDataUpdateCount: number;
  readonly sessionDataUpdatedAt: number;
  readonly sessionErrorUpdateCount: number;
  readonly sessionErrorUpdatedAt: number;
};

let nextLifetimeId = 0;
export class SpaceSetupCallerLifetime {
  readonly id = ++nextLifetimeId;
  private connected: boolean;
  private disposed = false;
  private serial = 0;
  private revision = 0;
  private stopWatching: (() => void) | undefined;
  private listeners = new Set<() => void>();

  constructor(
    readonly binding: SpaceSetupCallerBinding,
    private readonly valid: () => boolean,
    private readonly watch?: (listener: () => void) => () => void,
    initiallyConnected = false,
  ) {
    this.connected = initiallyConnected;
  }

  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  retire = (notify = true) => {
    if (this.disposed) return;
    this.disposed = true;
    this.serial++;
    this.stopWatching?.();
    this.stopWatching = undefined;
    if (notify) this.publish();
    else this.revision++;
  };

  snapshot = () => {
    if (!this.disposed && !this.valid()) this.retire(false);
    return this.revision;
  };

  current = () => {
    if (!this.disposed && !this.valid()) this.retire(false);
    return this.connected && !this.disposed;
  };

  ticket = () => this.serial;

  owns = (ticket: number) => this.current() && this.serial === ticket;

  isRetired = () => {
    this.snapshot();
    return this.disposed;
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.snapshot();
    return () => this.listeners.delete(listener);
  };

  /** Effect replay can reconnect this visit; work from the disconnected ticket stays retired. */
  connect = () => {
    if (this.disposed) return () => {};
    const wasConnected = this.connected;
    this.connected = true;
    if (!this.stopWatching && this.watch) {
      this.stopWatching = this.watch(() => {
        if (!this.disposed && !this.valid()) this.retire();
        else this.publish();
      });
      this.snapshot();
    }
    if (!wasConnected && !this.disposed) this.publish();
    return () => {
      if (!this.connected) return;
      this.connected = false;
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

export const SpaceSetupCallerLifetimeContext = createContext<SpaceSetupCallerLifetime | null>(null);

/** Isolated form stories and component consumers without the page's session adapter. */
export function standaloneSpaceSetupLifetime() {
  return new SpaceSetupCallerLifetime(
    {
      targetSpaceId: null,
      subject: null,
      csrfToken: null,
      readReady: true,
      commandReady: true,
      ready: true,
      locale: 'en',
      sessionSource: null,
      sessionRevision: 0,
      sessionDataUpdateCount: 0,
      sessionDataUpdatedAt: 0,
      sessionErrorUpdateCount: 0,
      sessionErrorUpdatedAt: 0,
    },
    () => true,
    undefined,
    true,
  );
}
