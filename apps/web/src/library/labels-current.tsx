import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useSession } from '../session/query';
import { sessionQueryKey } from '../session/browser-state';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { personalRead } from '../kernel/query';
import { m } from '../paraglide/messages.js';
import { LabelsPageView } from './labels-page';
import type { LabelsPage } from './labels-read';
import { readLabelsCurrent, type LabelsAddress, type LabelsCurrentRead } from './labels-read-route';
import { useManagementCurrentOrigin, type ManagementGuard } from './management-current-origin';
import {
  LABELS_WINDOW_QUERY_KEY,
  cancelLabelsWindowFocus,
  isLabelsSessionQuery,
  labelsWindowOwner,
  labelsWindowHasPrevious,
  labelsWindowPrevious,
  labelsWindowVisit,
  stageLabelsWindow,
  acceptLabelsWindow,
  retireLabelsWindow,
  sameLabelsWindowReader,
  type LabelsWindowOwner,
  type LabelsWindowVisit,
  type LabelsWindowDirection,
} from './labels-window-navigation';
import { LABELS_CURSOR_MAX_LENGTH, labelsCursorHref } from './labels-address';

const subscribe = () => () => {};
const closed: ManagementGuard = { isCurrent: () => false, headers: () => null };
const labelOperations = [
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
] as const;
const signedOutPage: LabelsPage = {
  signedIn: false,
  operations: [],
  csrfToken: '',
  createKey: '',
  undoKey: '',
  labels: [],
  next: null,
};
function matches(value: LabelsCurrentRead | undefined, subject: string, address: LabelsAddress) {
  return (
    value?.sessionSubject === subject &&
    value.page?.signedIn &&
    value.requested?.cursor === address.cursor &&
    value.requested.query === address.query &&
    value.requested.locale === address.locale &&
    (value.page.query ?? null) === address.query
  );
}

