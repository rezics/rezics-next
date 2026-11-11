import { progressDecimalIssue } from './progress-decimal-input';
import { ProgressDecimalInput } from './progress-decimal-input-field';
import { progressAddressIssue, progressIndexAddress } from './progress-address';
import { ProgressAddressCorrection } from './progress-address-correction';
import { Exposure, useOperation } from '../kernel/exposure';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel, FieldLegend } from '@rezics/ui/shadcn/field';
import { ChoiceSelect } from '@rezics/ui/choice-select';
import { Input } from '@rezics/ui/shadcn/input';
import { RadioGroup, RadioGroupItem } from '@rezics/ui/shadcn/radio-group';
import type { CoverRatio } from '@rezics/ui/cover';
import { EllipsisIcon } from 'lucide-react';
import { progressIndexSubjects } from './progress-subjects';
import { ProgressPicker, pickerSubject, type ProgressPickerSubject } from './progress-picker';
import { ProgressRow } from '@rezics/ui/progress-row';
import { ContentItem } from '@rezics/ui/content-item';
import { MetaLine } from '@rezics/ui/meta-line';
import { ListRowControl } from '@rezics/ui/list-row';
import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Link, useLocation, useRouter } from '@tanstack/react-router';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { CancelledError, useQuery, useQueryClient } from '@tanstack/react-query';
import { personalRead } from '../session/reading-policy';
import {
  progressIndexAdmission,
  progressIndexSession,
  progressRowContext,
  useProgressAction,
  useProgressEpisode,
  type ProgressAuthority,
} from './progress-index-origin';
import { useLibraryWorkspaceAdmission } from './library-workspace-admission';
import { useHistoryAddress } from './history-current-origin';
import { useSession } from '../session';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { PageHeading } from '../shell/page-heading';
import { csrfHeaders } from '../threads/composer';
import { fullDateTime } from '../threads/byline';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import {
  applyProgressSnapshot,
  type ProgressFailure,
  type ProgressFinishInput,
  type ProgressIndex,
  type ProgressMode,
  type ProgressStartInput,
} from './progress-reads';
import { progressFailureMessage, progressView } from './progress-label';
import type { ProgressChoices } from './progress-profile';
import {
  admitProgressIndexWindow,
  progressIndexWindowAddress,
  progressIndexWindowQueryKey,
  progressIndexWindowRouteState,
  progressIndexWindowSnapshot,
  stageProgressIndexWindow,
  startProgressIndexWindows,
  type ProgressIndexCoordinate,
  type ProgressIndexWindowMove,
  type ProgressIndexWindowState,
} from './progress-index-windows';
import {
  progressReturnContextForPage,
  progressReturnLocationState,
  progressStartDraftChanged,
  progressStartDraftFromPage,
  progressStartDraftNavigationContext,
  progressStartDraftNavigationMessages,
  type ProgressIndexReturnSelection,
  type ProgressStartDraft,
} from './progress-start-draft-navigation';
import {
  finishProgressSession,
  startProgressSession,
  readProgressChoices,
  readCurrentViewerProgressIndex,
  type CurrentViewerProgressIndex,
} from './progress-server';
import { rowRatio, SubjectCover } from './subject-row';
import { displayLibraryTitle, LibraryTitle } from './title';

const modeChoices: { value: ProgressMode; label: () => string }[] = [
  { value: 'scalar_amount', label: () => m.library_progress_mode_amount() },
  { value: 'cursor_position', label: () => m.library_progress_mode_cursor() },
  { value: 'completed_units', label: () => m.library_progress_mode_units() },
];

function stateLabel(state: ProgressIndex['sessions'][number]['state']): string {
  if (state === 'completed') return m.library_progress_state_completed();
  if (state === 'abandoned') return m.library_progress_state_abandoned();
  return m.library_progress_state_active();
}

const buttonClass =
  'inline-flex min-h-[44px] min-w-0 max-w-full items-center justify-center rounded-lg border border-border px-4 py-2 text-center whitespace-normal wrap-anywhere text-primary underline-offset-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

function ProgressReturnRecovery({
  selection,
  search,
  currentWorkId,
  current,
}: {
  selection: ProgressIndexReturnSelection;
  search: { subjectId?: string; state?: string; mode?: string; profileId?: string };
  currentWorkId?: string | undefined;
  current?: (() => boolean) | undefined;
}) {
  return (
    <section className="space-y-3">
      <p role="status">{m.library_progress_discovery_stale()}</p>
      <nav className="flex flex-wrap gap-2" aria-label={m.library_progress_return_to_progress()}>
        <Link
          to="/library/progress"
          search={search}
          onClick={(event) => {
            if (current && !current()) event.preventDefault();
          }}
          className={buttonClass}
        >
          {m.library_collections_first_page()}
        </Link>
        {currentWorkId === selection.subjectId ? (
          <Link
            to="/library/progress"
            search={{ ...search, subjectId: currentWorkId }}
            onClick={(event) => {
              if (current && !current()) event.preventDefault();
            }}
            className={buttonClass}
          >
            {m.library_progress_restart()}
          </Link>
        ) : null}
      </nav>
    </section>
  );
}

const subscribe = () => () => {};
type ProgressRowReview = (id: string) => Promise<ProgressIndex['sessions'][number] | null>;
function onlyDisplayLayoutChanged(previous: Record<string, unknown>, current: Record<string, unknown>): boolean {
  if (previous.layout === current.layout) return false;
  const entries = (value: Record<string, unknown>) =>
    Object.entries(value)
      .filter(([key]) => key !== 'layout')
      .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries(previous)) === JSON.stringify(entries(current));
}

type ProgressHistoryLocation = { href?: string; search?: unknown; state?: unknown };

/** Installed router history identity: TSR key on state, then href. ParsedLocation has no `.key`. */
function progressHistoryLocationKey(location: ProgressHistoryLocation): string {
  if (location.state && typeof location.state === 'object') {
    const state = location.state as { key?: unknown; __TSR_key?: unknown };
    if (typeof state.key === 'string' && state.key.length > 0) return state.key;
    if (typeof state.__TSR_key === 'string' && state.__TSR_key.length > 0) return state.__TSR_key;
  }
  return typeof location.href === 'string' ? location.href : '';
}

function progressSearchRecord(search: unknown): Record<string, unknown> {
  return search && typeof search === 'object' && !Array.isArray(search) ? (search as Record<string, unknown>) : {};
}

function progressSearchCursor(search: unknown): string | null {
  const cursor = progressSearchRecord(search).cursor;
  return typeof cursor === 'string' ? cursor : null;
}
type ProgressWindowActions = {
  previous?: (keyboard: boolean) => void;
  first?: (keyboard: boolean) => void;
  more?: (keyboard: boolean) => void;
  retry?: () => void;
  refresh?: (keyboard: boolean) => void;
  focusToken?: string;
  consumeFocus?: (token: string) => void;
};

type ProgressCommand<Input, Sender> = {
  data: Input;
  headers: NonNullable<ReturnType<typeof csrfHeaders>>;
  send: Sender;
};
const progressOperations = [
  'progress_session.list',
  'progress_session.create',
  'progress_session.read',
  'progress_session.complete',
  'progress_session.abandon',
] as const;

