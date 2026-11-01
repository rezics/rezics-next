import { CancelledError, QueryClient, QueryClientContext } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useContext, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { operationIsAdmitted, type GatedOperation } from '../kernel/exposure';
import { exposureQuery, sessionQuery, useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';

export type HistoryOrigin = { lifetime: object; isCurrent: () => boolean };
type Snapshot = { subject: string | null; viewer: number; allowed: boolean[]; episodes: number[] };
const emptySubscribe = () => () => {};
const previewClient = new QueryClient();

/** Observe every cache notification, including away/back transitions before React commits. */
function observation(client: QueryClient | undefined, operations: readonly GatedOperation[]) {
  let snapshot: Snapshot | undefined;
  function read(): Snapshot {
    const session = client?.getQueryState<ReturnType<typeof useSession>>(sessionQuery.queryKey);
    const exposure = client?.getQueryState<readonly string[]>(exposureQuery.queryKey);
    const viewer = session?.status === 'success' ? session.data : undefined;
    const subject = viewer?.state === 'signed-in' ? viewer.subject || null : null;
    const allowed = operations.map(
      (operation) =>
        exposure?.status === 'success' &&
        operationIsAdmitted(operation, exposure.data) &&
        (!['follow.put', 'follow.delete'].includes(operation) || !!viewer?.csrfToken),
    );
    if (!snapshot) snapshot = { subject, viewer: 0, allowed, episodes: allowed.map(() => 0) };
    else if (snapshot.subject !== subject || allowed.some((value, i) => value !== snapshot!.allowed[i])) {
      snapshot = {
        subject,
        viewer: snapshot.viewer + Number(snapshot.subject !== subject),
        allowed,
        episodes: allowed.map((value, i) => snapshot!.episodes[i]! + Number(value !== snapshot!.allowed[i])),
      };
    }
    return snapshot;
  }
  return {
    read,
    subscribe: (notify: () => void) => {
      const unsubscribe = client?.getQueryCache().subscribe(() => {
        read();
        notify();
      });
      read();
      return () => unsubscribe?.();
    },
  };
}

type Boundary = {
  key: string;
  id: string;
  lifetime: object;
  active: boolean;
  mounted: boolean;
  seed: boolean;
  parent: object | undefined;
};

/** Local composition of the existing session, exposure and same-reader provenance. No private producer. */
export function useHistoryCurrentOrigin(
  address: string,
  operations: readonly GatedOperation[],
  serverSubject: string | null = null,
  parent?: HistoryOrigin,
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
  const store = useMemo(() => observation(suppliedClient, operations), [suppliedClient, operations]);
  const server = useMemo<Snapshot>(
    () => ({
      subject: serverSubject,
      viewer: 0,
      allowed: operations.map(() => true),
      episodes: operations.map(() => 0),
    }),
    [serverSubject, operations],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.read, () => server);
  const subject = hydrated
    ? !suppliedClient && previewAllowed && session.state === 'signed-in'
      ? (session.subject ?? null)
      : snapshot.subject
    : serverSubject;
  const key = JSON.stringify([subject, snapshot.viewer, address]);
  const ref = useRef<Boundary | null>(null);
  if (!ref.current || ref.current.key !== key || ref.current.parent !== parent?.lifetime) {
    const first = !ref.current;
    if (ref.current) ref.current.active = false;
    ref.current = {
      key,
      id: crypto.randomUUID(),
      lifetime: {},
      active: true,
      mounted: false,
      seed: first,
      parent: parent?.lifetime,
    };
  }
  const boundary = ref.current;
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
      now.episodes[index] === snapshot.episodes[index] &&
      now.allowed[index] === true
    );
  }
  return {
    client,
    session,
    subject,
    hydrated,
    boundary,
    authoritative: !!suppliedClient,
    allowed: !suppliedClient && previewAllowed ? previewAllowed : snapshot.allowed,
    seed: boundary.seed && snapshot.episodes.every((value) => value === 0),
    lifetime: (index: number) => JSON.stringify([boundary.id, snapshot.episodes[index]]),
    current,
    credential: (index: number) => (current(index) ? client.getQueryData(sessionQuery.queryKey)?.csrfToken : null),
  };
}

export function assertHistoryCurrent(current: () => boolean, signal?: AbortSignal) {
  if (signal?.aborted || !current()) throw new CancelledError({ silent: true });
}

/** Router matches can retain the previous search while the actual address is already loading. */
export function useHistoryAddress(path: string | null, cursor: string | undefined, locale: string) {
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
  const ref = useRef({ snapshot, locale, active: true });
  if (ref.current.snapshot !== snapshot || ref.current.locale !== locale) {
    ref.current.active = false;
    ref.current = { snapshot, locale, active: true };
  }
  const address = ref.current;
  return {
    cursor: router ? snapshot.cursor : cursor || null,
    key: JSON.stringify([path, router ? snapshot.cursor : cursor || null, locale, snapshot.episode]),
    isCurrent: () => {
      if (store.read() !== snapshot || getLocale() !== locale) address.active = false;
      return address.active && snapshot.active;
    },
  };
}
