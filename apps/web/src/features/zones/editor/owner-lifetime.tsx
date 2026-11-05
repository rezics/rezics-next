import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { getLocale } from '../../../paraglide/runtime.js';
import { sessionQuery } from '../../../session/query';

/** Token-free identity for one successful, prepared private read. */
export type OwnerReadObservation = { reader: string; admission: string };

/** Local write authority. Credentials and Query identity never enter provenance. */
export type OwnerCapture = {
  observation: OwnerReadObservation;
  csrfToken: string | null;
  sessionSignature: string;
  incarnation: number;
  route: string;
};
export type OwnerSnapshot = { capture: OwnerCapture | null; incarnation: number };

export function sameOwnerRead(
  left: OwnerReadObservation | null | undefined,
  right: OwnerReadObservation | null | undefined,
): boolean {
  return !!left && !!right && left.reader === right.reader && left.admission === right.admission;
}
export function hasValidOwnerCsrfToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{22}$/.test(token);
}
type SessionData = { state?: string; subject?: string | null; csrfToken?: string | null };
type ObservedSession = {
  query: object;
  facts: string;
  reader: string;
  csrfToken: string | null;
  signature: string;
  counters: string;
};

/** One observer of the existing cache, installed before any loader capture. Cache events
 * are synchronous, so equal-counter Query replacement and batched A-B-A cannot disappear
 * inside React's notification batching. Only the latest observation is retained. */
class SessionObservations {
  private value: ObservedSession | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly client: QueryClient) {
    this.read();
    client.getQueryCache().subscribe(() => {
      const previous = this.value;
      this.read();
      if (previous !== this.value) for (const listener of this.listeners) listener();
    });
  }
  read = (): ObservedSession | null => {
    const query = this.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    const state = query?.state;
    const data = state?.data as SessionData | undefined;
    if (
      !query ||
      state?.status !== 'success' ||
      data?.state !== 'signed-in' ||
      typeof data.subject !== 'string' ||
      !data.subject
    ) {
      this.value = null;
      return null;
    }
    const facts = JSON.stringify([
      data.state,
      data.subject,
      data.csrfToken ?? null,
      state.dataUpdatedAt,
      state.dataUpdateCount,
    ]);
    if (this.value?.query !== query || this.value.facts !== facts)
      this.value = {
        query,
        facts,
        reader: data.subject,
        csrfToken: data.csrfToken ?? null,
        signature: crypto.randomUUID(),
        counters: `${state.dataUpdatedAt}:${state.dataUpdateCount}`,
      };
    return this.value;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}
const observations = new WeakMap<QueryClient, SessionObservations>();
function sessionObservations(client: QueryClient) {
  let store = observations.get(client);
  if (!store) {
    store = new SessionObservations(client);
    observations.set(client, store);
  }
  return store;
}
// A serialized observation has no local witness and must obtain a fresh browser read.
// Weak keys retain neither loader history nor retired Query objects globally.
const loaderWitnesses = new WeakMap<
  OwnerReadObservation,
  {
    session: ObservedSession;
    signal?: AbortSignal;
    visit?: OwnerLifetime;
  }
>();
function readObservation(observed: ObservedSession): OwnerReadObservation {
  return { reader: observed.reader, admission: `${observed.counters}:${crypto.randomUUID()}` };
}
export function captureOwnerRead(client: QueryClient, signal?: AbortSignal): OwnerReadObservation | null {
  const observed = sessionObservations(client).read();
  if (!observed || signal?.aborted) return null;
  const observation = readObservation(observed);
  loaderWitnesses.set(observation, { session: observed, ...(signal ? { signal } : {}) });
  return observation;
}

/** One mounted private visit owns every callback, draft and immutable command. */
export class OwnerLifetime {
  private listeners = new Set<() => void>();
  private stopWatching: (() => void) | undefined;
  private readonly sessions: SessionObservations;
  private observed: ObservedSession | null;
  private nextIncarnation = 0;
  private snapshotValue: OwnerSnapshot;
  private active = false;
  private subscribed = false;
  private suspended = false;
  private retiredSession: ObservedSession | null = null;
  private replayObservation: OwnerReadObservation | undefined;
  private ended = false;

