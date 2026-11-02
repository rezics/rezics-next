import { useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import { viewerExposureLifetime, viewerExposureQuery, type ViewerObservation } from '../kernel/viewer-exposure';
import { sessionQuery, useSession } from '../session/query';

export type ReadingAdmission = { readonly id: string; readonly allowed: boolean; retired: boolean };
type Snapshot = {
  viewer: string | null;
  owner: string | null;
  identity: object;
  observation: ViewerObservation | undefined;
  ready: boolean;
  healthyPause: boolean;
  admissions: ReadonlyMap<GatedOperation, ReadingAdmission>;
};
const emptySubscribe = () => () => {};

/** Only the actual successful scoped response grants authority. The durable viewer identity
 * survives healthy credential rotation; dispatch observations and operation episodes do not.
 */
export class ReadingAuthority {
  private listeners = new Set<() => void>();
  private release: (() => void) | undefined;
  private users = 0;
  private mounted = false;
  private lastQuery: object | undefined;
  private lastObservation: ViewerObservation | undefined;
  private snapshot: Snapshot = {
    viewer: null,
    owner: null,
    identity: {},
    observation: undefined,
    ready: false,
    healthyPause: false,
    admissions: new Map(),
  };
  constructor(
    private client: QueryClient,
    private operations: readonly GatedOperation[],
  ) {}
  read = () => this.snapshot;
  server = () => this.serverSnapshot;
  private serverSnapshot = this.snapshot;
  private retire(admissions: ReadonlyMap<GatedOperation, ReadingAdmission>) {
    for (const value of admissions.values()) value.retired = true;
  }
  private observe = () => {
    const session = this.client.getQueryState(sessionQuery.queryKey);
    const data = session?.data;
    const viewer =
      session?.status === 'success' && data?.state === 'signed-in' && data.subject ? data.subject : null;
    const previous = this.snapshot;
    // Unavailable authority closes every old admission, but keeps private uncertainty
    // for the last actual owner. A successful sign-out or different subject replaces it.
    const owner =
      session?.status === 'success' && data?.state === 'signed-out'
        ? null
        : session?.status === 'success' && data?.state === 'signed-in' && data.subject
          ? data.subject
          : previous.owner;
    const lifetime = viewerExposureLifetime(this.client).getSnapshot();
    const observation =
      viewer && lifetime.state === 'signed-in' && lifetime.observation.subject === viewer
        ? lifetime.observation
        : undefined;
    const options = viewerExposureQuery(observation);
    const query = observation
      ? this.client.getQueryCache().find({ queryKey: options.queryKey, exact: true })
      : undefined;
    const state = this.client.getQueryState(options.queryKey);
    const ready = !!viewer && !!observation && state?.status === 'success' && state.data?.subject === viewer;
    const identityChanged = owner !== previous.owner;
    const authorityLost = !!previous.viewer && !viewer;
    const observationChanged = observation !== this.lastObservation;
    // Removing/replacing/erroring the enrolled query retires its operations synchronously.
    // A new healthy session observation first removes its old key; that is a pause, not a denial.
    const rejected = state?.status === 'error' || (state?.status === 'success' && state.data?.subject !== viewer);
    const invalidated =
      (!observationChanged &&
        previous.ready &&
        !!this.lastQuery &&
        (query !== this.lastQuery || state?.status !== 'success' || state.data?.subject !== viewer)) ||
      (previous.healthyPause && rejected);
    const healthyPause =
      !!viewer &&
      !identityChanged &&
      !ready &&
      !invalidated &&
      !rejected &&
      (previous.healthyPause || (observationChanged && previous.ready));
    let changed =
      identityChanged ||
      viewer !== previous.viewer ||
      observation !== previous.observation ||
      ready !== previous.ready ||
      healthyPause !== previous.healthyPause;
    const admissions = new Map(previous.admissions);
    if (identityChanged || authorityLost || invalidated) {
      this.retire(admissions);
      changed = true;
    }
    for (const operation of this.operations) {
      const old = admissions.get(operation);
      const allowed = ready ? operationIsAdmitted(operation, state!.data!.admitted) : (old?.allowed ?? false);
      if (!old || old.retired || (ready && old.allowed !== allowed)) {
        if (old) old.retired = true;
        admissions.set(operation, { id: crypto.randomUUID(), allowed, retired: false });
        changed = true;
      }
    }
    this.lastObservation = observation;
    this.lastQuery = ready ? query : observationChanged ? undefined : this.lastQuery;
    if (!changed) return;
    this.snapshot = {
      viewer,
      owner,
      identity: identityChanged ? {} : previous.identity,
      observation,
      ready,
      healthyPause,
      admissions,
    };
    this.listeners.forEach((notify) => notify());
  };
  subscribe = (notify: () => void) => {
    this.listeners.add(notify);
    this.users++;
    this.mounted = true;
    if (!this.release) {
      const stopLifetime = viewerExposureLifetime(this.client).subscribe(this.observe);
      const stopCache = this.client.getQueryCache().subscribe(this.observe);
      this.release = () => {
        stopCache();
        stopLifetime();
      };
      this.observe();
    }
    return () => {
      this.listeners.delete(notify);
      this.users--;
      // Effect replay may reconnect, but cannot revive a retired identity or admission.
      queueMicrotask(() => {
        if (this.users) return;
        this.retire(this.snapshot.admissions);
        this.release?.();
        this.release = undefined;
        this.snapshot = { ...this.snapshot, identity: {}, ready: false };
      });
    };
  };
  current(snapshot: Snapshot, operations: readonly GatedOperation[], exactObservation = false) {
    this.observe();
    const now = this.snapshot;
    return (
      (!this.mounted || this.users > 0) &&
      now.ready &&
      now.identity === snapshot.identity &&
      (!exactObservation || now.observation === snapshot.observation) &&
      operations.every((operation) => {
        const value = snapshot.admissions.get(operation);
        return !!value && !value.retired && value.allowed && now.admissions.get(operation) === value;
      })
    );
  }
  headers(snapshot: Snapshot, operations: readonly GatedOperation[]) {
    if (!this.current(snapshot, operations, true)) return null;
    const token = this.client.getQueryState(sessionQuery.queryKey)?.data?.csrfToken;
    return token ? { 'x-csrf-token': token } : null;
  }
}

export function useReadingAuthority(operations: readonly GatedOperation[]) {
  useSession();
  const client = useQueryClient();
  const browser = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const store = useMemo(() => new ReadingAuthority(client, operations), [client, operations]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.server);
  useQuery({ ...viewerExposureQuery(snapshot.observation), enabled: browser && !!snapshot.observation });
  return { client, browser, store, snapshot };
}
