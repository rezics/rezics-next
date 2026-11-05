import { CancelledError, QueryClient, QueryClientContext, type QueryKey } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { type GatedOperation } from '../kernel/exposure';
import { sessionQuery, useSession } from '../session/query';
import { useWorkspaceAdmission } from './workspace-admission';
import { browserObservation } from '../session/observation';
import { addressLease, readLease, operationLease } from './lease';
import { getLocale } from '../paraglide/runtime.js';

export type ReaderOrigin = { lifetime: object; isCurrent: () => boolean };
type Snapshot = { subject: string | null; viewer: number; allowed: boolean[]; episodes: number[]; dispatch: number[] };
const emptySubscribe = () => () => {};
const previewClient = new QueryClient();

type Boundary = {
  key: string;
  id: string;
  lifetime: object;
  active: boolean;
  mounted: boolean;
  seed: boolean;
  lease: ReturnType<typeof addressLease>;
  parent: object | undefined;
};

/** Local composition of the existing session, exposure and same-reader provenance. No private producer. */
export function useReaderCurrentOrigin(
  address: string,
  operations: readonly GatedOperation[],
  serverSubject: string | null = null,
  parent?: ReaderOrigin,
  previewAllowed?: readonly boolean[],
) {
  const suppliedClient = useContext(QueryClientContext);
  const client = suppliedClient ?? previewClient;
  const session = useSession();
  const hydrated = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
  const { store, value: scoped } = useWorkspaceAdmission(operations);
  const server = useMemo<Snapshot>(
    () => ({
      subject: serverSubject,
      viewer: 0,
      allowed: operations.map(() => true),
      episodes: operations.map(() => 0),
      dispatch: operations.map(() => 0),
    }),
    [serverSubject, operations],
  );
  const snapshot = hydrated ? scoped : server;
  const subject = hydrated
    ? !suppliedClient && previewAllowed && session.state === 'signed-in'
      ? (session.subject ?? null)
      : snapshot.subject
    : serverSubject;
  const key = JSON.stringify([subject, snapshot.viewer, address]);
  const ref = useRef<Boundary | null>(null);
  if (!ref.current || ref.current.key !== key || ref.current.parent !== parent?.lifetime) {
    const first = !ref.current;
    if (ref.current) {
      ref.current.active = false;
      ref.current.lease.retire();
    }
    ref.current = {
      key,
      id: crypto.randomUUID(),
      lifetime: {},
      active: true,
      mounted: false,
      seed: first,
      lease: addressLease(() => !parent || parent.isCurrent()),
      parent: parent?.lifetime,
    };
  }
  const boundary = ref.current;
  const seedObservation = useRef<typeof scoped.observation>(undefined);
  if (hydrated && scoped.observation && !seedObservation.current) seedObservation.current = scoped.observation;
  useLayoutEffect(() => {
    // Mounting never reactivates a render-retired boundary.
    if (boundary.active) boundary.mounted = true;
    return () => {
      boundary.mounted = false;
    };
  }, [boundary]);
  function current(index: number, mounted = true) {
    if (
      (parent && !parent.isCurrent()) ||
      !subject ||
      !boundary.active ||
      !boundary.lease.current() ||
      ref.current !== boundary ||
      (mounted && !boundary.mounted)
    )
      return false;
    if (!hydrated) return !mounted;
    const now = store.read();
    return (
      !!suppliedClient &&
      now.subject === subject &&
      now.viewer === snapshot.viewer &&
      now.dispatch[index] === snapshot.dispatch[index] &&
      now.allowed[index] === true
    );
  }
  const command = (index: number) =>
    operationLease(
      readLease(subject ?? '', boundary.lease, () => current(index)),
      operations[index]!,
      () => store.allowed(operations[index]!),
      () => client.getQueryData(sessionQuery.queryKey)?.csrfToken ?? null,
    );
  return {
    client,
    session,
    subject,
    hydrated,
    boundary,
    authoritative: !!suppliedClient,
    allowed: !suppliedClient && previewAllowed ? previewAllowed : snapshot.allowed,
    retained: !suppliedClient && previewAllowed ? previewAllowed : hydrated ? scoped.granted : snapshot.allowed,
    seed:
      boundary.seed &&
      snapshot.episodes.every((value) => value === 0) &&
      (!hydrated || seedObservation.current === scoped.observation),
    readKey: (index: number) => JSON.stringify([boundary.id, scoped.observation?.id, snapshot.dispatch[index]]),
    lifetime: (index: number) => JSON.stringify([boundary.id, snapshot.episodes[index]]),
    epoch: (index: number) => snapshot.dispatch[index],
    current,
    readLease: (index: number) => readLease(subject ?? '', boundary.lease, () => current(index)),
    operationLease: command,
    credential: (index: number) => command(index).credential(),
  };
}

