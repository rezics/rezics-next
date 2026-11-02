import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { personalRead } from '../../kernel/query';
import type { useSession } from '../../session/query';
import { subjectOwnReactionQuery, type SubjectReactionQueryScope } from './subject-queries';
import type { SubjectOwnReaction, SubjectReactionKind } from './subject-reactions';

type SessionAdmission = ReturnType<typeof useSession>;
type ReactionScopeState = {
  base: string;
  key: string;
  view: string;
  generation: number;
  admission: number;
  reader: string | null;
  owners: Map<number, () => boolean>;
  retirement: number;
  healthy: boolean;
  recovering: boolean;
};

export type SubjectReactionOrigin = {
  key: string;
  reader: string | null;
  isCurrent(): boolean;
};

class SubjectReactionReaderRegistry {
  readonly id = ++nextRegistryId;
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly scopes = new Map<string, ReactionScopeState>();
  private readonly scopesByKey = new Map<string, ReactionScopeState>();
  private sessionIdentity: string;
  private sessionHealthy: boolean;
  private sessionAdmission = 0;

  constructor(private readonly client: QueryClient) {
    this.sessionIdentity = this.readSessionIdentity();
    this.sessionHealthy = client.getQueryState(['session'])?.status === 'success';
    client.getQueryCache().subscribe((event) => this.onCacheEvent(event));
  }

