import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { QueryClient, QueryKey } from '@tanstack/react-query';

type SessionSnapshot = {
  state: string;
  subject: string | null;
  csrfToken: string | null;
};

type CallerOwner = {
  active: boolean;
  scope: CallerScope | null;
};

type CallerScope = {
  client: QueryClient;
  store: RealmMembershipLifetimeStore;
  realmId: string;
  subject: string;
  csrfToken: string | null;
  revision: number;
  session: SessionSnapshot;
  hasSessionSnapshot: boolean;
};

export type RealmMembershipCaller = {
  readonly client: QueryClient;
  readonly realmId: string;
  readonly subject: string;
  readonly csrfToken: string | null;
  readonly revision: number;
  readonly store: RealmMembershipLifetimeStore;
  isCurrent(): boolean;
  isReadCurrent(): boolean;
  isReady(): boolean;
};

type ActiveRead = {
  caller: RealmMembershipCaller;
  callerOwner: CallerOwner;
  callerScope: CallerScope;
  queryKey: QueryKey;
  retired: boolean;
  settled: boolean;
  retire(cancel: boolean): void;
};

export type RealmMembershipCommandAttempt = Readonly<{
  realmId: string;
  actor: string;
  credential: string;
  body: Readonly<{ realmId: string; action: 'join' | 'leave'; idempotencyKey: string }>;
  observation: number;
}>;

