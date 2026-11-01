import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { sessionQuery } from '../../../session/query';

/** Token-free identity for one successful, prepared private read. */
export type OwnerReadObservation = {
  reader: string;
  admission: string;
};

/** Local write authority. The CSRF token stays in memory and is never part of provenance. */
export type OwnerCapture = {
  observation: OwnerReadObservation;
  csrfToken: string | null;
  sessionSignature: string;
  incarnation: number;
  route: string;
};

export type OwnerSnapshot = {
  capture: OwnerCapture | null;
  incarnation: number;
};

export function sameOwnerRead(
  left: OwnerReadObservation | null | undefined,
  right: OwnerReadObservation | null | undefined,
): boolean {
  return !!left && !!right && left.reader === right.reader && left.admission === right.admission;
}

export function hasValidOwnerCsrfToken(token: string | null | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{22}$/.test(token);
}

type SessionData = {
  state?: string;
  subject?: string | null;
  csrfToken?: string | null;
};

type ObservedSession = {
  reader: string;
  csrfToken: string | null;
  signature: string;
};

function observeSession(client: QueryClient): ObservedSession | null {
  const state = client.getQueryState(sessionQuery.queryKey);
  if (!state || state.status !== 'success') return null;
  const data = state.data as SessionData | undefined;
  if (data?.state !== 'signed-in' || !data.subject || typeof data.subject !== 'string') return null;
  const admission = `${state.dataUpdatedAt}:${state.dataUpdateCount}`;
  return {
    reader: data.subject,
    csrfToken: data.csrfToken ?? null,
    signature: `${data.subject}:${admission}`,
  };
}

function requestAdmission(observed: ObservedSession): string {
  return `${observed.signature.slice(observed.reader.length + 1)}:${crypto.randomUUID()}`;
}

/** Captured by a route loader before its original private read. */
export function captureOwnerRead(client: QueryClient): OwnerReadObservation | null {
  const observed = observeSession(client);
  return observed ? { reader: observed.reader, admission: requestAdmission(observed) } : null;
}

/** One mounted My Zones visit owns all private state and callbacks created during that visit. */
export class OwnerLifetime {
  private listeners = new Set<() => void>();
  private stopWatching: (() => void) | undefined;
  private observedSignature: string | null;
  private nextIncarnation = 0;
  private snapshotValue: OwnerSnapshot;
  private active = false;
  private hasSubscribed = false;
  private replayObservation: OwnerReadObservation | undefined;
  private replaySignature: string | null = null;
  private permanentlyRetiredSignature: string | null = null;

  constructor(
    private readonly client: QueryClient,
    readonly route: string,
    requestedObservation?: OwnerReadObservation | null,
  ) {
    const observed = observeSession(client);
    this.observedSignature = observed?.signature ?? null;
    this.snapshotValue = this.makeSnapshot(observed, requestedObservation);
  }

  snapshot = (): OwnerSnapshot => this.snapshotValue;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.active) {
      this.active = true;
      this.stopWatching = this.client.getQueryCache().subscribe(() => this.refresh());
      const observed = observeSession(this.client);
      if (this.hasSubscribed) {
        const replay = observed?.signature === this.replaySignature ? this.replayObservation : undefined;
        if (observed && observed.signature === this.permanentlyRetiredSignature && !replay) {
          this.observedSignature = observed.signature;
          this.snapshotValue = { capture: null, incarnation: ++this.nextIncarnation };
          this.notify();
        } else this.rotate(observed, replay);
        this.replayObservation = undefined;
        this.replaySignature = null;
      }
      else this.refresh(observed);
      this.hasSubscribed = true;
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.active) {
        this.stopWatching?.();
        this.stopWatching = undefined;
        this.active = false;
        if (this.snapshotValue.capture) {
          this.replaySignature = this.observedSignature;
          this.replayObservation = undefined;
        }
        this.observedSignature = null;
        this.nextIncarnation += 1;
        this.snapshotValue = { capture: null, incarnation: this.nextIncarnation };
      }
    };
  };

  capture(): OwnerCapture | null {
    return this.snapshotValue.capture;
  }

  isCurrent(capture: OwnerCapture | null | undefined): capture is OwnerCapture {
    return !!capture && this.snapshotValue.capture === capture;
  }

  owns(observation: OwnerReadObservation | undefined): boolean {
    const capture = this.snapshotValue.capture;
    return !!capture && sameOwnerRead(observation, capture.observation);
  }

  /** A response without matching prepared-reader provenance permanently retires this admission. */
  retire(capture?: OwnerCapture, notify = true, replayable = false): void {
    if (capture && !this.isCurrent(capture)) return;
    if (!this.snapshotValue.capture) return;
    const previous = this.snapshotValue.capture;
    this.observedSignature = previous.sessionSignature;
    this.replaySignature = replayable ? previous.sessionSignature : null;
    this.replayObservation = replayable ? previous.observation : undefined;
    this.permanentlyRetiredSignature = replayable ? this.permanentlyRetiredSignature : previous.sessionSignature;
    this.nextIncarnation += 1;
    this.snapshotValue = { capture: null, incarnation: this.nextIncarnation };
    if (notify) this.notify();
  }

  private makeSnapshot(
    observed: ObservedSession | null,
    requestedObservation?: OwnerReadObservation | null,
  ): OwnerSnapshot {
    const incarnation = ++this.nextIncarnation;
    const admission =
      observed &&
      requestedObservation?.reader === observed.reader &&
      /^\d+:\d+:[0-9a-f-]{36}$/.test(requestedObservation.admission) &&
      requestedObservation.admission.startsWith(`${observed.signature.slice(observed.reader.length + 1)}:`)
        ? requestedObservation.admission
        : observed
          ? requestAdmission(observed)
          : undefined;
    return {
      incarnation,
      capture: observed
        ? {
            observation: { reader: observed.reader, admission: admission! },
            csrfToken: observed.csrfToken,
            sessionSignature: observed.signature,
            incarnation,
            route: this.route,
          }
        : null,
    };
  }

  private refresh(observed = observeSession(this.client)): void {
    const signature = observed?.signature ?? null;
    if (signature === this.observedSignature) return;
    this.rotate(observed);
  }

  private rotate(observed: ObservedSession | null, requestedObservation?: OwnerReadObservation): void {
    this.observedSignature = observed?.signature ?? null;
    if (observed?.signature !== this.permanentlyRetiredSignature) this.permanentlyRetiredSignature = null;
    this.snapshotValue = this.makeSnapshot(observed, requestedObservation);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useOwnerLifetime(
  route: string,
  requestedObservation?: OwnerReadObservation | null,
): { lifetime: OwnerLifetime; snapshot: OwnerSnapshot } {
  const client = useQueryClient();
  const lifetime = useMemo(
    () => new OwnerLifetime(client, route, requestedObservation),
    [client, route, requestedObservation?.admission, requestedObservation?.reader],
  );
  const snapshot = useSyncExternalStore(lifetime.subscribe, lifetime.snapshot, lifetime.snapshot);
  useLayoutEffect(() => () => lifetime.retire(undefined, false, true), [lifetime]);
  return { lifetime, snapshot };
}