export function assertReaderCurrent(current: () => boolean, signal?: AbortSignal) {
  if (signal?.aborted || !current()) throw new CancelledError({ silent: true });
}

/** Router matches can retain the previous search while the actual address is already loading. */
export function useReaderAddress(path: string | null, cursor: string | undefined, locale: string) {
  const router = useRouter({ warn: false });
  const store = useMemo(() => {
    let snapshot = { cursor: cursor || null, active: true, episode: 0, key: '' };
    const observe = (location: { pathname: string; search: Record<string, unknown> }) => {
      const nextCursor = typeof location.search.cursor === 'string' ? location.search.cursor || null : null;
      const active = path === null || location.pathname.replace(/\/$/, '') === path;
      const key = JSON.stringify([location.pathname, path === null ? location.search : nextCursor]);
      if (snapshot.key !== key) snapshot = { cursor: nextCursor, active, episode: snapshot.episode + 1, key };
      return snapshot;
    };
    if (router) observe(router.state.location);
    return {
      read: () => snapshot,
      subscribe: (notify: () => void) =>
        router
          ? router.subscribe('onBeforeNavigate', ({ toLocation }) => {
              observe(toLocation);
              notify();
            })
          : emptySubscribe(),
    };
  }, [router, path, cursor]);
  const snapshot = useSyncExternalStore(store.subscribe, store.read, store.read);
  const ref = useRef({ snapshot, locale, active: true, generation: 0 });
  if (!ref.current.active || ref.current.snapshot !== snapshot || ref.current.locale !== locale) {
    ref.current.active = false;
    ref.current = { snapshot, locale, active: true, generation: ref.current.generation + 1 };
  }
  const address = ref.current;
  return {
    cursor: router ? snapshot.cursor : cursor || null,
    key: JSON.stringify([
      path,
      router ? snapshot.cursor : cursor || null,
      locale,
      snapshot.episode,
      address.generation,
    ]),
    isCurrent: () => {
      if (store.read() !== snapshot || getLocale() !== locale) address.active = false;
      return address.active && snapshot.active;
    },
  };
}

/** Retained child callbacks stay tied to this actual successful reader and address. */
export function useReaderResponseOrigin(client: QueryClient, key: QueryKey, matches: (value: unknown) => boolean) {
  const signature = JSON.stringify(key);
  const predicate = useRef(matches);
  predicate.current = matches;
  const observation = useMemo(() => {
    let snapshot = { valid: false, generation: 0, data: undefined as unknown };
    let incarnation: unknown;
    let successes = 0;
    const read = () => {
      const state = client.getQueryState(key);
      const valid = state?.status === 'success' && predicate.current(state.data);
      const query = client.getQueryCache().find({ queryKey: key, exact: true });
      const count = state?.dataUpdateCount ?? 0;
      const replaced = query !== incarnation || count !== successes || state?.data !== snapshot.data;
      if (valid !== snapshot.valid || replaced)
        snapshot = {
          valid,
          generation: snapshot.generation + Number(snapshot.valid && (!valid || replaced)),
          data: state?.data,
        };
      incarnation = query;
      successes = count;
      return snapshot;
    };
    return {
      read,
      subscribe: (notify: () => void) => {
        const observation = browserObservation(client);
        let mounted = true;
        const publish = () => {
          if (mounted) notify();
        };
        const stop = observation.subscribeCache(() => {
          const before = snapshot;
          read();
          if (before !== snapshot) observation.publish(publish);
        });
        read();
        return () => {
          mounted = false;
          stop();
        };
      },
    };
  }, [client, signature]);
  const snapshot = useSyncExternalStore(observation.subscribe, observation.read, observation.read);
  return () => {
    const actual = observation.read();
    return actual.valid && actual.generation === snapshot.generation && actual.data === snapshot.data;
  };
}
