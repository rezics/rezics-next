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
  dataUpdateCount(): number;
  dataUpdatedAt(): number;
  snapshot(): number;
  subscribe(listener: () => void): () => void;
};

const sources = new WeakMap<QueryClient, SpaceSetupSessionSource>();
let nextSourceId = 0;
const consumedInitialSnapshots = new WeakSet<object>();
export type SpaceSetupInitialAdmission = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
  sessionRevision: number;
  dataUpdateCount: number;
  dataUpdatedAt: number;
};
const initialSnapshotSessions = new WeakMap<object, SpaceSetupInitialAdmission>();

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
  return {
    state: session?.state ?? 'unknown',
    subject: session?.subject ?? null,
    csrfToken: session?.csrfToken ?? null,
    sessionRevision: source.snapshot(),
    dataUpdateCount: source.dataUpdateCount(),
    dataUpdatedAt: source.dataUpdatedAt(),
  };
}

/** Attach the loader-start admission to its result without changing the public snapshot shape. */
export function bindSpaceSetupInitialSnapshot(snapshot: object, admission: SpaceSetupInitialAdmission) {
  initialSnapshotSessions.set(snapshot, admission);
}

/** A route snapshot is usable only under the cache state that admitted its original read. */
export function spaceSetupInitialSnapshotMatches(
  snapshot: object,
  source: SpaceSetupSessionSource | null,
  session: SpaceSetupSessionRecord | undefined,
) {
  const binding = initialSnapshotSessions.get(snapshot);
  if (!binding) return true;
  return (
    !!source &&
    !!session &&
    session.state === binding.state &&
    (session.subject ?? null) === binding.subject &&
    (session.csrfToken ?? null) === binding.csrfToken &&
    source.snapshot() === binding.sessionRevision &&
    source.dataUpdateCount() === binding.dataUpdateCount &&
    source.dataUpdatedAt() === binding.dataUpdatedAt
  );
}

function observeSpaceSetupSession(client: QueryClient): SpaceSetupSessionSource {
  const read = () => client.getQueryData<SpaceSetupSessionRecord>(sessionQuery.queryKey);
  const dataUpdateCount = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdateCount ?? 0;
  const dataUpdatedAt = () => client.getQueryState(sessionQuery.queryKey)?.dataUpdatedAt ?? 0;
  const identity = () => {
    const session = read();
    return JSON.stringify([
      session?.state ?? 'unknown',
      session?.subject ?? null,
      session?.csrfToken ?? null,
      dataUpdateCount(),
      dataUpdatedAt(),
    ]);
  };
  let previous = identity();
  let revision = 0;
  const listeners = new Set<() => void>();
  client.getQueryCache().subscribe(({ query }) => {
    if (query.queryKey.length !== 1 || query.queryKey[0] !== sessionQuery.queryKey[0]) return;
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
  readonly ready: boolean;
  readonly locale: string;
  readonly sessionSource: SpaceSetupSessionSource | null;
  readonly sessionRevision: number;
  readonly sessionDataUpdateCount: number;
  readonly sessionDataUpdatedAt: number;
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
      ready: true,
      locale: 'en',
      sessionSource: null,
      sessionRevision: 0,
      sessionDataUpdateCount: 0,
      sessionDataUpdatedAt: 0,
    },
    () => true,
    undefined,
    true,
  );
}