/** Mounted by the real route: loader provenance is authority only for SSR/initial hydration. */
export function CurrentViewerProgressIndexPage({
  loader,
  requested,
  returnSelection,
  sourceReturnTo,
}: {
  loader: CurrentViewerProgressIndex;
  requested: { subjectId?: string; state?: string; mode?: string; profileId?: string; cursor?: string };
  returnSelection?: ProgressIndexReturnSelection | undefined;
  sourceReturnTo?: string | undefined;
}) {
  const renderedSession = useSession();
  const client = useQueryClient();
  const router = useRouter();
  const location = useLocation();
  const instance = useId();
  const { store, value: scoped } = useLibraryWorkspaceAdmission(progressOperations);
  const admitted = useOperation('progress_session.list');
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const locale = getLocale();
  const subjectId = requested.subjectId ?? '';
  const state = requested.state ?? null;
  const mode = requested.mode ?? null;
  const profileId = requested.profileId ?? null;
  const cursor = requested.cursor ?? null;
  const addressIssue = progressAddressIssue(requested);
  const viewer = hydrated ? scoped.subject : loader.viewer;
  const allowed = hydrated ? progressIndexAdmission(client, 'progress_session.list', admitted) : loader.page.signedIn;
  const address = useHistoryAddress('/library/progress', requested.cursor, locale);
  const scope = JSON.stringify([viewer, scoped.viewer, subjectId, state, mode, profileId, cursor, locale, address.key]);
  const origin = useProgressEpisode(
    scope,
    () => {
      if (getLocale() !== locale || !address.isCurrent()) return false;
      if (!hydrated) return !!viewer && allowed;
      const now = progressIndexSession(client, renderedSession);
      return !!viewer && store.read().viewer === scoped.viewer && now.state === 'signed-in' && now.subject === viewer;
    },
    () => store.read().subject !== viewer,
    () => !hydrated || progressIndexAdmission(client, 'progress_session.list', admitted),
  );
  const matches = (result: CurrentViewerProgressIndex | undefined) =>
    !!viewer &&
    result?.viewer === viewer &&
    result.locale === locale &&
    result.requested.subjectId === subjectId &&
    (result.requested.state ?? null) === state &&
    (result.requested.mode ?? null) === mode &&
    (result.requested.profileId ?? null) === profileId &&
    result.requested.cursor === cursor &&
    result.page.signedIn &&
    result.page.subjectId === subjectId &&
    (result.page.state ?? null) === state &&
    (result.page.mode ?? null) === mode &&
    (result.page.profileId ?? null) === profileId;
  // Each newly delivered loader may seed its matching scope once. A retained
  // loader cannot seed another lifetime after identity/admission retirement.
  const loaderSource = useRef({ loader, origin });
  if (loaderSource.current.loader !== loader) loaderSource.current = { loader, origin };
  const queryKey = [
    'library',
    'progress',
    'current-viewer',
    viewer,
    subjectId,
    state,
    mode,
    profileId,
    cursor,
    locale,
    origin.generation,
    instance,
  ] as const;
  const listVersion = store.dispatchVersion('progress_session.list');
  const readCursorOverride = useRef<ProgressIndexCoordinate | undefined>(undefined);
  const query = useQuery({
    ...personalRead,
    queryKey,
    queryFn: async () => {
      const currentRead = () => origin.isCurrent() && store.dispatchVersion('progress_session.list') === listVersion;
      if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
      try {
        const readCursor = readCursorOverride.current === undefined ? cursor : readCursorOverride.current;
        readCursorOverride.current = undefined;
        const readAddress = { ...requested };
        if (readCursor === null) delete readAddress.cursor;
        else readAddress.cursor = readCursor;
        const result = await readCurrentViewerProgressIndex({
          data: readAddress,
        });
        if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
        return readCursor === cursor ? result : { ...result, requested: { ...result.requested, cursor } };
      } catch (error) {
        if (!currentRead()) throw new CancelledError({ silent: true, revert: true });
        throw error;
      }
    },
    enabled: personalRead.enabled && hydrated && !!viewer && allowed && !addressIssue,
    // Do not duplicate the bounded loader read on hydration. Invalidations still refetch.
    initialData: loaderSource.current.origin === origin && matches(loader) ? loader : undefined,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  // A loader refresh and a query refresh are both fresh sources, without becoming
  // draft/reset identities. A rejected envelope also retires the previous query page.
  const latest = useRef({ origin, loader, query: query.data, result: query.data });
  if (latest.current.origin !== origin) {
    latest.current = { origin, loader, query: query.data, result: query.data };
  } else {
    if (latest.current.loader !== loader) {
      latest.current.loader = loader;
      latest.current.result = loader;
    }
    if (latest.current.query !== query.data) {
      latest.current.query = query.data;
      latest.current.result = query.data;
    }
  }
  const result = hydrated ? latest.current.result : loader;
  // A cache delivery can replace provenance before React commits its notification.
  // Retire the page operand without automatically replaying the bounded list read.
  const currentResult = () => {
    const state = client.getQueryState<CurrentViewerProgressIndex>(queryKey);
    return state?.data !== query.data ? state?.data : result;
  };
  const source = useProgressEpisode(origin, () => {
    const state = client.getQueryState<CurrentViewerProgressIndex>(queryKey);
    return !origin.retired && origin.validate() && state?.status !== 'error' && matches(currentResult());
  });
  const windowIdentity = JSON.stringify([
    viewer,
    scoped.viewer,
    listVersion,
    subjectId,
    state,
    mode,
    profileId,
    locale,
  ]);
  const routeWindow = progressIndexWindowRouteState(location.state);
  const routeWindowBook = routeWindow
    ? client.getQueryData<ProgressIndexWindowState>(progressIndexWindowQueryKey(routeWindow.visit))
    : undefined;
  const sourceReadIsCurrent = (read: string | undefined) =>
    !!read &&
    client
      .getQueryCache()
      .getAll()
      .some((entry) => JSON.stringify(entry.queryKey) === read && entry.state.status === 'success');
  const routeWindowMatches = (book: ProgressIndexWindowState | undefined) =>
    !!routeWindow &&
    routeWindow.to === cursor &&
    book?.identity === windowIdentity &&
    ((book.staged?.id === routeWindow.move &&
      book.staged.from === routeWindow.from &&
      book.staged.to === routeWindow.to &&
      sourceReadIsCurrent(book.staged.sourceRead)) ||
      (book.lastMovement === routeWindow.move && book.current === routeWindow.to));
  const visitRef = useRef<{
    identity: string;
    visit: string;
    addressKey: string;
    locationKey: string;
    search: Record<string, unknown>;
  } | null>(null);
  const oldVisit = visitRef.current?.visit;
  const sameRouteMove = routeWindowMatches(routeWindowBook);
  const previousVisit = visitRef.current;
  const historyLocationKey = progressHistoryLocationKey(location);
  const resetVisit =
    !previousVisit ||
    previousVisit.identity !== windowIdentity ||
    (previousVisit.addressKey !== address.key && !sameRouteMove) ||
    (previousVisit.locationKey !== historyLocationKey &&
      !sameRouteMove &&
      !onlyDisplayLayoutChanged(previousVisit.search, progressSearchRecord(location.search)));
  if (resetVisit) {
    visitRef.current = {
      identity: windowIdentity,
      visit: sameRouteMove && routeWindow ? routeWindow.visit : crypto.randomUUID(),
      addressKey: address.key,
      locationKey: historyLocationKey,
      search: progressSearchRecord(location.search),
    };
  } else if (visitRef.current) {
    visitRef.current = {
      ...visitRef.current,
      addressKey: address.key,
      locationKey: historyLocationKey,
      search: progressSearchRecord(location.search),
    };
  }
  const visit = visitRef.current!;
  const windowKey = progressIndexWindowQueryKey(visit.visit);
  const cachedWindows = client.getQueryData<ProgressIndexWindowState>(windowKey);
  const windows = cachedWindows?.identity === windowIdentity ? cachedWindows : undefined;
  const [windowRevision, renderWindows] = useState(0);
  const focusedMove = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (oldVisit && oldVisit !== visit.visit)
      client.removeQueries({ queryKey: progressIndexWindowQueryKey(oldVisit), exact: true });
  }, [client, oldVisit, visit.visit]);
  useLayoutEffect(() => {
    const unsubscribe = router.subscribe('onBeforeNavigate', ({ fromLocation, toLocation }) => {
      if (!fromLocation?.pathname.replace(/\/$/, '').endsWith('/library/progress')) return;
      const targetWindow = progressIndexWindowRouteState(toLocation.state);
      const stagedWindow = targetWindow
        ? client.getQueryData<ProgressIndexWindowState>(progressIndexWindowQueryKey(targetWindow.visit))
        : undefined;
      const validWindowMove =
        targetWindow?.visit === visit.visit &&
        stagedWindow?.identity === windowIdentity &&
        stagedWindow.staged?.id === targetWindow.move &&
        stagedWindow.staged.from === targetWindow.from &&
        stagedWindow.staged.to === targetWindow.to &&
        stagedWindow.staged.sourceLocation === progressHistoryLocationKey(fromLocation) &&
        sourceReadIsCurrent(stagedWindow.staged.sourceRead);
      const sameAddress =
        progressIndexWindowAddress(progressIndexAddress(fromLocation.search)) ===
          progressIndexWindowAddress(progressIndexAddress(toLocation.search)) &&
        progressSearchCursor(fromLocation.search) === progressSearchCursor(toLocation.search);
      const layoutOnly = onlyDisplayLayoutChanged(
        progressSearchRecord(fromLocation.search),
        progressSearchRecord(toLocation.search),
      );
      if (validWindowMove || (sameAddress && layoutOnly)) return;
      client.removeQueries({ queryKey: windowKey, exact: true });
      client.removeQueries({
        predicate: (entry) =>
          entry.queryKey[0] === 'library' &&
          entry.queryKey[1] === 'progress' &&
          entry.queryKey[2] === 'current-viewer' &&
          entry.queryKey.at(-1) === instance,
      });
    });
    return unsubscribe;
  }, [client, instance, router, visit.visit, windowIdentity, windowKey]);
  const admittedCursor = result?.page.admittedCursor === undefined ? cursor : result.page.admittedCursor;
  const pageCanAdmitWindow =
    hydrated &&
    allowed &&
    query.isSuccess &&
    matches(result) &&
    (result?.page.viewerState === undefined || result.page.viewerState === 'signed_in') &&
    !result?.page.addressIssue &&
    !addressIssue &&
    origin.isCurrent() &&
    source.isCurrent() &&
    store.dispatchVersion('progress_session.list') === listVersion &&
    progressIndexAdmission(client, 'progress_session.list', admitted);
  useLayoutEffect(() => {
    if (!pageCanAdmitWindow || admittedCursor === undefined) return;
    const existing = client.getQueryData<ProgressIndexWindowState>(windowKey);
    let next: ProgressIndexWindowState;
    if (existing?.identity !== windowIdentity) {
      const saved = returnSelection?.windowCoordinates;
      const savedSearch = returnSelection?.indexSearch;
      const exactReturnAddress =
        !!savedSearch &&
        JSON.stringify([
          savedSearch.subjectId ?? '',
          savedSearch.state ?? null,
          savedSearch.mode ?? null,
          savedSearch.profileId ?? null,
          savedSearch.cursor ?? null,
        ]) === JSON.stringify([subjectId, state, mode, profileId, cursor]);
      const useReturnedPath = !result?.page.cursorRestarted && exactReturnAddress && saved?.current === admittedCursor;
      next = {
        identity: windowIdentity,
        predecessors: useReturnedPath ? [...saved.predecessors] : [],
        current: admittedCursor,
      };
    } else {
      next = admitProgressIndexWindow(existing, {
        identity: windowIdentity,
        ...(routeWindow ? { move: routeWindow.move } : {}),
        requested: cursor,
        admitted: admittedCursor,
        ...(result?.page.cursorRestarted ? { restarted: true } : {}),
        eligible: true,
      });
    }
    if (next !== existing) {
      client.setQueryData(windowKey, next);
      renderWindows((value) => value + 1);
      for (const queryEntry of client
        .getQueryCache()
        .findAll({ queryKey: ['library', 'progress', 'current-viewer'] })) {
        if (queryEntry.queryKey.at(-1) === instance && JSON.stringify(queryEntry.queryKey) !== JSON.stringify(queryKey))
          client.removeQueries({ queryKey: queryEntry.queryKey, exact: true });
      }
    }
  }, [
    admittedCursor,
    client,
    cursor,
    instance,
    pageCanAdmitWindow,
    queryKey,
    renderWindows,
    result,
    returnSelection,
    routeWindow,
    state,
    subjectId,
    mode,
    profileId,
    windowIdentity,
    windowKey,
    windowRevision,
  ]);
  const currentReadAllowed = () =>
    hydrated &&
    !!viewer &&
    allowed &&
    origin.isCurrent() &&
    address.isCurrent() &&
    store.dispatchVersion('progress_session.list') === listVersion &&
    progressIndexAdmission(client, 'progress_session.list', admitted);
  const exactWindow = windows?.identity === windowIdentity && windows.current === admittedCursor ? windows : undefined;
  const moveWindow = (kind: ProgressIndexWindowMove, target: ProgressIndexCoordinate, keyboard: boolean) => {
    if (!pageCanAdmitWindow || admittedCursor === undefined || !currentReadAllowed()) return;
    const base = exactWindow ?? startProgressIndexWindows(windowIdentity, admittedCursor);
    if (base.current === undefined) return;
    const move = crypto.randomUUID();
    const staged = stageProgressIndexWindow(base, {
      id: move,
      kind,
      from: base.current,
      to: target,
      sourceLocation: historyLocationKey,
      sourceRead: JSON.stringify(queryKey),
      keyboard,
    });
    client.setQueryData(windowKey, staged);
    renderWindows((value) => value + 1);
    const search = {
      ...(subjectId ? { subjectId } : {}),
      ...(state ? { state } : {}),
      ...(mode ? { mode } : {}),
      ...(profileId ? { profileId } : {}),
      ...(target === null ? {} : { cursor: target }),
    };
    const navigation = router.navigate({
      to: '/library/progress',
      search: search as never,
      state: { progressIndexWindow: { visit: visit.visit, move, from: base.current, to: target } } as never,
    });
    void navigation.finally(() => {
      const currentLocation = router.state.location;
      if (progressHistoryLocationKey(currentLocation) === historyLocationKey) {
        const current = client.getQueryData<ProgressIndexWindowState>(windowKey);
        if (current?.staged?.id === move) {
          const { staged: _staged, ...accepted } = current;
          client.setQueryData(windowKey, accepted);
          renderWindows((value) => value + 1);
        }
      } else {
        const currentMove = progressIndexWindowRouteState(currentLocation.state);
        if (currentMove?.visit !== visit.visit || currentMove.move !== move)
          client.removeQueries({ queryKey: windowKey, exact: true });
      }
    });
  };
  const retryWindowTarget =
    windows?.staged?.to === cursor
      ? () => {
          if (!currentReadAllowed()) return;
          readCursorOverride.current = cursor;
          void query.refetch();
        }
      : undefined;
  const windowActions: ProgressWindowActions = {
    ...(pageCanAdmitWindow && exactWindow?.predecessors.length
      ? { previous: (keyboard: boolean) => moveWindow('previous', exactWindow.predecessors.at(-1)!, keyboard) }
      : {}),
    ...(pageCanAdmitWindow && admittedCursor !== null
      ? { first: (keyboard: boolean) => moveWindow('first', null, keyboard) }
      : {}),
    ...(pageCanAdmitWindow && result?.page.next
      ? { more: (keyboard: boolean) => moveWindow('more', result.page.next!, keyboard) }
      : {}),
    ...(retryWindowTarget ? { retry: retryWindowTarget } : {}),
    ...(pageCanAdmitWindow
      ? {
          refresh: () => {
            if (!currentReadAllowed()) return;
            readCursorOverride.current = exactWindow?.current ?? admittedCursor;
            void query.refetch();
          },
        }
      : {}),
    ...(windows?.lastMovement && focusedMove.current !== windows.lastMovement && !returnSelection
      ? { focusToken: windows.lastMovement }
      : {}),
    consumeFocus: (token) => {
      if (focusedMove.current !== token) focusedMove.current = token;
    },
  };
  const returnCoordinates = progressIndexWindowSnapshot(exactWindow);
  const rowSource = useRef<{ page?: ProgressIndex; contexts: Set<string> }>({ contexts: new Set() });
  const authority: ProgressAuthority = {
    key: source,
    isCurrent: () =>
      origin.isCurrent() && source.isCurrent() && store.dispatchVersion('progress_session.list') === listVersion,
    permits: (operation, rendered) =>
      !source.retired && source.validate() && hydrated && progressIndexAdmission(client, operation, rendered),
    episode: (operation) => store.dispatchVersion(operation),
    retained: (operation) =>
      scoped.granted[progressOperations.indexOf(operation as (typeof progressOperations)[number])] === true,
    rowCurrent: (context) => {
      const page = currentResult()?.page;
      if (rowSource.current.page !== page) {
        rowSource.current = { ...(page ? { page } : {}), contexts: new Set(page?.sessions.map(progressRowContext)) };
      }
      return rowSource.current.contexts.has(context);
    },
    headers: () => {
      if (!origin.isCurrent() || !source.isCurrent() || !hydrated) return null;
      const now = progressIndexSession(client, renderedSession);
      return now.csrfToken ? { 'x-csrf-token': now.csrfToken } : null;
    },
  };
  if (addressIssue || (matches(result) && result?.page.addressIssue))
    return <ProgressAddressCorrection address={requested} issue={addressIssue ?? result?.page.addressIssue} />;
  if (!viewer && result?.page.viewerState === 'signed_out')
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <p role="status">{m.library_progress_discovery_signed_out()}</p>
      </article>
    );
  if (origin.retired || source.retired || query.isError || !matches(result))
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        {returnSelection ? (
          <ProgressReturnRecovery
            selection={returnSelection}
            search={{
              ...(requested.subjectId ? { subjectId: requested.subjectId } : {}),
              ...(requested.state ? { state: requested.state } : {}),
              ...(requested.mode ? { mode: requested.mode } : {}),
              ...(requested.profileId ? { profileId: requested.profileId } : {}),
            }}
            currentWorkId={returnSelection.subjectId}
            current={authority?.isCurrent}
          />
        ) : null}
        {viewer && allowed ? (
          <>
            <p role="status">{m.library_progress_unavailable()}</p>
            <ProgressAddressCorrection address={requested} pending={query.isFetching} />
            <Button
              variant="outline"
              disabled={query.isFetching}
              onClick={() => {
                if (retryWindowTarget) retryWindowTarget();
                else if (currentReadAllowed()) {
                  readCursorOverride.current = admittedCursor;
                  void query.refetch();
                }
              }}
            >
              {retryWindowTarget ? m.library_progress_retry() : m.library_progress_index_refresh()}
            </Button>
          </>
        ) : null}
      </article>
    );
  return (
    <div hidden={hydrated && !allowed}>
      <ProgressIndexPage
        key={`${scope}:${source.generation}`}
        page={result!.page}
        cursor={admittedCursor}
        loading={query.isFetching}
        retry={
          retryWindowTarget ??
          (() => {
            if (!currentReadAllowed()) return;
            readCursorOverride.current = admittedCursor;
            void query.refetch();
          })
        }
        authority={authority}
        returnSelection={returnSelection}
        sourceReturnTo={sourceReturnTo}
        windowActions={windowActions}
        windowCoordinates={returnCoordinates}
        reviewRow={async (id) => {
          const readAddress = { ...requested };
          if (admittedCursor === null) delete readAddress.cursor;
          else if (admittedCursor !== undefined) readAddress.cursor = admittedCursor;
          const response = await readCurrentViewerProgressIndex({ data: readAddress });
          const fresh = { ...response, requested: { ...response.requested, cursor } };
          if (!matches(fresh)) throw new Error('Progress review origin mismatch');
          return fresh.page.sessions.find((row) => row.id === id) ?? null;
        }}
      />
    </div>
  );
}