export function LabelsCurrent({
  initial,
  search,
  locale,
}: {
  initial: LabelsCurrentRead;
  search: { cursor?: string; q?: string };
  locale: string;
}) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const session = useSession();
  const { store, value } = useLibraryWorkspaceAdmission(labelOperations);
  const client = useQueryClient();
  const location = useLocation();
  const subject = hydrated ? value.subject : initial.sessionSubject;
  const allowed = !hydrated || value.allowed[0] === true;
  const admitted = hydrated ? value.observation : initial.page.operations;
  const address: LabelsAddress = { cursor: search.cursor ?? null, query: search.q ?? null, locale };
  const origin = useManagementCurrentOrigin(
    subject,
    JSON.stringify(address),
    'library_label.list',
    hydrated,
    labelOperations,
  );
  const sessionState = client.getQueryState(sessionQueryKey);
  const owner = useMemo(
    () =>
      labelsWindowOwner(client, {
        locale,
        query: address.query,
        source: readLabelsCurrent,
        viewer: value.viewer,
        listEpoch: value.dispatch[0]!,
      }),
    [
      client,
      locale,
      address.query,
      value.viewer,
      value.dispatch[0],
      sessionState?.dataUpdateCount,
      sessionState?.dataUpdatedAt,
    ],
  );
  const routeState = location.state as { labelsWindowVisit?: unknown } | undefined;
  const visitId = typeof routeState?.labelsWindowVisit === 'string' ? routeState.labelsWindowVisit : undefined;
  const [windowRevision, setWindowRevision] = useState(0);
  const visit = labelsWindowVisit(client, visitId, owner);
  const latestVisitId = useRef(visitId);
  latestVisitId.current = visitId;
  useLayoutEffect(() => {
    const stop = client.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey;
      if (
        key.length === LABELS_WINDOW_QUERY_KEY.length &&
        key.every((part: unknown, index: number) => part === LABELS_WINDOW_QUERY_KEY[index])
      )
        setWindowRevision((revision) => revision + 1);
      if (!isLabelsSessionQuery(key) && !(key[0] === 'exposure' && key[1] === 'viewer')) return;
      const saved = client.getQueryData<LabelsWindowVisit>(LABELS_WINDOW_QUERY_KEY);
      if (!saved) return;
      const current = store.read();
      const nextOwner = labelsWindowOwner(client, {
        locale,
        query: address.query,
        source: readLabelsCurrent,
        viewer: current.viewer,
        listEpoch: current.dispatch[0]!,
      });
      if (!sameLabelsWindowReader(saved.owner, nextOwner)) retireLabelsWindow(client);
    });
    return stop;
  }, [client, store, locale, address.query]);
  useLayoutEffect(() => {
    if (!visitId || !visit?.staged?.restoreHeadingFocus) return;
    const onFocus = (event: FocusEvent) => {
      if (event.target === document.body || event.target === document.documentElement) return;
      if (cancelLabelsWindowFocus(client, visitId)) setWindowRevision((revision) => revision + 1);
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [client, visitId, visit?.staged?.target, visit?.staged?.restoreHeadingFocus]);
  useLayoutEffect(
    () => () => {
      cancelLabelsWindowFocus(client, latestVisitId.current);
    },
    [client],
  );
  void windowRevision;
  const [scope, setScope] = useState({ id: origin.id, seed: true, hydrated });
  if (scope.id !== origin.id) setScope({ id: origin.id, seed: scope.seed && !scope.hydrated && !!subject, hydrated });
  else if (scope.hydrated !== hydrated) setScope({ ...scope, hydrated });
  const shown = useRef<string | null>(null);
  if (allowed) shown.current = origin.id;
  if (!subject) {
    if (!hydrated)
      return (
        <LabelsPageView
          page={{ ...signedOutPage, ...(initial.page.state ? { state: initial.page.state } : {}) }}
          locale={locale}
        />
      );
    if (session.state === 'signed-out') return <LabelsPageView page={signedOutPage} locale={locale} />;
    return <p role="status">{m.library_labels_unavailable()}</p>;
  }
  if (!allowed && shown.current !== origin.id)
    return <p role="status">{admitted ? m.library_subject_label_closed() : m.library_labels_unavailable()}</p>;
  return (
    <>
      {!allowed ? <p role="status">{m.library_labels_unavailable()}</p> : null}
      <div hidden={!allowed}>
        <LabelsRead
          key={origin.id}
          subject={subject}
          address={address}
          initial={initial}
          seed={scope.seed}
          hydrated={hydrated}
          origin={origin}
          owner={owner}
          visitId={visitId}
        />
      </div>
    </>
  );
}

function LabelsRead({
  subject,
  address,
  initial,
  seed,
  hydrated,
  origin,
  owner,
  visitId,
}: {
  subject: string;
  address: LabelsAddress;
  initial: LabelsCurrentRead;
  seed: boolean;
  hydrated: boolean;
  origin: ReturnType<typeof useManagementCurrentOrigin>;
  owner: LabelsWindowOwner;
  visitId: string | undefined;
}) {
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const location = useLocation();
  const [lifetime] = useState(() => crypto.randomUUID());
  const queryKey = ['labels-current', subject, address, lifetime] as const;
  const query = useQuery({
    ...personalRead,
    queryKey,
    enabled: hydrated && personalRead.enabled,
    queryFn: async () => {
      const current = origin.capture();
      if (!current()) throw new CancelledError({ silent: true, revert: true });
      try {
        const value = await readLabelsCurrent({
          data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
        });
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        if (!matches(value, subject, address)) throw new Error('Unaccepted Labels read');
        return value;
      } catch (error) {
        if (!current()) throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
    },
    initialData: seed && matches(initial, subject, address) ? initial : undefined,
    staleTime: Infinity,
    refetchOnMount: false,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  const [loader, setLoader] = useState(initial);
  if (loader !== initial) {
    setLoader(initial);
    if (!matches(initial, subject, address)) origin.rejectRead();
  }
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (!origin.isCurrent()) return;
    if (matches(initial, subject, address)) client.setQueryData(queryKey, initial);
    else origin.rejectRead();
  }, [initial, subject, address, client, origin, queryKey]);
  const accepted = !query.isError && matches(query.data, subject, address) ? query.data : undefined;
  const guard = accepted
    ? origin.accept(
        queryKey,
        (value) => {
          const current = value as LabelsCurrentRead;
          const recoverableCursor =
            current.page.state === 'unavailable' &&
            (current.page.feedback?.reason === 'invalid_cursor' || current.page.feedback?.reason === 'stale_cursor');
          return (
            matches(current, subject, address) &&
            current.page.operations.includes('library_label.list') &&
            (!current.page.state || current.page.state === 'loaded' || recoverableCursor)
          );
        },
        labelOperations,
      )
    : null;
  const page = accepted?.page;
  const currentCursor = address.cursor;
  const visit = labelsWindowVisit(client, visitId, owner);
  const canPrevious = labelsWindowHasPrevious(visit, currentCursor);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [moving, setMoving] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  void navigationRevision;

  useEffect(() => {
    const stage = labelsWindowVisit(client, visitId, owner)?.staged;
    if (!stage || stage.target !== currentCursor || query.isFetching) return;
    const staleCursor = page?.feedback?.reason === 'stale_cursor';
    if (
      query.isError ||
      !page ||
      (!!page.state && page.state !== 'loaded') ||
      staleCursor ||
      (hydrated && !guard?.isCurrent('library_label.list'))
    ) {
      if (cancelLabelsWindowFocus(client, visitId)) setNavigationRevision((revision) => revision + 1);
      setMoving(false);
    }
  }, [client, visitId, owner, currentCursor, query.isFetching, query.isError, page, hydrated, guard]);

  useEffect(() => {
    if (query.isFetching) setMoving(true);
    else if (moving && (!page || (!!page.state && page.state !== 'loaded') || query.isError)) setMoving(false);
  }, [query.isFetching, query.isError, page, moving]);

  useLayoutEffect(() => {
    const currentVisit = labelsWindowVisit(client, visitId, owner);
    const stage = currentVisit?.staged;
    if (!stage || stage.target !== currentCursor || query.isFetching || query.isError || !page) return;
    const loaded =
      !!guard?.isCurrent('library_label.list') &&
      page.signedIn &&
      page.operations.includes('library_label.list') &&
      (!page.state || page.state === 'loaded') &&
      page.feedback?.reason !== 'stale_cursor';
    const acceptedMovement = acceptLabelsWindow(client, {
      visitId,
      owner,
      current: currentCursor,
      loaded,
    });
    if (!acceptedMovement.committed) return;
    setMoving(false);
    if (
      acceptedMovement.restoreHeadingFocus &&
      document.activeElement === document.body &&
      guard?.isCurrent('library_label.list')
    )
      heading.current?.focus();
    setNavigationRevision((revision) => revision + 1);
  }, [client, visitId, owner, currentCursor, query.isFetching, query.isError, page, guard]);

  function moveWindow(direction: LabelsWindowDirection, restoreHeadingFocus: boolean) {
    if (moving || query.isFetching || !origin.isCurrent() || !page) return;
    const cursorRestart =
      direction === 'first' &&
      currentCursor !== null &&
      (page.feedback?.reason === 'stale_cursor' || page.feedback?.reason === 'invalid_cursor');
    if (direction === 'first') {
      if (
        currentCursor === null ||
        (!page.state || page.state === 'loaded' ? !guard?.isCurrent('library_label.list') : !cursorRestart)
      )
        return;
    } else if (!page.state || page.state === 'loaded') {
      if (!guard?.isCurrent('library_label.list')) return;
    } else return;

    let target: string | null;
    if (direction === 'first') target = null;
    else if (direction === 'next') {
      if (page.next === null || page.next.length > LABELS_CURSOR_MAX_LENGTH) return;
      target = page.next;
    } else {
      const previous = labelsWindowPrevious(labelsWindowVisit(client, visitId, owner), currentCursor);
      if (previous === undefined) return;
      target = previous;
    }

    // Re-admit the original private reader after the user's Leave choice, immediately before staging/navigation.
    if (!origin.isCurrent()) return;
    if ((!page.state || page.state === 'loaded') && !guard?.isCurrent('library_label.list')) return;
    if (cursorRestart && (!page.signedIn || !page.operations.includes('library_label.list'))) return;

    const nextVisitId = visitId ?? crypto.randomUUID();
    if (
      !stageLabelsWindow(client, {
        visitId: nextVisitId,
        owner,
        current: currentCursor,
        target,
        direction,
        restoreHeadingFocus,
      })
    )
      return;
    setMoving(true);
    setNavigationRevision((revision) => revision + 1);
    const state = { ...location.state, labelsWindowVisit: nextVisitId };
    const href = labelsCursorHref(location.pathname, window.location.search, window.location.hash, target);
    if (!visitId) router.history.replace(location.href, state);
    router.history.push(href, state);
  }

  const retryCurrent = () => {
    if (origin.isCurrent() && !query.isFetching) void query.refetch();
  };
  if (!page || (hydrated && !guard && (!page.state || page.state === 'loaded')))
    return (
      <div>
        <p role="status">{m.library_labels_unavailable()}</p>
        {hydrated && !query.isFetching ? (
          <button
            type="button"
            className="inline-flex min-h-11 min-w-11 items-center rounded-sm border px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            onClick={retryCurrent}
          >
            {m.subject_view_retry()}
          </button>
        ) : null}
      </div>
    );
  return (
    <LabelsPageView
      key={origin.id}
      page={page}
      isCurrent={guard?.isCurrent ?? (hydrated ? origin.isCurrent : closed.isCurrent)}
      originating={guard ?? closed}
      canPrevious={canPrevious}
      windowBusy={moving || query.isFetching}
      onWindowMove={moveWindow}
      retryCurrent={retryCurrent}
      headingRef={heading}
      refresh={async () => {
        if (!guard?.isCurrent('library_label.list')) return null;
        const value = await readLabelsCurrent({
          data: { cursor: address.cursor ?? undefined, query: address.query ?? undefined },
        });
        if (!guard.isCurrent('library_label.list')) return null;
        if (!matches(value, subject, address)) {
          origin.rejectRead();
          return null;
        }
        return value.page;
      }}
      {...(address.cursor === null ? {} : { cursor: address.cursor })}
      locale={address.locale}
    />
  );
}