  constructor(
    client: QueryClient,
    readonly route: string,
    private readonly requestedObservation?: OwnerReadObservation | null,
    private readonly targetCurrent: () => boolean = () => true,
  ) {
    this.sessions = sessionObservations(client);
    this.observed = this.sessions.read();
    this.snapshotValue = this.makeSnapshot(this.observed, requestedObservation);
  }
  snapshot = (): OwnerSnapshot => {
    this.refresh();
    return this.snapshotValue;
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.active) {
      this.active = true;
      this.suspended = false;
      this.stopWatching = this.sessions.subscribe(() => this.refresh());
      if (this.subscribed) {
        const observed = this.sessions.read();
        const replay = observed === this.observed ? this.replayObservation : undefined;
        this.snapshotValue = this.makeSnapshot(observed, replay);
        this.observed = observed;
        this.replayObservation = undefined;
        this.notify();
      } else {
        this.refresh();
        const witness = this.requestedObservation && loaderWitnesses.get(this.requestedObservation);
        if (
          witness &&
          this.snapshotValue.capture &&
          sameOwnerRead(this.snapshotValue.capture.observation, this.requestedObservation)
        )
          witness.visit = this;
      }
      this.subscribed = true;
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.active) {
        this.suspend();
        this.stopWatching?.();
        this.stopWatching = undefined;
        this.active = false;
      }
    };
  };
  capture(): OwnerCapture | null {
    this.refresh();
    return this.snapshotValue.capture;
  }
  isCurrent(capture: OwnerCapture | null | undefined): capture is OwnerCapture {
    this.refresh();
    return !!capture && this.snapshotValue.capture === capture;
  }
  owns(observation: OwnerReadObservation | undefined): boolean {
    return sameOwnerRead(observation, this.capture()?.observation);
  }
  /** A permanent route retirement must never be mistaken for effect replay. */
  end = () => {
    this.ended = true;
    this.retire();
  };
  /** Cleanup kills old callbacks immediately. Replay creates a NEW capture, never revives one. */
  suspend = () => {
    this.suspended = true;
    if (!this.snapshotValue.capture) return;
    this.replayObservation = this.snapshotValue.capture.observation;
    this.snapshotValue = { capture: null, incarnation: ++this.nextIncarnation };
  };
  retire(capture?: OwnerCapture, notify = true): void {
    if (capture && !this.isCurrent(capture)) return;
    if (!this.snapshotValue.capture) return;
    this.retiredSession = this.observed;
    this.replayObservation = undefined;
    this.snapshotValue = { capture: null, incarnation: ++this.nextIncarnation };
    if (notify) this.notify();
  }
  private makeSnapshot(observed: ObservedSession | null, requested?: OwnerReadObservation | null): OwnerSnapshot {
    const incarnation = ++this.nextIncarnation;
    if (!observed || this.ended || observed === this.retiredSession || !this.targetCurrent())
      return { capture: null, incarnation };
    const witness = requested && loaderWitnesses.get(requested);
    const admitted =
      witness?.session === observed && !witness.signal?.aborted && (!witness.visit || witness.visit === this);
    return {
      incarnation,
      capture: {
        observation: admitted ? requested! : readObservation(observed),
        csrfToken: observed.csrfToken,
        sessionSignature: observed.signature,
        incarnation,
        route: this.route,
      },
    };
  }
  private refresh(): void {
    if (this.suspended) return;
    if (!this.targetCurrent()) {
      if (!this.ended) this.end();
      return;
    }
    const observed = this.sessions.read();
    if (observed === this.observed || this.ended) return;
    this.observed = observed;
    this.replayObservation = undefined;
    this.snapshotValue = this.makeSnapshot(observed);
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useOwnerLifetime(route: string, requestedObservation?: OwnerReadObservation | null) {
  const client = useQueryClient();
  const router = useRouter();
  const previous = useRef<OwnerLifetime | null>(null);
  const lifetime = useMemo(() => {
    const href = router.latestLocation.href;
    const locale = getLocale();
    return new OwnerLifetime(
      client,
      route,
      requestedObservation,
      () => router.latestLocation.href === href && getLocale() === locale,
    );
  }, [client, router, route, requestedObservation?.admission, requestedObservation?.reader]);
  if (previous.current !== lifetime) {
    previous.current?.end();
    previous.current = lifetime;
  }
  const snapshot = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  useLayoutEffect(() => {
    const stop = router.subscribe('onBeforeNavigate', () => {
      lifetime.capture();
    });
    return () => {
      stop();
      lifetime.suspend();
    };
  }, [lifetime, router]);
  return { lifetime, snapshot };
}