export function ProgressIndexPage(props: {
  page: ProgressIndex;
  cursor?: string | null;
  loading?: boolean;
  retry?: () => void;
  authority?: ProgressAuthority;
  reviewRow?: ProgressRowReview;
  returnSelection?: ProgressIndexReturnSelection | undefined;
  sourceReturnTo?: string | undefined;
  windowActions?: ProgressWindowActions;
  windowCoordinates?: ReturnType<typeof progressIndexWindowSnapshot>;
}) {
  return (
    <AuthoringDepartureBoundary
      navigationContext={progressStartDraftNavigationContext}
      navigationMessages={progressStartDraftNavigationMessages()}
    >
      <ProgressIndexPageContent {...props} />
    </AuthoringDepartureBoundary>
  );
}

function ProgressIndexPageContent({
  page,
  cursor,
  loading = false,
  retry,
  authority,
  reviewRow,
  returnSelection,
  sourceReturnTo,
  windowActions,
  windowCoordinates,
}: {
  page: ProgressIndex;
  cursor?: string | null;
  loading?: boolean;
  retry?: () => void;
  authority?: ProgressAuthority;
  reviewRow?: ProgressRowReview;
  returnSelection?: ProgressIndexReturnSelection | undefined;
  sourceReturnTo?: string | undefined;
  windowActions?: ProgressWindowActions;
  windowCoordinates?: ReturnType<typeof progressIndexWindowSnapshot>;
}) {
  const router = useRouter();
  const identity = authority?.key ?? page;
  const creatable = useOperation('progress_session.create');
  const admission = useRef(creatable);
  admission.current = creatable;
  const episode = useProgressAction(authority, 'progress_session.create', creatable, identity);
  const current = () => episode.isCurrent() && admission.current;
  const intent = useRef<ProgressCommand<ProgressStartInput, typeof startProgressSession> | null>(null);
  const initialDraft = useRef(progressStartDraftFromPage(page));
  const completedStart = useRef(false);
  const pendingNavigation = useRef<HTMLAnchorElement | null>(null);
  const pendingReturnContext = useRef<ReturnType<typeof progressReturnContextForPage> | undefined>(undefined);
  const replayingNavigation = useRef<HTMLAnchorElement | null>(null);
  const departureRef = useRef<{ release: () => void } | null>(null);
  const focusedReturn = useRef<string | null>(null);
  const focusedMovement = useRef<string | null>(null);
  const sessionsHeading = useRef<HTMLHeadingElement | null>(null);
  const sessions = progressIndexSubjects(page.sessions);
  const [chosen, setChosen] = useState(() => {
    const subject = page.selectedSubject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [filterSubject, setFilterSubject] = useState<ProgressPickerSubject[]>(() => {
    const subject = page.selectedSubject;
    return subject ? [pickerSubject(subject)] : [];
  });
  const [filterKind, setFilterKind] = useState<'none' | 'state' | 'mode' | 'profile'>(() =>
    page.state ? 'state' : page.mode ? 'mode' : page.profileId ? 'profile' : 'none',
  );
  const [filterValue, setFilterValue] = useState(() => page.state ?? page.mode ?? page.profileId ?? '');
  const [seenIdentity, setSeenIdentity] = useState(episode);
  const [version, setVersion] = useState<ProgressPickerSubject[]>([]);
  const subject = chosen[0]?.id ?? '';
  const [choices, setChoices] = useState<ProgressChoices>(page.progressChoices);
  const [choicesUnavailable, setChoicesUnavailable] = useState(page.choicesUnavailable ?? false);
  const [selectedMode, setMode] = useState<ProgressMode | undefined>(page.progressChoices?.[0]?.mode);
  const [selectedUnit, setUnit] = useState('');
  const mode = choices?.find((choice) => choice.mode === selectedMode)?.mode ?? choices?.[0]?.mode;
  const units = choices?.find((choice) => choice.mode === mode)?.units ?? [];
  const pair = units.find((unit) => unit.id === selectedUnit) ?? units[0];
  const progressDefaultUnit = units[0]?.id ?? '';
  const unit = pair?.id ?? progressDefaultUnit;
  const acceptsTotal = mode === 'scalar_amount' && pair?.total !== 'forbidden';
  const choiceRequest = useRef(0);
  const [choosing, setChoosing] = useState(false);
  const [total, setTotal] = useState('');
  const [validateTotal, setValidateTotal] = useState(false);
  const [key, setKey] = useState(page.idempotencyKey);
  const [alert, setAlert] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const filterKindId = useId();
  const filterValueId = useId();

  const discoveryAddress = {
    ...(filterSubject[0] ? { subjectId: filterSubject[0].id } : {}),
    ...(filterKind === 'state' && filterValue ? { state: filterValue } : {}),
    ...(filterKind === 'mode' && filterValue ? { mode: filterValue } : {}),
    ...(filterKind === 'profile' && filterValue.trim() ? { profileId: filterValue.trim() } : {}),
  };
  const currentFilterAddress = {
    ...(page.subjectId ? { subjectId: page.subjectId } : {}),
    ...(page.state ? { state: page.state } : {}),
    ...(page.mode ? { mode: page.mode } : {}),
    ...(page.profileId ? { profileId: page.profileId } : {}),
  };
  const selectedReturnRow = returnSelection
    ? sessions.find(
        (session) =>
          session.id === returnSelection.sessionId &&
          session.subjectId === returnSelection.subjectId &&
          (returnSelection.startedAt === undefined || session.startedAt === returnSelection.startedAt),
      )
    : undefined;
  const missingReturnRow = !!returnSelection && !selectedReturnRow;

  useEffect(() => {
    if (
      !selectedReturnRow ||
      (authority !== undefined && !authority.isCurrent()) ||
      authority?.rowCurrent(progressRowContext(selectedReturnRow)) === false
    )
      return;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-progress-session-id]')).find(
      (candidate) => candidate.dataset.progressSessionId === selectedReturnRow.id,
    );
    if (!row || !returnSelection) return;
    const focusKey = `${returnSelection.sessionId}:${returnSelection.startedAt ?? ''}`;
    if (focusedReturn.current === focusKey) return;
    focusedReturn.current = focusKey;
    row.focus();
  }, [authority, returnSelection, selectedReturnRow]);

  useEffect(() => {
    const token = windowActions?.focusToken;
    if (
      !token ||
      focusedMovement.current === token ||
      selectedReturnRow ||
      (authority !== undefined && !authority.isCurrent())
    )
      return;
    sessionsHeading.current?.focus();
    focusedMovement.current = token;
    windowActions?.consumeFocus?.(token);
  }, [authority, selectedReturnRow, windowActions]);

  if (seenIdentity !== episode) {
    setSeenIdentity(episode);
    initialDraft.current = progressStartDraftFromPage(page);
    completedStart.current = false;
    if (!authority || (seenIdentity.identity !== episode.identity && seenIdentity.revoked)) intent.current = null;
    if (intent.current) {
      setAlert(m.library_progress_unavailable());
      setPending(false);
    } else {
      setChoices(page.progressChoices);
      setChoicesUnavailable(page.choicesUnavailable ?? false);
      choiceRequest.current++;
      setChoosing(false);
      setVersion([]);
      setTotal('');
      setValidateTotal(false);
      setUnit('');
      setMode(page.progressChoices?.[0]?.mode);
      setKey(authority ? crypto.randomUUID() : page.idempotencyKey);
      setAlert(null);
      setPending(false);
      const next = page.selectedSubject;
      setChosen(next ? [pickerSubject(next)] : []);
      setFilterSubject(next ? [pickerSubject(next)] : []);
      setFilterKind(page.state ? 'state' : page.mode ? 'mode' : page.profileId ? 'profile' : 'none');
      setFilterValue(page.state ?? page.mode ?? page.profileId ?? '');
    }
  }

  const draftLocked = pending || (!!authority && intent.current !== null);
  const [, renderDraft] = useState(0);
  const draftScope = JSON.stringify([subject, chosen[0]?.type, version[0]?.id, mode, unit, total, key]);
  const draftRef = useRef<{ scope: string; token: object }>({ scope: draftScope, token: {} });
  if (draftRef.current.scope !== draftScope) draftRef.current = { scope: draftScope, token: {} };
  const draft = draftRef.current;
  const draftCurrent = () => current() && draftRef.current === draft;
  const changeDraft = (change: () => void) => {
    if (!draftCurrent() || episode.pending || (!!authority && intent.current !== null)) return;
    draftRef.current = { scope: draftScope, token: {} };
    renderDraft((value) => value + 1);
    change();
  };

  const startDraft: ProgressStartDraft = {
    subjectId: subject,
    versionSubjectId: version[0]?.id ?? '',
    mode,
    unit,
    total,
  };
  const changed = progressStartDraftChanged(initialDraft.current, startDraft);
  const needsDeparture = () => current() && !completedStart.current && (changed || pending || intent.current !== null);
  const departure = useAuthoringDeparture(
    needsDeparture,
    () => pending || intent.current !== null,
    JSON.stringify([episode.generation, startDraft, pending, intent.current !== null]),
    () => {
      departureRef.current?.release();
      const link = pendingNavigation.current;
      pendingNavigation.current = null;
      const context = pendingReturnContext.current;
      pendingReturnContext.current = undefined;
      if (link?.isConnected) {
        if (context) {
          void router.navigate({
            href: link.getAttribute('href') ?? link.href,
            state: progressReturnLocationState(context) as never,
          });
        } else {
          replayingNavigation.current = link;
          link.click();
        }
      }
    },
    undefined,
    undefined,
    progressStartDraftNavigationMessages(),
    progressStartDraftNavigationContext,
  );
  departureRef.current = departure;

  function protectNavigation(event: ReactMouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('a') as HTMLAnchorElement | null;
    if (!link) return;
    if (authority && !authority.isCurrent()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (replayingNavigation.current === link) {
      replayingNavigation.current = null;
      return;
    }
    if (
      !event.defaultPrevented &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !link.target &&
      !link.hasAttribute('download') &&
      link.origin === window.location.origin
    ) {
      let rowId = '';
      try {
        rowId = decodeURIComponent(link.pathname.split('/').at(-1) ?? '');
      } catch {
        /* Invalid local paths remain ordinary navigation. */
      }
      const row = sessions.find((session) => session.id === rowId);
      const context =
        row && authority?.isCurrent() !== false && authority?.rowCurrent(progressRowContext(row)) !== false
          ? progressReturnContextForPage(
              page,
              cursor,
              getLocale(),
              row.id,
              row.subjectId,
              sourceReturnTo,
              row.startedAt,
              windowCoordinates,
            )
          : undefined;
      if (context && link.pathname.endsWith(`/library/progress/${encodeURIComponent(rowId)}`)) {
        event.preventDefault();
        event.stopPropagation();
        if (departure.hasOwner && needsDeparture()) {
          pendingNavigation.current = link;
          pendingReturnContext.current = context;
          departure.requestDiscard();
        } else {
          void router.navigate({
            href: link.getAttribute('href') ?? link.href,
            state: progressReturnLocationState(context) as never,
          });
        }
        return;
      }
    }
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      link.target ||
      link.hasAttribute('download') ||
      link.origin !== window.location.origin ||
      !departure.hasOwner ||
      !needsDeparture()
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    pendingNavigation.current = link;
    pendingReturnContext.current = undefined;
    departure.requestDiscard();
  }

  async function onStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const origin = episode;
    if (!current() || !draftCurrent() || origin.pending || (!intent.current && (!mode || !pair))) return;
    if (!intent.current) {
      setValidateTotal(true);
      if (acceptsTotal && progressDecimalIssue(total, pair, pair?.total === 'required')) return;
    }
    origin.pending = true;
    setAlert(null);
    setPending(true);
    const totalValue = acceptsTotal ? total.trim() : '';
    try {
      const headers = authority ? authority.headers() : csrfHeaders();
      if (!headers || !current()) return;
      const command = (intent.current ??= {
        data: {
          subjectId: subject.trim(),
          ...(version[0] ? { versionSubjectId: version[0].id } : {}),
          mode: mode!,
          unit,
          idempotencyKey: key,
          ...(totalValue ? { total: totalValue } : {}),
        },
        headers,
        send: startProgressSession,
      });
      const result = await command.send({ data: command.data, headers: command.headers });
      if (!draftCurrent()) return;
      if (!result.ok) {
        setAlert(progressFailureMessage(result.reason));
        if (authority && result.reason !== 'unavailable') {
          intent.current = null;
          draftRef.current = { scope: draftScope, token: {} };
          setKey(crypto.randomUUID());
        }
        return;
      }
      intent.current = null;
      completedStart.current = true;
      departure.release();
      draftRef.current = { scope: draftScope, token: {} };
      setKey(crypto.randomUUID());
      if (!current()) return;
      const context = progressReturnContextForPage(
        page,
        null,
        getLocale(),
        result.id,
        command.data.subjectId,
        sourceReturnTo,
      );
      const location = router.buildLocation({ to: '/library/progress/$id', params: { id: result.id } });
      await router.navigate({
        href: location.href,
        ...(context ? { state: progressReturnLocationState(context) as never } : {}),
      });
    } catch {
      if (draftCurrent()) setAlert(m.library_progress_unavailable());
    } finally {
      if (current()) {
        origin.pending = false;
        setPending(false);
      }
    }
  }

  if (page.addressIssue)
    return (
      <ProgressAddressCorrection
        address={{
          subjectId: page.subjectId,
          ...(page.state ? { state: page.state } : {}),
          ...(page.mode ? { mode: page.mode } : {}),
          ...(page.profileId ? { profileId: page.profileId } : {}),
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        }}
        issue={page.addressIssue}
      />
    );
  if (page.staleContinuation)
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <p role="status">{m.library_progress_discovery_stale()}</p>
        {returnSelection ? (
          <ProgressReturnRecovery
            selection={returnSelection}
            search={currentFilterAddress}
            currentWorkId={returnSelection.subjectId}
            current={authority?.isCurrent}
          />
        ) : (
          <Link
            to="/library/progress"
            search={currentFilterAddress}
            onClick={(event) => {
              if (authority && !authority.isCurrent()) event.preventDefault();
            }}
            className={buttonClass}
          >
            {m.library_collections_first_page()}
          </Link>
        )}
      </article>
    );
  const viewerState = page.viewerState ?? (page.signedIn ? 'signed_in' : 'signed_out');
  if (viewerState !== 'signed_in')
    return (
      <article className="max-w-4xl space-y-6">
        <PageHeading>{m.library_progress_heading()}</PageHeading>
        <p role="status">
          {viewerState === 'signed_out'
            ? m.library_progress_discovery_signed_out()
            : viewerState === 'forbidden'
              ? m.library_progress_discovery_forbidden()
              : viewerState === 'account_retired'
                ? m.library_progress_discovery_account_retired()
                : m.library_progress_unavailable()}
        </p>
        {viewerState === 'unavailable' ? (
          <Button variant="outline" disabled={loading} onClick={retry}>
            {m.library_progress_retry()}
          </Button>
        ) : null}
      </article>
    );
  const ratio = rowRatio(sessions.map((session) => session.subject));
  return (
    <article className="max-w-4xl space-y-10 text-foreground" onClickCapture={protectNavigation}>
      <PageHeading>{m.library_progress_heading()}</PageHeading>
      {missingReturnRow && returnSelection ? (
        <ProgressReturnRecovery
          selection={returnSelection}
          search={currentFilterAddress}
          currentWorkId={returnSelection.subjectId}
          current={authority?.isCurrent}
        />
      ) : null}
      {page.selectedSubject ? (
        <nav aria-label={m.library_progress_return_to_subject()}>
          <a
            className={buttonClass}
            href={
              sourceReturnTo ??
              subjectHref(
                {
                  id: page.selectedSubject.id,
                  label: displayLibraryTitle(page.selectedSubject.label, getLocale()).text,
                },
                getLocale(),
              ).href
            }
          >
            {m.library_progress_return_to_subject()}
          </a>
        </nav>
      ) : null}
      {loading ? (
        <p role="status" aria-live="polite">
          {m.library_progress_discovery_loading()}
        </p>
      ) : null}

      <>
        <section aria-labelledby="progress-discovery-heading" className="space-y-4">
          <h2 id="progress-discovery-heading" className="text-xl font-semibold">
            {m.library_progress_discovery_search()}
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-72">
              <ProgressPicker
                value={filterSubject}
                label={m.library_progress_discovery_exact_subject()}
                isCurrent={current}
                onValueChange={setFilterSubject}
              />
            </div>
            {filterSubject.length ? (
              <Button type="button" variant="outline" className="min-h-11" onClick={() => setFilterSubject([])}>
                {m.library_progress_address_clear()}
              </Button>
            ) : null}
            <div className="min-w-48 flex-1">
              <ChoiceSelect
                id={filterKindId}
                label={m.library_progress_discovery_filter_by()}
                fieldClassName="min-w-48 flex-1 gap-1"
                labelClassName="text-sm font-medium"
                triggerClassName="min-h-11"
                value={filterKind}
                onValueChange={(value) => {
                  if (value === 'none' || value === 'state' || value === 'mode' || value === 'profile') {
                    setFilterKind(value);
                    setFilterValue('');
                  }
                }}
                options={[
                  { value: 'none', label: m.library_progress_discovery_any_filter() },
                  { value: 'state', label: m.library_progress_discovery_state_filter() },
                  { value: 'mode', label: m.library_progress_discovery_mode_filter() },
                  { value: 'profile', label: m.library_progress_discovery_profile_filter() },
                ]}
              />
            </div>
            {filterKind === 'state' ? (
              <div className="min-w-48 flex-1">
                <ChoiceSelect
                  id={filterValueId}
                  label={m.library_progress_discovery_filter_value()}
                  fieldClassName="min-w-48 flex-1 gap-1"
                  labelClassName="text-sm font-medium"
                  triggerClassName="min-h-11"
                  value={filterValue || null}
                  onValueChange={(value) => setFilterValue(value ?? '')}
                  options={[
                    { value: null, label: m.library_progress_discovery_any_filter() },
                    { value: 'active', label: m.library_progress_state_active() },
                    { value: 'completed', label: m.library_progress_state_completed() },
                    { value: 'abandoned', label: m.library_progress_state_abandoned() },
                  ]}
                />
              </div>
            ) : null}
            {filterKind === 'mode' ? (
              <div className="min-w-48 flex-1">
                <ChoiceSelect
                  id={filterValueId}
                  label={m.library_progress_discovery_filter_value()}
                  fieldClassName="min-w-48 flex-1 gap-1"
                  labelClassName="text-sm font-medium"
                  triggerClassName="min-h-11"
                  value={filterValue || null}
                  onValueChange={(value) => setFilterValue(value ?? '')}
                  options={[
                    { value: null, label: m.library_progress_discovery_any_filter() },
                    ...modeChoices.map((choice) => ({ value: choice.value, label: choice.label() })),
                  ]}
                />
              </div>
            ) : null}
            {filterKind === 'profile' ? (
              <div className="min-w-48 flex-1">
                <label htmlFor={filterValueId} className="text-sm font-medium">
                  {m.library_progress_discovery_profile_filter()}
                </label>
                <Input
                  id={filterValueId}
                  className="min-h-11"
                  value={filterValue}
                  onChange={(event) => setFilterValue(event.currentTarget.value)}
                />
              </div>
            ) : null}
            <Link to="/library/progress" search={discoveryAddress} state={{} as never} className={buttonClass}>
              {m.library_progress_address_apply()}
            </Link>
            {page.subjectId || page.state || page.mode || page.profileId ? (
              <Link to="/library/progress" search={{}} state={{} as never} className={buttonClass}>
                {m.library_progress_discovery_reset()}
              </Link>
            ) : null}
          </div>
        </section>
        <h2
          id="progress-index-sessions-heading"
          ref={sessionsHeading}
          tabIndex={-1}
          className="text-xl font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.library_progress_index_list_heading()}
        </h2>
        {sessions.length ? (
          <ol className="space-y-3">
            {sessions.map((session) => (
              <SessionRow
                key={authority ? session.id : `${session.id}:${session.revision}`}
                session={session}
                ratio={ratio}
                sourcePage={page}
                authority={authority}
                reviewRow={reviewRow}
                returnFocus={session === selectedReturnRow}
              />
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">
            {cursor || page.next
              ? m.library_progress_page_empty()
              : page.emptyKind === 'filtered-empty' || page.subjectId || page.state || page.mode || page.profileId
                ? m.library_progress_discovery_empty_filtered()
                : m.library_progress_discovery_empty_owner()}
          </p>
        )}
        {cursor || page.next || windowActions?.previous || windowActions?.refresh ? (
          <Exposure operation="progress_session.list">
            <nav aria-label={m.library_progress_index_reader_pagination()} className="flex flex-wrap gap-2">
              {windowActions?.previous ? (
                <Button
                  variant="outline"
                  className={buttonClass}
                  disabled={loading}
                  onClick={(event) => windowActions.previous?.(event.detail === 0)}
                >
                  {m.library_progress_index_previous()}
                </Button>
              ) : null}
              {cursor ? (
                windowActions?.first ? (
                  <Button
                    variant="outline"
                    className={buttonClass}
                    disabled={loading}
                    onClick={(event) => windowActions.first?.(event.detail === 0)}
                  >
                    {m.library_collections_first_page()}
                  </Button>
                ) : (
                  <Link
                    to="/library/progress"
                    search={currentFilterAddress}
                    state={{} as never}
                    onClick={(event) => {
                      if (authority && !authority.isCurrent()) event.preventDefault();
                    }}
                    className={buttonClass}
                  >
                    {m.library_collections_first_page()}
                  </Link>
                )
              ) : null}
              {page.next ? (
                windowActions?.more ? (
                  <Button
                    variant="outline"
                    className={buttonClass}
                    disabled={loading}
                    onClick={(event) => windowActions.more?.(event.detail === 0)}
                  >
                    {m.library_progress_more()}
                  </Button>
                ) : (
                  <Link
                    to="/library/progress"
                    search={{ ...currentFilterAddress, cursor: page.next }}
                    state={{} as never}
                    onClick={(event) => {
                      if (authority && !authority.isCurrent()) event.preventDefault();
                    }}
                    className={buttonClass}
                  >
                    {m.library_progress_more()}
                  </Link>
                )
              ) : null}
              {windowActions?.refresh ? (
                <Button
                  variant="outline"
                  className={buttonClass}
                  disabled={loading}
                  onClick={(event) => windowActions.refresh?.(event.detail === 0)}
                >
                  {m.library_progress_index_refresh()}
                </Button>
              ) : null}
            </nav>
          </Exposure>
        ) : null}
        <Exposure operation="progress_session.create">
          <section aria-labelledby="start-progress-heading" className="space-y-5">
            <h2 id="start-progress-heading" className="text-xl font-semibold">
              {m.library_progress_start_heading()}
            </h2>
            <Field>
              <FieldLabel>{m.library_progress_subject()}</FieldLabel>
              <ProgressPicker
                key={episode.generation}
                isCurrent={draftCurrent}
                disabled={draftLocked}
                value={chosen}
                onValueChange={async (value) => {
                  if (!draftCurrent() || episode.pending || (!!authority && intent.current !== null)) return;
                  draftRef.current = { scope: draftScope, token: {} };
                  renderDraft((value) => value + 1);
                  const request = ++choiceRequest.current;
                  const latest = () => current() && request === choiceRequest.current;
                  setChosen(value);
                  setVersion([]);
                  setTotal('');
                  setChoices(undefined);
                  setChoicesUnavailable(false);
                  setChoosing(true);
                  setAlert(null);
                  try {
                    if (!latest()) return;
                    const next = value[0]
                      ? await readProgressChoices({ data: value[0].type ?? value[0].types[0] ?? '' })
                      : undefined;
                    if (!latest()) return;
                    setChoices(next);
                    setMode(next?.[0]?.mode);
                    setUnit('');
                    setTotal('');
                  } catch {
                    if (latest()) {
                      setChoicesUnavailable(true);
                      setAlert(m.library_progress_unavailable());
                    }
                  } finally {
                    if (latest()) setChoosing(false);
                  }
                }}
              />
            </Field>
            {alert && !choices?.length ? <p role="alert">{alert}</p> : null}
            {choicesUnavailable ? <p role="status">{m.library_progress_unavailable()}</p> : null}
            {chosen.length > 0 && !choosing && !choices?.length && !alert && !choicesUnavailable ? (
              <p role="status" className="text-muted-foreground">
                {m.library_progress_unsupported()}
              </p>
            ) : null}
            {choices?.length && !choosing ? (
              <form className="max-w-xl space-y-5" noValidate onSubmit={onStart}>
                <input type="hidden" name="idempotencyKey" value={key} />
                <input type="hidden" name="subjectId" value={subject} />
                <Field>
                  <FieldLabel>{m.library_progress_version()}</FieldLabel>
                  <ProgressPicker
                    key={episode.generation}
                    isCurrent={draftCurrent}
                    disabled={draftLocked}
                    label={m.library_progress_version()}
                    value={version}
                    onValueChange={(value) => {
                      changeDraft(() => setVersion(value));
                    }}
                  />
                  <p className="text-sm text-muted-foreground">{m.library_progress_version_scope()}</p>
                </Field>
                <dl className="space-y-2 rounded-lg border border-border p-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{m.library_progress_subject()}</dt>
                    <dd className="break-words">
                      <SelectedProgressSubject subject={chosen[0]} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.library_progress_version()}</dt>
                    <dd className="break-words">
                      {version[0] ? <SelectedProgressSubject subject={version[0]} /> : m.library_progress_no_version()}
                    </dd>
                  </div>
                </dl>
                <p className="text-sm text-muted-foreground">{m.library_progress_new_session_scope()}</p>
                <fieldset className="space-y-3">
                  <FieldLegend variant="label">{m.library_current_choices()}</FieldLegend>
                  <RadioGroup
                    name="progress-mode"
                    disabled={draftLocked}
                    value={mode}
                    onValueChange={(value) => {
                      changeDraft(() => setMode(value as ProgressMode));
                    }}
                    className="flex flex-wrap gap-x-6 gap-y-3"
                  >
                    {choices
                      ?.map((allowed) => modeChoices.find((choice) => choice.value === allowed.mode)!)
                      .map((choice) => (
                        <label key={choice.value} className="flex items-center gap-2 text-sm">
                          <RadioGroupItem value={choice.value} />
                          {choice.label()}
                        </label>
                      ))}
                  </RadioGroup>
                </fieldset>
                <div className="grid grid-cols-2 gap-4">
                  <Field>
                    <FieldLabel id="progress-unit-label" htmlFor="progress-unit">
                      {m.library_progress_unit()}
                    </FieldLabel>
                    <ChoiceSelect
                      id="progress-unit"
                      ariaLabelledBy="progress-unit-label"
                      name="unit"
                      disabled={draftLocked}
                      value={unit}
                      triggerClassName="min-h-11 w-full"
                      onValueChange={(value) => {
                        if (value !== null) changeDraft(() => setUnit(value));
                      }}
                      options={units.map((choice) => ({ value: choice.id, label: choice.label }))}
                    />
                  </Field>
                  {acceptsTotal ? (
                    <Field>
                      <FieldLabel htmlFor="progress-total">{m.library_progress_total()}</FieldLabel>
                      <ProgressDecimalInput
                        id="progress-total"
                        name="total"
                        disabled={draftLocked}
                        rules={pair}
                        issue={validateTotal ? progressDecimalIssue(total, pair, pair?.total === 'required') : null}
                        required={pair?.total === 'required'}
                        value={total}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          changeDraft(() => setTotal(value));
                        }}
                      />
                    </Field>
                  ) : null}
                </div>
                {alert ? (
                  <p role="alert" className="rounded-lg border border-border bg-card p-3">
                    {alert}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  disabled={pending || (!!authority && !authority.permits('progress_session.create', creatable))}
                >
                  {m.library_progress_start()}
                </Button>
              </form>
            ) : null}
          </section>
        </Exposure>
      </>
    </article>
  );
}

function SelectedProgressSubject({ subject }: { subject: ProgressPickerSubject | undefined }) {
  if (!subject) return null;
  return (
    <>
      <a href={subjectHref({ id: subject.id, label: subject.title }, getLocale()).href} className="underline">
        {subject.title}
      </a>
      {subject.typeLabel ? <span className="ml-2 text-muted-foreground">{subject.typeLabel}</span> : null}
    </>
  );
}

function sessionIdentityMetadata(session: ProgressIndex['sessions'][number]) {
  const locale = getLocale();
  return (
    <MetaLine
      items={[
        session.subject?.typeLabel,
        session.versionSubjectId ? (
          session.versionSubject ? (
            <LibraryTitle label={session.versionSubject.label} locale={locale} />
          ) : (
            m.library_subject_unavailable()
          )
        ) : null,
        <>
          {m.library_progress_started()}:{' '}
          <time dateTime={session.startedAt}>{fullDateTime(session.startedAt, locale)}</time>
        </>,
      ]}
    />
  );
}

function SessionRow({
  session: initial,
  ratio,
  sourcePage,
  authority,
  reviewRow,
  returnFocus = false,
}: {
  session: ProgressIndex['sessions'][number];
  ratio: CoverRatio;
  sourcePage: ProgressIndex;
  authority?: ProgressAuthority | undefined;
  reviewRow?: ProgressRowReview | undefined;
  returnFocus?: boolean | undefined;
}) {
  const readable = useOperation('progress_session.read');
  const completable = useOperation('progress_session.complete');
  const abandonable = useOperation('progress_session.abandon');
  const listable = useOperation('progress_session.list');
  const admission = useRef({ completable, abandonable });
  admission.current = { completable, abandonable };
  // Only a meaningful fresh row invalidates a completion within an observed viewer lifetime.
  const identity = authority ? JSON.stringify(initial) : sourcePage;
  const nativeContext = progressRowContext(initial);
  const complete = useProgressAction(
    authority,
    'progress_session.complete',
    completable,
    identity,
    () => authority?.rowCurrent(nativeContext) !== false,
  );
  const abandon = useProgressAction(
    authority,
    'progress_session.abandon',
    abandonable,
    identity,
    () => authority?.rowCurrent(nativeContext) !== false,
  );
  const review = useProgressAction(
    authority,
    'progress_session.list',
    listable,
    identity,
    () => authority?.rowCurrent(nativeContext) !== false,
  );
  const row = useProgressEpisode(identity, () => true);
  const current = (action?: 'complete' | 'abandon') =>
    row.isCurrent() &&
    authority?.isCurrent() !== false &&
    (!action ||
      (action === 'complete'
        ? complete.isCurrent() && admission.current.completable
        : abandon.isCurrent() && admission.current.abandonable));
  const intent = useRef<ProgressCommand<ProgressFinishInput, typeof finishProgressSession> | null>(null);
  const [session, setSession] = useState(initial);
  const [seenIdentity, setSeenIdentity] = useState({ identity, complete, abandon, review, row });
  const [confirming, setConfirming] = useState<'complete' | 'abandon' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ProgressFailure['reason'] | null>(null);
  const needsReview = useRef(false);
  const rejectedAction = useRef<'complete' | 'abandon' | null>(null);
  const reviewRequest = useRef<object | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  if (
    identity !== seenIdentity.identity ||
    complete !== seenIdentity.complete ||
    abandon !== seenIdentity.abandon ||
    review !== seenIdentity.review ||
    row !== seenIdentity.row
  ) {
    const sameRow = identity === seenIdentity.identity;
    const action = intent.current?.data.action ?? confirming ?? rejectedAction.current;
    const previousAction = action === 'complete' ? seenIdentity.complete : seenIdentity.abandon;
    const nextAction = action === 'complete' ? complete : abandon;
    setSeenIdentity({ identity, complete, abandon, review, row });
    if (review !== seenIdentity.review) {
      reviewRequest.current = null;
      setReviewing(false);
    }
    // A sibling admission change cannot release this action's pending lease.
    if (!sameRow || row !== seenIdentity.row || (action && previousAction !== nextAction)) {
      if (!authority || previousAction.revoked) {
        intent.current = null;
        if (authority) setKey(crypto.randomUUID());
      }
      if (!sameRow) {
        setSession(initial);
        needsReview.current = false;
        rejectedAction.current = null;
      }
      setConfirming(intent.current?.data.action ?? null);
      reviewRequest.current = null;
      setReviewing(false);
      setReviewed(false);
      setError(intent.current ? 'unavailable' : needsReview.current ? error : null);
      setPending(false);
    }
  }
  const renderedRow = useRef(session);
  renderedRow.current = session;
  const confirmation = useRef({ value: confirming, token: {} });
  if (confirmation.current.value !== confirming) confirmation.current = { value: confirming, token: {} };
  const confirmed = confirmation.current;
  const rowCurrent = (action?: 'complete' | 'abandon') =>
    current(action) && authority?.rowCurrent(nativeContext) !== false && renderedRow.current === session;
  const confirm = (action: 'complete' | 'abandon' | null) => {
    if (
      !rowCurrent(action ?? undefined) ||
      complete.pending ||
      abandon.pending ||
      needsReview.current ||
      reviewRequest.current ||
      (intent.current && intent.current.data.action !== action) ||
      (action && session.state !== 'active')
    )
      return;
    if (confirmation.current.value === action) return;
    confirmation.current = { value: action, token: {} };
    setConfirming(action);
  };
  const progress = progressView(session, getLocale());
  async function finish(action: 'complete' | 'abandon') {
    const origin = action === 'complete' ? complete : abandon;
    if (
      !rowCurrent(action) ||
      needsReview.current ||
      reviewRequest.current ||
      session.state !== 'active' ||
      confirmation.current !== confirmed ||
      confirmed.value !== action ||
      origin.pending ||
      (intent.current && intent.current.data.action !== action)
    )
      return;
    origin.pending = true;
    setPending(true);
    setError(null);
    try {
      const headers = authority ? authority.headers() : csrfHeaders();
      if (!headers || !rowCurrent(action)) return;
      const command = (intent.current ??= {
        data: {
          sessionId: session.id,
          revision: session.revision,
          idempotencyKey: key,
          action,
        },
        headers,
        send: finishProgressSession,
      });
      const result = await command.send({ data: command.data, headers: command.headers });
      if (!rowCurrent(action)) return;
      if (!result.ok) {
        setError(result.reason);
        if (result.reason !== 'unavailable') {
          intent.current = null;
          needsReview.current = true;
          rejectedAction.current = action;
          confirmation.current = { value: null, token: {} };
          setConfirming(null);
          setReviewed(false);
        }
        return;
      }
      if (result.session.id !== command.data.sessionId) {
        setError('unavailable');
        return;
      }
      intent.current = null;
      confirmation.current = { value: null, token: {} };
      setSession((current) =>
        result.session.id === current.id && result.session.revision >= current.revision
          ? applyProgressSnapshot(current, result.session)
          : current,
      );
      setKey(crypto.randomUUID());
      setConfirming(null);
    } catch {
      if (rowCurrent(action)) setError('unavailable');
    } finally {
      if (rowCurrent(action)) {
        origin.pending = false;
        setPending(false);
      }
    }
  }
  async function reviewCurrentRow() {
    if (!reviewRow || !needsReview.current || reviewRequest.current || !rowCurrent() || !review.isCurrent()) return;
    const actionOrigin = rejectedAction.current === 'abandon' ? abandon : complete;
    const request = {};
    reviewRequest.current = request;
    setReviewing(true);
    const isCurrent = () =>
      reviewRequest.current === request &&
      rowCurrent() &&
      review.isCurrent() &&
      !actionOrigin.retired &&
      actionOrigin.validate();
    try {
      const fresh = await reviewRow(session.id);
      if (!isCurrent()) return;
      if (!fresh || fresh.id !== session.id || fresh.revision < session.revision) {
        setError('unavailable');
        return;
      }
      // Reading only replaces the displayed row. A new menu action and confirmation
      // capture a new command; the rejected command can never be rebased or replayed.
      needsReview.current = false;
      confirmation.current = { value: null, token: {} };
      setConfirming(null);
      setSession(fresh);
      setKey(crypto.randomUUID());
      setError(null);
      setReviewed(true);
    } catch {
      if (isCurrent()) setError('unavailable');
    } finally {
      if (isCurrent()) {
        reviewRequest.current = null;
        setReviewing(false);
      }
    }
  }
  const entries: MenuEntry[] = [
    ...(readable && session.allowedActions?.edit.allowed === true
      ? [
          {
            type: 'link' as const,
            label: m.library_progress_discovery_edit(),
            href: `/${getLocale()}/library/progress/${encodeURIComponent(session.id)}`,
          },
        ]
      : []),
    ...(session.subject
      ? [
          {
            type: 'link' as const,
            label: m.library_progress_open_subject(),
            href: subjectHref(
              {
                id: session.subject.id,
                label: displayLibraryTitle(session.subject.label, getLocale()).text,
              },
              getLocale(),
            ).href,
          },
        ]
      : []),
    ...(session.state === 'active' && session.allowedActions?.complete.allowed !== false && completable
      ? [
          {
            type: 'item' as const,
            label: m.library_progress_complete(),
            onSelect: () => confirm('complete'),
          },
        ]
      : []),
    ...(session.state === 'active' && session.allowedActions?.abandon.allowed !== false && abandonable
      ? [
          {
            type: 'item' as const,
            label: m.library_progress_abandon(),
            onSelect: () => confirm('abandon'),
          },
        ]
      : []),
  ];
  const title = session.subject
    ? displayLibraryTitle(session.subject.label, getLocale())
    : { text: m.library_subject_unavailable(), lang: undefined };
  const meaning =
    session.meaning === 'known'
      ? m.library_progress_discovery_meaning_known()
      : session.meaning === 'unknown'
        ? m.library_progress_discovery_meaning_unknown()
        : session.meaning === 'unavailable'
          ? m.library_progress_discovery_meaning_unavailable()
          : null;
  const actionStates = session.allowedActions
    ? ([
        [m.library_progress_discovery_action_open(), session.allowedActions.open],
        [m.library_progress_discovery_edit(), session.allowedActions.edit],
        [m.library_progress_complete(), session.allowedActions.complete],
        [m.library_progress_abandon(), session.allowedActions.abandon],
      ] as const)
    : null;
  return (
    <ContentItem
      data-progress-session-id={session.id}
      tabIndex={returnFocus ? -1 : undefined}
      title={title.text}
      {...(title.lang ? { titleLang: title.lang } : {})}
      headingLevel={2}
      {...(readable && session.allowedActions?.open.allowed !== false
        ? { href: `/${getLocale()}/library/progress/${encodeURIComponent(session.id)}` }
        : {})}
      visual={
        <div className="w-[72px] shrink-0 sm:w-24">
          <SubjectCover subject={session.subject} ratio={ratio} size="fill" />
        </div>
      }
      metadata={sessionIdentityMetadata(session)}
      state={<span className="text-sm text-muted-foreground">{stateLabel(session.state)}</span>}
      preview={
        <div className="space-y-2">
          <ListRowControl>
            <ProgressRow
              value={progress?.percent == null ? null : progress.percent / 100}
              label={progress?.text ?? m.home_continue_in_progress()}
              menu={
                entries.length ? (
                  <ListRowControl>
                    <Menu
                      title={m.library_collection_actions()}
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="min-h-[44px] min-w-[44px]"
                          aria-label={m.library_collection_actions()}
                        >
                          <EllipsisIcon aria-hidden="true" />
                        </Button>
                      }
                      entries={entries}
                    />
                  </ListRowControl>
                ) : null
              }
            />
          </ListRowControl>
          {meaning ? <p className="text-sm text-muted-foreground">{meaning}</p> : null}
          {!session.unitLabel ? (
            <>
              <details className="text-sm text-muted-foreground">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  {m.library_progress_details()}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  <p>{m.library_progress_unit_unspecified()}</p>
                  <dl>
                    <dt>
                      {m.library_progress_mode()} / {m.library_progress_unit()}
                    </dt>
                    <dd>
                      <code className="break-all">
                        {session.mode} / {session.unit}
                      </code>
                    </dd>
                  </dl>
                </div>
              </details>
            </>
          ) : null}
          {actionStates ? (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                {m.library_progress_discovery_actions()}
              </summary>
              <ul className="mt-2 space-y-1">
                {actionStates.map(([label, action]) => (
                  <li key={label}>
                    {label}:{' '}
                    {action.allowed
                      ? m.library_progress_discovery_action_available()
                      : action.reason === 'session_not_active'
                        ? m.library_progress_discovery_action_not_active()
                        : m.library_progress_discovery_action_not_authorized()}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {confirming ? (
            <Exposure operation={confirming === 'abandon' ? 'progress_session.abandon' : 'progress_session.complete'}>
              <ListRowControl className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    pending ||
                    (!!authority &&
                      !authority.permits(
                        confirming === 'complete' ? 'progress_session.complete' : 'progress_session.abandon',
                        confirming === 'complete' ? completable : abandonable,
                      ))
                  }
                  onClick={() => void finish(confirming)}
                >
                  {confirming === 'complete'
                    ? m.library_progress_confirm_complete()
                    : m.library_progress_confirm_abandon()}
                </Button>
                <Button
                  variant="outline"
                  disabled={pending || !!intent.current}
                  onClick={() => {
                    if (confirmation.current === confirmed) confirm(null);
                  }}
                >
                  {m.library_progress_cancel()}
                </Button>
              </ListRowControl>
            </Exposure>
          ) : null}
          {error ? (
            <p role="alert" className="relative text-sm">
              {progressFailureMessage(error)}
            </p>
          ) : null}
          {needsReview.current ? (
            <ListRowControl>
              <Button
                variant="outline"
                disabled={reviewing || !reviewRow || !review.isCurrent()}
                onClick={() => void reviewCurrentRow()}
              >
                {m.library_progress_finish_recovery_review()}
              </Button>
            </ListRowControl>
          ) : null}
          {reviewed ? <p role="status">{m.library_progress_finish_recovery_reviewed()}</p> : null}
        </div>
      }
    />
  );
}
