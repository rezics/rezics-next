import { QueryClientContext, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { operationIsAdmitted, useOperation } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery, type ViewerExposure } from '../kernel/viewer-exposure';
import { AnonymousSessionContext, sessionQuery, useSession } from '../session/query';
import { normalizeSessionObservation } from '../session/browser-state';

type Operation = 'order.create' | 'order.list' | 'order.get' | 'entitlement.get';
type Observation = {
  state: 'unknown' | 'signed-in' | 'signed-out' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
  admitted: boolean;
  readId?: number | undefined;
};

function observe(client: QueryClient, operation: Operation, anonymous: boolean): Observation {
  const session = client.getQueryState(sessionQuery.queryKey);
  const data = session?.status === 'success' ? normalizeSessionObservation(session.data) : undefined;
  const state = anonymous ? 'signed-out' : session?.status === 'error' ? 'unavailable' : (data?.state ?? 'unknown');
  const subject = state === 'signed-in' && typeof data?.subject === 'string' && data.subject ? data.subject : null;
  const csrfToken =
    state === 'signed-in' && typeof data?.csrfToken === 'string' && data.csrfToken ? data.csrfToken : null;
  if (state === 'signed-out') {
    const exposure = client.getQueryState<readonly string[]>(['exposure', 'anonymous']);
    return {
      state,
      subject: null,
      csrfToken: null,
      admitted: exposure?.status === 'success' && operationIsAdmitted(operation, exposure.data),
    };
  }
  const lifetime = viewerExposureLifetime(client).getSnapshot();
  const enrolled = lifetime.state === 'signed-in' ? lifetime.observation : undefined;
  const exposure = enrolled ? client.getQueryState<ViewerExposure>(viewerExposureQuery(enrolled).queryKey) : undefined;
  return {
    state,
    subject,
    csrfToken,
    readId: enrolled?.id,
    admitted:
      !!subject &&
      enrolled?.subject === subject &&
      exposure?.status === 'success' &&
      exposure.data?.subject === enrolled.subject &&
      operationIsAdmitted(operation, exposure.data.admitted),
  };
}

const identity = (value: Observation) => JSON.stringify([value.state, value.subject, value.admitted, value.readId]);

/** A read episode retires synchronously, including cache ABA before React commits. */
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
    // Intent ownership outlives unavailable/closed reads, but never a replacement viewer or address.
    private intent = false,
  ) {
    this.observed = read();
    this.identity = identity(this.observed);
  }

  observe = () => {
    if (this.retired) return;
    const next = this.read();
    const replaced = this.intent
      ? (!!next.subject && next.subject !== this.observed.subject) ||
        (next.state === 'signed-out' && this.observed.state !== 'signed-out') ||
        (this.observed.state === 'signed-out' && next.state === 'signed-in')
      : identity(next) !== this.identity;
    if (replaced) this.retire();
  };

  isObserved = () => {
    this.observe();
    return !this.retired && (!this.mounted || this.users > 0);
  };
  isCurrent = () =>
    this.isObserved() && this.observed.state === 'signed-in' && !!this.observed.subject && this.observed.admitted;
  isPublic = () => this.isObserved() && this.observed.state === 'signed-out' && this.observed.admitted;
  // A deliberate action may capture this value once. It is never a retry credential source.
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

  mount = () => {
    this.users++;
    this.mounted = true;
    if (!this.retired && !this.release && this.client) {
      // Enroll in the installed lifetime, rather than treating its scoped key as a global cache.
      const lifetime = viewerExposureLifetime(this.client).subscribe(this.observe);
      const cache = this.client.getQueryCache().subscribe(({ query }) => {
        if (query.queryKey[0] === 'session' || query.queryKey[0] === 'exposure') this.observe();
      });
      if (this.retired) {
        cache();
        lifetime();
      } else
        this.release = () => {
          cache();
          lifetime();
        };
    }
    this.observe();
    return () => {
      this.users--;
      queueMicrotask(() => {
        if (this.users === 0) this.retire();
      });
    };
  };
}

const previewAnonymous = createContext(false);
const subscribe = () => () => {};
const serverSnapshot = () => false;

/** Hooks prepare the installed reads; provider-free examples cannot establish production authority. */
export function useBuyerCurrentOrigin(
  operation: Operation,
  address: string,
  intentAddress = address,
  routeMatches?: (pathname: string) => boolean,
) {
  const client = useContext(QueryClientContext);
  const anonymous = useContext(AnonymousSessionContext ?? previewAnonymous);
  const router = useRouter({ warn: false });
  const navigation = useRef({ router, pathname: router?.state.location.pathname });
  if (navigation.current.router !== router) navigation.current = { router, pathname: router?.state.location.pathname };
  const session = useSession();
  const admitted = useOperation(operation);
  const hydrated = useSyncExternalStore(subscribe, () => true, serverSnapshot);
  const fallback = useRef<Observation>(null!);
  fallback.current = {
    state: session.state,
    subject: session.state === 'signed-in' ? session.subject || null : null,
    csrfToken: session.csrfToken,
    admitted: !!client && admitted,
  };
  const read = () => {
    const value = client ? observe(client, operation, anonymous) : fallback.current;
    return router && routeMatches && !routeMatches(navigation.current.pathname ?? '')
      ? { ...value, admitted: false }
      : value;
  };
  const view = read();
  const key = JSON.stringify([address, identity(view)]);
  const [scope, setScope] = useState(() => ({
    client,
    anonymous,
    key,
    address: intentAddress,
    generation: 0,
    origin: new BuyerCurrentOrigin(read, client),
    intent: new BuyerCurrentOrigin(read, client, true),
  }));
  scope.origin.observe();
  scope.intent.observe();
  let current = scope;
  const replaceIntent =
    scope.client !== client || scope.anonymous !== anonymous || scope.address !== intentAddress || scope.intent.retired;
  if (replaceIntent || scope.key !== key || scope.origin.retired) {
    scope.origin.retire(false);
    if (replaceIntent) scope.intent.retire(false);
    current = {
      client,
      anonymous,
      key,
      address: intentAddress,
      generation: scope.generation + 1,
      origin: new BuyerCurrentOrigin(read, client),
      intent: replaceIntent ? new BuyerCurrentOrigin(read, client, true) : scope.intent,
    };
    setScope(current);
  }
  useLayoutEffect(() => current.origin.mount(), [current.origin]);
  useLayoutEffect(() => current.intent.mount(), [current.intent]);
  useLayoutEffect(() => {
    const href = router?.state.location.href;
    return router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
      navigation.current.pathname = toLocation.pathname;
      if (toLocation.href !== href) {
        current.origin.retire();
        current.intent.retire();
      }
    });
  }, [router, current.origin, current.intent]);
  useSyncExternalStore(current.origin.subscribe, current.origin.snapshot, serverSnapshot);
  useSyncExternalStore(current.intent.subscribe, current.intent.snapshot, serverSnapshot);
  const firstRead = useRef<BuyerCurrentOrigin | null>(null);
  if (!firstRead.current && current.origin.isCurrent()) firstRead.current = current.origin;
  return {
    ...view,
    hydrated,
    origin: current.origin,
    intent: current.intent,
    generation: current.generation,
    seed: !firstRead.current || firstRead.current === current.origin,
  };
}
