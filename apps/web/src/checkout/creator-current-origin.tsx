import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery } from '../kernel/viewer-exposure';
import { sessionQuery } from '../session/query';
import type { CreatorOfferGuard } from './creator-offers';

type Operation = 'offer.list' | 'payout_statement.list' | 'commerce_sale.list';
export const creatorPreviewGuard: CreatorOfferGuard = { isCurrent: () => false, csrfToken: () => null };
type Observation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
  admission: 'preparing' | 'admitted' | 'closed' | 'unavailable';
  observation: number | null;
  exposure: number | null;
};
type Slot<T> = { value?: T };
type Workspace = {
  subject: string | null;
  initial: boolean;
  read: unknown;
  intents: Map<string, Slot<unknown>>;
};
const workspace = (subject: string | null): Workspace => ({
  subject,
  initial: true,
  read: undefined,
  intents: new Map(),
});
const closed: Observation = {
  state: 'unknown',
  subject: null,
  csrfToken: null,
  admission: 'preparing',
  observation: null,
  exposure: null,
};

function observe(client: QueryClient | undefined, operation: Operation): Observation {
  if (!client) return closed;
  const session = client.getQueryState(sessionQuery.queryKey);
  const data = session?.status === 'success' ? session.data : undefined;
  const subject =
    data?.state === 'signed-in' && typeof data.subject === 'string' && data.subject.trim() ? data.subject : null;
  const lifetime = viewerExposureLifetime(client).getSnapshot();
  const observation =
    lifetime.state === 'signed-in' && lifetime.observation.subject === subject ? lifetime.observation : undefined;
  const exposure = observation ? client.getQueryState(viewerExposureQuery(observation).queryKey) : undefined;
  return {
    state:
      session?.status === 'error' || (data?.state === 'signed-in' && !subject)
        ? 'unavailable'
        : (data?.state ?? 'unknown'),
    subject,
    csrfToken: subject && typeof data?.csrfToken === 'string' && data.csrfToken.trim() ? data.csrfToken : null,
    observation: observation?.id ?? null,
    exposure: exposure?.dataUpdateCount ?? null,
    admission:
      exposure?.status === 'error'
        ? 'unavailable'
        : exposure?.status !== 'success'
          ? 'preparing'
          : exposure.data?.subject === subject && operationIsAdmitted(operation, exposure.data.admitted)
            ? 'admitted'
            : 'closed',
  };
}

const identity = (value: Observation) =>
  JSON.stringify([value.state, value.subject, value.admission, value.observation, value.exposure]);

/** An episode can retire from cache notifications, without waiting for a React render or commit. */
class CreatorCurrentOrigin implements CreatorOfferGuard {
  readonly id = crypto.randomUUID();
  readonly observed: Observation;
  retired = false;
  private users = 0;
  private mounted = false;
  private releases: (() => void)[] = [];
  private listeners = new Set<() => void>();

  constructor(
    private client: QueryClient | undefined,
    private operation: Operation,
    readonly workspace: Workspace,
    private expected?: string,
  ) {
    this.observed = observe(client, operation);
  }

  observe = () => {
    const next = observe(this.client, this.operation);
    if (
      next.state !== 'signed-in' ||
      next.subject !== this.workspace.subject ||
      (next.observation === this.observed.observation && next.exposure !== this.observed.exposure) ||
      next.admission === 'closed' ||
      next.admission === 'unavailable'
    )
      this.workspace.read = undefined;
    if (!this.retired && identity(next) !== identity(this.observed)) {
      // Same-owner healthy observation renewal can reuse the accepted read, but never its
      // in-flight response. Explicit authority loss discards the read, retaining only intent.
      if (
        this.observed.admission === 'admitted' ||
        next.state === 'signed-out' ||
        next.state === 'unavailable' ||
        (this.observed.subject && next.subject !== this.observed.subject) ||
        next.admission === 'closed' ||
        next.admission === 'unavailable'
      )
        this.workspace.initial = false;
      this.retire();
    }
    return next;
  };
  isCurrent = () => {
    const actual = this.observe();
    return (
      !this.retired &&
      (!this.mounted || this.users > 0) &&
      !!this.client &&
      actual.state === 'signed-in' &&
      !!actual.subject &&
      actual.admission === 'admitted' &&
      (!this.expected || actual.subject === this.expected)
    );
  };
  csrfToken = () => (this.isCurrent() ? observe(this.client, this.operation).csrfToken : null);
  snapshot = () => this.retired;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  retire = (notify = true) => {
    if (this.retired) return;
    this.retired = true;
    if (notify) this.listeners.forEach((listener) => listener());
  };
  mount = () => {
    this.mounted = true;
    this.users++;
    if (!this.retired && this.client && this.releases.length === 0) {
      this.releases.push(viewerExposureLifetime(this.client).subscribe(this.observe));
      this.releases.push(this.client.getQueryCache().subscribe(this.observe));
    }
    this.observe();
    return () => {
      this.users--;
      // StrictMode reconnects a live subscription; it never reactivates a retired episode.
      queueMicrotask(() => {
        if (this.users === 0) {
          this.retire();
          this.releases.splice(0).forEach((release) => release());
        }
      });
    };
  };
}

const subscribe = () => () => {};
const serverSnapshot = () => false;

export function useCreatorCurrentOrigin(operation: Operation, address: string, expected?: string) {
  const client = useContext(QueryClientContext);
  // This owns the existing session and subject-scoped exposure observers, adding no IO.
  useOperation(operation);
  const hydrated = useSyncExternalStore(subscribe, () => true, serverSnapshot);
  const view = observe(client, operation);
  const [scope, setScope] = useState(() => ({
    client,
    operation,
    address,
    expected,
    generation: 0,
    origin: new CreatorCurrentOrigin(
      client,
      operation,
      {
        ...workspace(view.subject),
        initial: view.state !== 'signed-out' && view.state !== 'unavailable',
      },
      expected,
    ),
  }));
  scope.origin.observe();
  let current = scope;
  if (
    scope.client !== client ||
    scope.operation !== operation ||
    scope.address !== address ||
    scope.expected !== expected ||
    scope.origin.retired
  ) {
    const previous = scope.origin.workspace;
    const sameWorkspace =
      scope.client === client &&
      scope.operation === operation &&
      scope.address === address &&
      scope.expected === expected &&
      (!view.subject || !previous.subject || previous.subject === view.subject);
    scope.origin.retire(false);
    const owner = sameWorkspace ? previous : workspace(view.subject);
    owner.subject = view.subject ?? owner.subject;
    if (!sameWorkspace) owner.initial = false;
    current = {
      client,
      operation,
      address,
      expected,
      generation: scope.generation + 1,
      origin: new CreatorCurrentOrigin(client, operation, owner, expected),
    };
    setScope(current);
  }
  useLayoutEffect(() => current.origin.mount(), [current.origin]);
  useSyncExternalStore(current.origin.subscribe, current.origin.snapshot, serverSnapshot);
  return { ...view, hydrated, ...current, seed: current.origin.workspace.initial };
}

/** Command operands and their known/uncertain outcome survive a same-workspace authority gap. */
export function useCreatorIntent<T>(guard: CreatorOfferGuard, key: string): Slot<T> {
  const [fallback] = useState<Slot<T>>(() => ({}));
  if (!(guard instanceof CreatorCurrentOrigin)) return fallback;
  const intents = guard.workspace.intents;
  let slot = intents.get(key);
  if (!slot) {
    slot = {};
    intents.set(key, slot);
  }
  return slot as Slot<T>;
}
