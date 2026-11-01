import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { exposureQuery, sessionQuery, useSession } from '../session/query';

type Operation = 'order.list' | 'order.get' | 'entitlement.get';
type Observation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
  admitted: boolean;
};

function observe(client: QueryClient, operation: Operation): Observation {
  const session = client.getQueryState(sessionQuery.queryKey);
  const exposure = client.getQueryState(exposureQuery.queryKey);
  const data = session?.status === 'success' ? session.data : undefined;
  return {
    state: session?.status === 'error' ? 'unavailable' : (data?.state ?? 'unknown'),
    subject: data?.state === 'signed-in' ? data.subject || null : null,
    csrfToken: data?.state === 'signed-in' ? data.csrfToken || null : null,
    admitted: exposure?.status === 'success' && operationIsAdmitted(operation, exposure.data),
  };
}

// Nonempty same-viewer token rotation is healthy. Credential loss is a lifetime boundary.
const identity = (value: Observation) =>
  JSON.stringify([value.state, value.subject, !!value.csrfToken, value.admitted]);

/** Local buyer workflow authority. Cache events retire an origin before React can commit a replacement. */
export class BuyerCurrentOrigin {
  readonly id = crypto.randomUUID();
  readonly observed: Observation;
  private readonly identity: string;
  retired = false;
  private mounted = false;
  private users = 0;
  private release: (() => void) | undefined;
  private listeners = new Set<() => void>();
  private cancellations = new Set<() => void>();

  constructor(
    private read: () => Observation,
    private client?: QueryClient,
  ) {
    this.observed = read();
    this.identity = identity(this.observed);
  }

  observe = () => {
    if (!this.retired && identity(this.read()) !== this.identity) this.retire();
  };

  isObserved = () => {
    this.observe();
    return !this.retired && (!this.mounted || this.users > 0);
  };
  isCurrent = () =>
    this.isObserved() &&
    this.observed.state === 'signed-in' &&
    !!this.observed.subject &&
    !!this.observed.csrfToken &&
    this.observed.admitted;

  credential = () => (this.isCurrent() ? this.read().csrfToken : null);
  snapshot = () => this.retired;
  retire = (notify = true) => {
    if (this.retired) return;
    this.retired = true;
    this.release?.();
    this.release = undefined;
    this.cancellations.forEach((cancel) => cancel());
    this.cancellations.clear();
    if (notify) this.listeners.forEach((listener) => listener());
  };
  onRetire = (cancel: () => void) => {
    if (this.retired) cancel();
    else this.cancellations.add(cancel);
    return () => {
      this.cancellations.delete(cancel);
    };
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  // Observe in layout, before children's passive query dispatch and polling effects.
  mount = () => {
    this.users++;
    this.mounted = true;
    if (!this.retired && !this.release && this.client) {
      this.release = this.client.getQueryCache().subscribe(({ query }) => {
        const key = query.queryKey;
        if (
          (key.length === 1 && key[0] === 'session') ||
          (key.length === 2 && key[0] === 'exposure' && key[1] === 'viewer')
        )
          this.observe();
      });
    }
    this.observe();
    return () => {
      this.users--;
      // StrictMode may reconnect the same observation. A retired observation is never reactivated.
      queueMicrotask(() => {
        if (this.users === 0) this.retire();
      });
    };
  };
}

const subscribe = () => () => {};
const serverSnapshot = () => false;

/** Existing hooks prepare the same session/exposure reads; this adds no transport or expected viewer. */
export function useBuyerCurrentOrigin(operation: Operation, address: string) {
  const client = useContext(QueryClientContext);
  const session = useSession();
  const admitted = useOperation(operation);
  const hydrated = useSyncExternalStore(subscribe, () => true, serverSnapshot);
  const fallback = useRef<Observation>(null!);
  fallback.current = {
    state: session.state,
    subject: session.state === 'signed-in' ? session.subject || null : null,
    csrfToken: session.csrfToken,
    admitted,
  };
  // Only provider-free component examples use hook inputs; actual pages always observe the cache itself.
  const read = () => (client ? observe(client, operation) : fallback.current);
  const view = read();
  const key = JSON.stringify([address, identity(view)]);
  const [scope, setScope] = useState(() => ({
    client,
    key,
    generation: 0,
    origin: new BuyerCurrentOrigin(read, client),
  }));
  scope.origin.observe();
  let current = scope;
  if (scope.client !== client || scope.key !== key || scope.origin.retired) {
    scope.origin.retire(false);
    current = { client, key, generation: scope.generation + 1, origin: new BuyerCurrentOrigin(read, client) };
    setScope(current);
  }
  useLayoutEffect(() => current.origin.mount(), [current.origin]);
  useSyncExternalStore(current.origin.subscribe, current.origin.snapshot, serverSnapshot);
  return { ...view, hydrated, origin: current.origin, generation: current.generation, seed: current.generation === 0 };
}
