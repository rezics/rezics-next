import type { QueryClient } from '@tanstack/react-query';
import { normalizeSessionObservation, sessionQueryKey } from './browser-state';

export type BrowserCacheEvent = Parameters<
  Parameters<ReturnType<QueryClient['getQueryCache']>['subscribe']>[0]
>[0];

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

  constructor(private readonly client: QueryClient) {}

  getSnapshot = (): BrowserObservationSnapshot => this.snapshot;

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
    if (previousObservation) {
      this.client.removeQueries({
        queryKey: ['exposure', 'viewer', previousObservation.subject, previousObservation.id],
        exact: true,
      });
    }
    this.listeners.forEach((notify) => notify());
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
    if (previousObservation) {
      this.client.removeQueries({
        queryKey: ['exposure', 'viewer', previousObservation.subject, previousObservation.id],
        exact: true,
      });
    }
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