  private readSessionIdentity() {
    const session = this.client.getQueryData<SessionAdmission>(['session']);
    return JSON.stringify([
      this.client.getQueryState(['session'])?.status ?? 'missing',
      session?.state,
      session?.subject ?? null,
      session?.csrfToken ?? null,
    ]);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.revision;
  getServerSnapshot = () => 0;

  private notify() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  private onCacheEvent(
    event: Parameters<ReturnType<QueryClient['getQueryCache']>['subscribe']>[0] extends (event: infer T) => void
      ? T
      : never,
  ) {
    const query = event.query;
    if (query.queryKey.length === 1 && query.queryKey[0] === 'session') {
      if (
        event.type === 'added' ||
        event.type === 'removed' ||
        (event.type === 'updated' && (event.action.type === 'success' || event.action.type === 'error'))
      ) {
        const next = this.readSessionIdentity();
        const changed = next !== this.sessionIdentity;
        this.sessionIdentity = next;
        this.sessionHealthy = event.type !== 'removed' && this.client.getQueryState(['session'])?.status === 'success';
        // A committed success is a new observation even when structural sharing keeps every field equal.
        // Advance before notifying React so held responses and queued commands lose authority immediately.
        if (changed || (event.type === 'updated' && event.action.type === 'success')) {
          this.sessionAdmission++;
          this.notify();
        }
      }
      return;
    }

    const scopeKey = query.meta?.subjectReactionScope;
    if (typeof scopeKey !== 'string') return;
    const scope = this.scopesByKey.get(scopeKey);
    if (!scope || !this.hasDesiredOwner(scope) || scope.admission !== this.sessionAdmission) return;
    if (event.type === 'removed' || (event.type === 'updated' && event.action.type === 'error')) {
      scope.healthy = false;
      scope.recovering = false;
      this.notify();
    } else if (event.type === 'updated' && event.action.type === 'success' && scope.recovering) {
      scope.recovering = false;
      this.notify();
    }
  }

  currentSession(session: SessionAdmission) {
    const queryState = this.client.getQueryState(['session']);
    const cached = this.client.getQueryData<SessionAdmission>(['session']);
    const ready =
      this.sessionHealthy &&
      queryState?.status === 'success' &&
      cached !== undefined &&
      cached.state === session.state &&
      (cached.subject ?? null) === (session.subject ?? null) &&
      cached.csrfToken === session.csrfToken;
    const reader =
      ready && cached?.state === 'signed-in' && typeof cached.subject === 'string' && cached.subject
        ? cached.subject
        : null;
    return { ready, reader, admission: this.sessionAdmission };
  }

  scope(base: string, admission: number, reader: string | null, view: string) {
    let scope = this.scopes.get(base);
    if (!scope) {
      scope = this.createScope(base, admission, reader, view, false);
    }
    return scope;
  }

  private createScope(base: string, admission: number, reader: string | null, view: string, recovering: boolean) {
    const generation = ++nextScopeId;
    const scope: ReactionScopeState = {
      base,
      key: JSON.stringify([this.id, base, generation]),
      view,
      generation,
      admission,
      reader,
      owners: new Map(),
      retirement: 0,
      healthy: true,
      recovering,
    };
    this.scopes.set(base, scope);
    this.scopesByKey.set(scope.key, scope);
    this.deferDelete(scope);
    return scope;
  }

  private hasAdmittedOwner(scope: ReactionScopeState, isDesired: () => boolean) {
    if (
      this.scopes.get(scope.base) !== scope ||
      scope.admission !== this.sessionAdmission ||
      !this.sessionHealthy ||
      this.client.getQueryState(['session'])?.status !== 'success' ||
      !isDesired()
    )
      return false;
    const cached = this.client.getQueryData<SessionAdmission>(['session']);
    if (scope.reader !== null && (cached?.state !== 'signed-in' || cached.subject !== scope.reader)) return false;
    return [...scope.owners.values()].some((ownerIsDesired) => ownerIsDesired());
  }

  recoveryFailed(scope: ReactionScopeState, isDesired: () => boolean) {
    return !scope.healthy && this.hasAdmittedOwner(scope, isDesired);
  }

  recoveryPending(scope: ReactionScopeState, isDesired: () => boolean) {
    return scope.recovering && this.hasAdmittedOwner(scope, isDesired);
  }

  recover(scope: ReactionScopeState, isDesired: () => boolean) {
    if (scope.healthy || !this.hasAdmittedOwner(scope, isDesired)) return false;
    this.scopesByKey.delete(scope.key);
    this.createScope(scope.base, scope.admission, scope.reader, scope.view, true);
    this.notify();
    return true;
  }

  private deferDelete(scope: ReactionScopeState) {
    const retirement = ++scope.retirement;
    queueMicrotask(() => {
      if (scope.owners.size !== 0 || scope.retirement !== retirement || this.scopes.get(scope.base) !== scope) return;
      this.scopes.delete(scope.base);
      this.scopesByKey.delete(scope.key);
      this.notify();
    });
  }

  register(scope: ReactionScopeState, isDesired: () => boolean) {
    const ownerId = ++nextOwnerId;
    scope.owners.set(ownerId, isDesired);
    scope.retirement++;
    let live = true;
    const isCurrent = () => live && this.isCurrent(scope, isDesired);
    return {
      key: scope.key,
      reader: scope.reader,
      isCurrent,
      retire: () => {
        if (!live) return;
        live = false;
        scope.owners.delete(ownerId);
        if (scope.owners.size === 0) this.deferDelete(scope);
      },
    };
  }

  hasLiveObserver(scope: ReactionScopeState) {
    return this.scopes.get(scope.base) === scope && scope.owners.size > 0 && scope.healthy;
  }

  hasDesiredOwner(scope: ReactionScopeState) {
    if (!this.hasLiveObserver(scope)) return false;
    for (const isDesired of scope.owners.values()) if (isDesired()) return true;
    return false;
  }

  private isCurrent(scope: ReactionScopeState, isDesired: () => boolean) {
    if (!isDesired() || !this.hasDesiredOwner(scope) || scope.admission !== this.sessionAdmission) return false;
    if (!this.sessionHealthy || this.client.getQueryState(['session'])?.status !== 'success') return false;
    if (scope.reader === null) return true;
    const cached = this.client.getQueryData<SessionAdmission>(['session']);
    return cached?.state === 'signed-in' && cached.subject === scope.reader;
  }

  isScopeCurrent(scope: ReactionScopeState, isDesired: () => boolean) {
    return this.isCurrent(scope, isDesired);
  }

  queryScope(scope: ReactionScopeState): SubjectReactionQueryScope {
    return {
      reader: scope.reader,
      admission: scope.admission,
      view: scope.view,
      cacheEpoch: scope.generation,
      scopeKey: scope.key,
      isCurrent: () => this.isCurrent(scope, () => this.hasDesiredOwner(scope)),
      hasLiveObserver: () => this.hasLiveObserver(scope),
    };
  }
}

let nextRegistryId = 0;
let nextScopeId = 0;
let nextOwnerId = 0;
const registries = new WeakMap<QueryClient, SubjectReactionReaderRegistry>();

function registryFor(client: QueryClient) {
  let registry = registries.get(client);
  if (!registry) {
    registry = new SubjectReactionReaderRegistry(client);
    registries.set(client, registry);
  }
  return registry;
}

function useSubjectReactionAdmission(input: {
  subjectId: string;
  locale: string;
  view: string;
  session: SessionAdmission;
  enabled?: boolean;
}) {
  const { subjectId, locale, view, session, enabled: routeEnabled = true } = input;
  const client = useQueryClient();
  const registry = useMemo(() => registryFor(client), [client]);
  useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getServerSnapshot);
  const current = registry.currentSession(session);
  const { reader, admission } = current;