function readSessionSnapshot(client: QueryClient): SessionSnapshot | null {
  const data = client.getQueryData<Partial<SessionSnapshot>>(['session']);
  if (!data || typeof data.state !== 'string') return null;
  return {
    state: data.state,
    subject: typeof data.subject === 'string' ? data.subject : null,
    csrfToken: typeof data.csrfToken === 'string' ? data.csrfToken : null,
  };
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

function keyFor(realmId: string, subject: string): QueryKey {
  return ['realm-membership', realmId, subject];
}

export class RealmMembershipLifetimeStore {
  private revision = 0;
  private snapshot: SessionSnapshot | null;
  private readonly listeners = new Set<() => void>();
  private readonly reads = new Set<ActiveRead>();
  private readonly owners = new Map<string, Set<{ owner: CallerOwner; scope: CallerScope }>>();
  private readonly nativeCommands = new Map<string, RealmMembershipCommandAttempt>();

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getRevision = () => this.revision;

  constructor(readonly client: QueryClient) {
    this.snapshot = readSessionSnapshot(client);
    client.getQueryCache().subscribe(() => this.onQueryCacheChange());
  }

  currentSession(): SessionSnapshot | null {
    return this.snapshot;
  }

  currentRevision(): number {
    return this.revision;
  }

  nativeCommand(realmId: string, actor: string): RealmMembershipCommandAttempt | null {
    return this.nativeCommands.get(this.commandKey(realmId, actor)) ?? null;
  }

  retainNativeCommand(attempt: RealmMembershipCommandAttempt): RealmMembershipCommandAttempt {
    const key = this.commandKey(attempt.realmId, attempt.actor);
    const existing = this.nativeCommands.get(key);
    if (existing) return existing;
    const retained = Object.freeze({ ...attempt, body: Object.freeze({ ...attempt.body }) });
    this.nativeCommands.set(key, retained);
    return retained;
  }

  discardNativeCommand(realmId: string, actor: string, expected?: RealmMembershipCommandAttempt): void {
    const key = this.commandKey(realmId, actor);
    const current = this.nativeCommands.get(key);
    if (current && (!expected || current === expected)) this.nativeCommands.delete(key);
  }

  addRead(read: ActiveRead): void {
    this.reads.add(read);
  }

  registerOwner(owner: CallerOwner, scope: CallerScope): void {
    const key = this.ownerKey(scope);
    const entries = this.owners.get(key) ?? new Set();
    entries.add({ owner, scope });
    this.owners.set(key, entries);
  }

  unregisterOwner(owner: CallerOwner, scope: CallerScope): void {
    const key = this.ownerKey(scope);
    const entries = this.owners.get(key);
    if (!entries) return;
    for (const entry of entries) if (entry.owner === owner && entry.scope === scope) entries.delete(entry);
    if (!entries.size) this.owners.delete(key);
  }

  hasOtherCurrentOwner(owner: CallerOwner, scope: CallerScope): boolean {
    const entries = this.owners.get(this.ownerKey(scope));
    if (!entries) return false;
    for (const entry of entries) {
      if (
        entry.owner !== owner &&
        entry.owner.active &&
        entry.owner.scope === entry.scope &&
        this.scopeIsCurrent(entry.scope)
      )
        return true;
    }
    return false;
  }

  removeRead(read: ActiveRead): void {
    this.reads.delete(read);
  }

  retireOwner(owner: CallerOwner, scope?: CallerScope | null): void {
    if (scope) this.unregisterOwner(owner, scope);
    for (const read of this.reads) {
      if (
        read.callerOwner === owner &&
        (!scope || read.callerScope === scope) &&
        !this.hasOtherCurrentOwner(owner, read.callerScope)
      )
        read.retire(true);
    }
  }

  scopeIsCurrent(scope: CallerScope): boolean {
    return this.revision === scope.revision && matchesCaller(this.snapshot, scope);
  }

  private onQueryCacheChange(): void {
    const next = readSessionSnapshot(this.client);
    if (!sameSession(this.snapshot, next)) {
      this.snapshot = next;
      this.revision++;
      for (const read of this.reads) {
        if (!read.caller.isReadCurrent()) read.retire(true);
      }
      for (const listener of this.listeners) listener();
    }
    this.cleanupReads();
  }

  private cleanupReads(): void {
    for (const read of this.reads) {
      const query = this.client.getQueryCache().find({ queryKey: read.queryKey, exact: true });
      if (read.settled && (!query || query.state.fetchStatus !== 'fetching')) this.reads.delete(read);
    }
  }

  private ownerKey(scope: CallerScope): string {
    return JSON.stringify([scope.realmId, scope.subject, scope.csrfToken, scope.revision]);
  }

  private commandKey(realmId: string, actor: string): string {
    return JSON.stringify([realmId, actor]);
  }
}

// These are deliberately weakly keyed by the client and Query objects: authority history follows the existing
// session/query lifetime and does not become a second cache or retain evicted Realm keys.
const stores = new WeakMap<QueryClient, RealmMembershipLifetimeStore>();
const standingRevisions = new WeakMap<object, number | null>();
const observationVersions = new WeakMap<object, number>();
let nextObservationVersion = 1;

export function realmMembershipObservationVersion(observation: object): number {
  const existing = observationVersions.get(observation);
  if (existing !== undefined) return existing;
  const version = nextObservationVersion++;
  observationVersions.set(observation, version);
  return version;
}

function storeFor(client: QueryClient): RealmMembershipLifetimeStore {
  let store = stores.get(client);
  if (!store) {
    store = new RealmMembershipLifetimeStore(client);
    stores.set(client, store);
  }
  return store;
}

function matchesCaller(session: SessionSnapshot | null, scope: CallerScope): boolean {
  if (!session) return !scope.hasSessionSnapshot;
  return (
    session.state === 'signed-in' &&
    session.subject === scope.subject &&
    session.csrfToken === scope.csrfToken &&
    scope.session?.state === session.state &&
    scope.session.subject === session.subject &&
    scope.session.csrfToken === session.csrfToken
  );
}

/** Subscribe to notification-time session changes so batched A-B-A changes still retire prior callers. */
export function useRealmMembershipCaller(
  client: QueryClient,
  realmId: string,
  subject: string,
  csrfToken: string | null,
): RealmMembershipCaller {
  const store = storeFor(client);
  const revision = useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision);
  const ownerRef = useRef<CallerOwner | null>(null);
  if (!ownerRef.current) ownerRef.current = { active: true, scope: null };
  const owner = ownerRef.current;
  const currentSession = store.currentSession();
  const session = currentSession ?? { state: 'signed-in', subject, csrfToken };
  const scope = useMemo<CallerScope>(
    () => ({
      client,
      store,
      realmId,
      subject,
      csrfToken,
      revision,
      session,
      hasSessionSnapshot: currentSession !== null,
    }),
    [
      client,
      store,
      realmId,
      subject,
      csrfToken,
      revision,
      currentSession !== null,
      session.state,
      session.subject,
      session.csrfToken,
    ],
  );

  owner.scope = scope;

  useEffect(() => {
    owner.active = true;
    store.registerOwner(owner, scope);
    return () => {
      store.unregisterOwner(owner, scope);
      if (owner.scope === scope) owner.active = false;
      store.retireOwner(owner, scope);
    };
  }, [owner, store, scope]);

  return useMemo<RealmMembershipCaller>(
    () =>
      ({
        client,
        realmId,
        subject,
        csrfToken,
        revision,
        store,
        owner,
        scope,
        isCurrent: () => owner.active && owner.scope === scope && store.scopeIsCurrent(scope),
        isReadCurrent: () =>
          store.scopeIsCurrent(scope) &&
          scope.session.state === 'signed-in' &&
          !!subject &&
          !!csrfToken &&
          ((owner.active && owner.scope === scope) || store.hasOtherCurrentOwner(owner, scope)),
        isReady: () =>
          owner.active &&
          owner.scope === scope &&
          store.scopeIsCurrent(scope) &&
          scope.session?.state === 'signed-in' &&
          !!subject &&
          !!csrfToken,
      }) as RealmMembershipCaller,
    [client, realmId, subject, csrfToken, revision, store, owner, scope],
  );
}

