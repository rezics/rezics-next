import type { QueryClient } from '@tanstack/react-query';
import { normalizeSessionObservation, sessionQueryKey } from './browser-state';

export type BrowserCacheEvent = Parameters<Parameters<ReturnType<QueryClient['getQueryCache']>['subscribe']>[0]>[0];

export type BrowserReader = { subject: string; id: number };
export type BrowserObservationSnapshot =
  | { state: 'unknown' | 'inactive' | 'signed-out' }
  | { state: 'signed-in'; observation: BrowserReader };
const closedObservation: BrowserObservationSnapshot = { state: 'unknown' };
function isSessionKey(key: readonly unknown[]) {
  return key.length === 1 && key[0] === sessionQueryKey[0];
}

class BrowserObservation {
  private snapshot: BrowserObservationSnapshot = closedObservation;
  private listeners = new Set<() => void>();
  private stopQueryCache: (() => void) | undefined;
  private nextId = 0;
  private lastData?: unknown;
  private lastCsrfToken: unknown;
  private lastUpdatedAt = 0;
  private lastQuery: unknown;
  private lastCount = 0;
  private cacheListeners = new Set<(event: BrowserCacheEvent) => void>();
  private publications = new Set<() => void>();
  private retiredExposures: BrowserReader[] = [];
  private publicationQueued = false;

  constructor(private readonly client: QueryClient) {}

  getSnapshot = (): BrowserObservationSnapshot => this.snapshot;

  /** Cache observers retire authority in-stack; React subscribers publish after that stack. */
  publish = (notify: () => void): void => {
    this.publications.add(notify);
    this.queuePublication();
  };

  private queuePublication(): void {
    if (this.publicationQueued) return;
    this.publicationQueued = true;
    queueMicrotask(() => {
      // Keep the queue marked while removing queries: removal can itself produce cache events.
      const retired = this.retiredExposures;
      this.retiredExposures = [];
      for (const observation of retired) {
        this.client.removeQueries({
          queryKey: ['exposure', 'viewer', observation.subject, observation.id],
          exact: true,
        });
      }
      const publications = this.publications;
      this.publications = new Set();
      this.publicationQueued = false;
      for (const notify of publications) notify();
      if (this.retiredExposures.length || this.publications.size) this.queuePublication();
    });
  }

  /** The same lifetime, with cancellable, coalesced notification for useSyncExternalStore. */
  subscribeSnapshot = (listener: () => void): (() => void) => {
    const notify = () => listener();
    const stop = this.subscribe(() => this.publish(notify));
    return () => {
      stop();
      this.publications.delete(notify);
    };
  };

  /** All browser readers share this cache subscription; domain response identity stays local. */
  subscribeCache = (listener: (event: BrowserCacheEvent) => void): (() => void) => {
    this.cacheListeners.add(listener);
    const stop = this.subscribe(() => {});
    return () => {
      this.cacheListeners.delete(listener);
      stop();
    };
  };

  getServerSnapshot = (): BrowserObservationSnapshot => closedObservation;

  subscribe = (listener: () => void): (() => void) => {
    if (this.listeners.size === 0) {
      this.stopQueryCache = this.client.getQueryCache().subscribe((event) => {
        if (isSessionKey(event.query.queryKey)) this.reconcile();
        for (const notify of [...this.cacheListeners]) notify(event);
      });
      // A remount is a new incarnation even when the session cache still contains the same reader.
      this.reconcile(true);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.retireMountedIncarnation();
    };
  };

  private reconcile(forceFresh = false): void {
    const state = this.client.getQueryState(sessionQueryKey);
    const data = state?.status === 'success' ? normalizeSessionObservation(state.data) : undefined;
    if (state?.status !== 'success' || state.fetchStatus !== 'idle' || state.isInvalidated || !data) {
      this.lastData = undefined;
      this.lastCsrfToken = undefined;
      this.lastUpdatedAt = 0;
      this.transition({ state: 'unknown' });
      return;
    }

    if (data.state === 'signed-out') {
      this.lastData = state.data;
      this.lastQuery = this.client.getQueryCache().find({ queryKey: sessionQueryKey, exact: true });
      this.lastCount = state.dataUpdateCount;
      this.lastCsrfToken = data.csrfToken;
      this.lastUpdatedAt = state.dataUpdatedAt;
      this.transition({ state: 'signed-out' });
      return;
    }

    if (data.state !== 'signed-in' || typeof data.subject !== 'string' || !data.subject) {
      this.lastData = undefined;
      this.lastCsrfToken = undefined;
      this.lastUpdatedAt = 0;
      this.transition({ state: 'unknown' });
      return;
    }

    const current = this.snapshot;
    const currentObservation = current.state === 'signed-in' ? current.observation : undefined;
    if (
      !forceFresh &&
      currentObservation?.subject === data.subject &&
      this.lastQuery === this.client.getQueryCache().find({ queryKey: sessionQueryKey, exact: true }) &&
      this.lastCount === state.dataUpdateCount &&
      this.lastData === state.data &&
      this.lastCsrfToken === data.csrfToken &&
      this.lastUpdatedAt === state.dataUpdatedAt
    )
      return;

    this.lastData = state.data;
    this.lastQuery = this.client.getQueryCache().find({ queryKey: sessionQueryKey, exact: true });
    this.lastCount = state.dataUpdateCount;
    this.lastCsrfToken = data.csrfToken;
    this.lastUpdatedAt = state.dataUpdatedAt;
    this.transition({ state: 'signed-in', observation: { subject: data.subject, id: ++this.nextId } });
  }

  private transition(next: BrowserObservationSnapshot): void {
    const previous = this.snapshot;
    const previousObservation = previous.state === 'signed-in' ? previous.observation : undefined;
    const same =
      previous.state === next.state &&
      (previous.state !== 'signed-in' ||
        (next.state === 'signed-in' &&
          previous.observation.id === next.observation.id &&
          previous.observation.subject === next.observation.subject));
    if (same) return;

    this.snapshot = next;
    this.retireExposure(previousObservation);
    this.listeners.forEach((notify) => notify());
  }

  private retireExposure(observation: BrowserReader | undefined): void {
    if (!observation) return;
    // Its key is already inadmissible. Physical eviction must not update a sibling in render.
    this.retiredExposures.push(observation);
    this.queuePublication();
  }

  private retireMountedIncarnation(): void {
    this.stopQueryCache?.();
    this.stopQueryCache = undefined;
    this.lastData = undefined;
    this.lastCsrfToken = undefined;
    this.lastUpdatedAt = 0;
    const previous = this.snapshot;
    const previousObservation = previous.state === 'signed-in' ? previous.observation : undefined;
    this.snapshot = { state: 'inactive' };
    this.retireExposure(previousObservation);
  }
}

const observations = new WeakMap<QueryClient, BrowserObservation>();
export function browserObservation(client: QueryClient): BrowserObservation {
  let observation = observations.get(client);
  if (!observation) {
    observation = new BrowserObservation(client);
    observations.set(client, observation);
  }
  return observation;
}