  const routeSignature = JSON.stringify([subjectId, locale, view, routeEnabled]);
  const routeState = useRef({ signature: routeSignature, revision: 0 });
  if (routeState.current.signature !== routeSignature) {
    routeState.current = { signature: routeSignature, revision: routeState.current.revision + 1 };
  }
  const routeRevision = routeState.current.revision;
  const base = JSON.stringify([registry.id, subjectId, locale, view, reader, admission, routeRevision]);
  const scope = routeEnabled ? registry.scope(base, admission, reader, view) : undefined;
  const token =
    scope?.key ?? JSON.stringify([registry.id, subjectId, locale, view, admission, routeRevision, 'inactive']);
  const desired = useRef(token);
  desired.current = token;
  const [leaseState, setLeaseState] = useState<{
    token: string;
    lease: ReturnType<SubjectReactionReaderRegistry['register']>;
  } | null>(null);

  useLayoutEffect(() => {
    if (!routeEnabled || !scope) {
      setLeaseState(null);
      return;
    }
    const lease = registry.register(scope, () => desired.current === token);
    setLeaseState({ token, lease });
    return () => lease.retire();
  }, [registry, routeEnabled, scope, token]);

  const lease = leaseState?.token === token && leaseState.lease.isCurrent() ? leaseState.lease : undefined;
  const active = Boolean(current.ready && routeEnabled && lease?.isCurrent());
  const queryScope = scope ? registry.queryScope(scope) : undefined;
  const origin = useMemo<SubjectReactionOrigin>(
    () => ({
      key: token,
      reader,
      isCurrent: () => Boolean(scope && registry.isScopeCurrent(scope, () => desired.current === token)),
    }),
    [token, reader, registry, scope],
  );
  const isDesired = useCallback(() => desired.current === token, [token]);
  const retryOwnReaction = useCallback(() => {
    if (scope && reader !== null && current.ready) registry.recover(scope, isDesired);
  }, [current.ready, isDesired, reader, registry, scope]);

  return {
    key: token,
    reader,
    admission,
    active,
    origin,
    queryScope,
    recoveryFailed: Boolean(scope && reader !== null && registry.recoveryFailed(scope, isDesired)),
    recoveryPending: Boolean(scope && reader !== null && registry.recoveryPending(scope, isDesired)),
    retryOwnReaction,
  };
}

export function useSubjectReactionReader(input: {
  subjectId: string;
  locale: string;
  view: string;
  session: SessionAdmission;
  enabled?: boolean;
}) {
  const client = useQueryClient();
  const admission = useSubjectReactionAdmission(input);
  const ownReactionQuery = subjectOwnReactionQuery(
    input.subjectId,
    input.locale,
    admission.queryScope ?? {
      reader: null,
      admission: admission.admission,
      view: input.view,
      cacheEpoch: 0,
      scopeKey: admission.key,
      isCurrent: () => false,
      hasLiveObserver: () => false,
    },
  );
  const query = useQuery({
    ...ownReactionQuery,
    enabled:
      personalRead.enabled && admission.active && admission.reader !== null && admission.queryScope !== undefined,
  });
  const privateRead =
    admission.active && admission.reader !== null && query.isSuccess && query.data.reader === admission.reader;
  const ownReaction: SubjectOwnReaction | undefined = privateRead ? query.data : undefined;
  const applyMutation = useCallback(
    (value: SubjectReactionKind | null) => {
      const reader = admission.reader;
      const origin = admission.origin;
      if (!reader || !origin.isCurrent()) return;
      client.setQueryData<SubjectOwnReaction>(ownReactionQuery.queryKey, (current) =>
        current?.reader === reader && origin.isCurrent() ? { ...current, value } : current,
      );
    },
    [admission.key, admission.origin, admission.reader, client],
  );
  return {
    ...admission,
    ownReaction,
    ready: privateRead,
    applyMutation,
  };
}

export function useSubjectReactionAdmissionForZone(input: {
  subjectId: string;
  locale: string;
  view: string;
  session: SessionAdmission;
  enabled?: boolean;
}) {
  return useSubjectReactionAdmission(input);
}