/** Begin a deferred read bound to its original Realm, subject, credential, QueryClient and component. */
export function beginRealmMembershipRead(caller: RealmMembershipCaller, signal: AbortSignal, queryKey: QueryKey) {
  const owner = callerOwner(caller);
  const scope = callerScope(caller);
  const read: ActiveRead = {
    caller,
    callerOwner: owner,
    callerScope: scope,
    queryKey,
    retired: false,
    settled: false,
    retire(cancel) {
      if (read.retired) return;
      read.retired = true;
      if (cancel) void caller.client.cancelQueries({ queryKey, exact: true });
    },
  };
  caller.store.addRead(read);
  const onAbort = () => read.retire(false);
  signal.addEventListener('abort', onAbort, { once: true });
  return {
    assertCurrent() {
      if (signal.aborted || read.retired || !caller.isReadCurrent()) throw new Error('Realm membership caller retired');
    },
    finish() {
      signal.removeEventListener('abort', onAbort);
      read.settled = true;
      // React Query emits the final fetch-state notification after the query function settles.
      queueMicrotask(() => {
        const query = caller.client.getQueryCache().find({ queryKey, exact: true });
        if (!query || query.state.fetchStatus !== 'fetching') caller.store.removeRead(read);
      });
    },
  };
}

function callerOwner(caller: RealmMembershipCaller): CallerOwner {
  return (caller as RealmMembershipCaller & { owner: CallerOwner }).owner;
}

function callerScope(caller: RealmMembershipCaller): CallerScope {
  const scope = (caller as RealmMembershipCaller & { scope?: CallerScope }).scope;
  if (!scope) throw new Error('Realm membership caller binding is incomplete');
  return scope;
}

/** Mark only a read that completed under its still-current caller as the standing cache's current generation. */
export function recordRealmMembershipRead(caller: RealmMembershipCaller): void {
  if (!caller.isReadCurrent()) return;
  const query = caller.client.getQueryCache().find({
    queryKey: keyFor(caller.realmId, caller.subject),
    exact: true,
  });
  if (query) standingRevisions.set(query, caller.revision);
}

/** A prior success is usable only while its observed authority revision remains current. */
export function hasCurrentRealmMembership(
  client: QueryClient,
  realmId: string,
  subject: string,
  caller: RealmMembershipCaller,
): boolean {
  if (!caller.isReady()) return false;
  const query = client.getQueryCache().find({ queryKey: keyFor(realmId, subject), exact: true });
  if (!query || query.state.data === undefined) return false;
  let revision = standingRevisions.get(query);
  if (revision === undefined) {
    // Hydrated/bootstrap data remains compatible before the browser observes an authority transition. A read that
    // was already queued or in flight is explicitly untrusted until its bound caller completes.
    if (query.state.fetchStatus === 'fetching' && query.state.status !== 'success') {
      standingRevisions.set(query, null);
      return false;
    }
    revision = caller.revision;
    standingRevisions.set(query, revision);
  }
  return revision === caller.revision;
}
