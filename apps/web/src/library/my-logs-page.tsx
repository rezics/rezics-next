import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Exposure, useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import {
  assertHistoryCurrent,
  useHistoryAddress,
  useHistoryCurrentOrigin,
  useHistoryReadOrigin,
  type HistoryOrigin,
} from './history-current-origin';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { fullDateTime } from '../threads/byline';
import { myLogsSearch, type MyLogsPage } from './my-logs';
import {
  MyLogsWindowNavigation,
  myLogsWindowHrefs,
  myLogsWindowNavigation,
  type MyLogsWindowAction,
  type MyLogsWindowSnapshot,
} from './my-logs-window-navigation';
import { readMyPublishedLogHistoryForViewer, type MyLogsViewerHistory } from './logs-server';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';
import {
  clearLogsReturn,
  logsDestinationClick,
  logsReturnFrontier,
  logsReturnMatchesWindow,
  logsReturnTrigger,
  readLogsReturn,
} from './logs-return';

const logOperations = ['published_log.list'] as const;
const emptyWindowsSnapshot: MyLogsWindowSnapshot = {
  coordinates: [],
  current: null,
  movement: null,
  focusReady: false,
  revision: 0,
};

function matchesAddress(read: MyLogsViewerHistory, cursor: string | null, locale: string) {
  return read.cursor === cursor && read.locale === locale;
}

function matchesOwner(read: MyLogsViewerHistory, subject: string, cursor: string | null, locale: string) {
  return read.sessionSubject === subject && read.page.state === 'loaded' && matchesAddress(read, cursor, locale);
}

/** Retained loader data is usable only with its actual owner and requested address. */
export function MyLogsCurrentViewer({
  initial,
  cursor,
  invalidPosition = false,
}: {
  initial: MyLogsViewerHistory;
  cursor?: string | undefined;
  invalidPosition?: boolean;
}) {
  const router = useRouter({ warn: false });
  useOperation('published_log.list');
  const locale = getLocale();
  const address = useHistoryAddress('/library/logs', myLogsSearch({ cursor }).cursor, locale);
  const origin = useHistoryCurrentOrigin(
    JSON.stringify(['/library/logs', locale]),
    logOperations,
    initial.page.state === 'loaded' ? initial.sessionSubject : null,
  );
  const windows = useMemo(
    () => (typeof window === 'undefined' ? new MyLogsWindowNavigation() : myLogsWindowNavigation(origin.client)),
    [origin.client],
  );
  const windowSnapshot = useSyncExternalStore(windows.subscribe, windows.getSnapshot, windows.getSnapshot);
  const windowAuthorityKey =
    !invalidPosition && origin.subject && origin.allowed[0] ? JSON.stringify([origin.admissionKey(0), locale]) : null;
  useEffect(() => {
    const detach = windows.attach(() => router?.state.location.pathname.replace(/\/$/, '') === '/library/logs');
    const stopNavigation = router?.subscribe('onBeforeNavigate', ({ toLocation }) => {
      if (toLocation.pathname.replace(/\/$/, '') !== '/library/logs') windows.dispose();
    });
    return () => {
      stopNavigation?.();
      detach();
    };
  }, [windows, router]);
  useLayoutEffect(() => {
    windows.observe(windowAuthorityKey, address.cursor);
  }, [windows, windowAuthorityKey, address.cursor]);
  const current = () => address.isCurrent() && origin.current(0);
  const queryKey = [
    'my-logs-current-viewer',
    origin.subject,
    'published_log.list',
    true,
    address.cursor,
    locale,
    origin.readKey(0),
  ] as const;
  const query = useQuery(
    {
      ...personalRead,
      queryKey,
      enabled:
        personalRead.enabled &&
        !invalidPosition &&
        origin.hydrated &&
        !!origin.subject &&
        origin.allowed[0] === true &&
        address.isCurrent(),
      queryFn: async ({ signal }) => {
        assertHistoryCurrent(current, signal);
        try {
          const read = await readMyPublishedLogHistoryForViewer({ data: { cursor: address.cursor ?? undefined } });
          assertHistoryCurrent(current, signal);
          return read;
        } catch (error) {
          assertHistoryCurrent(current, signal);
          throw error;
        }
      },
      ...(origin.seed && origin.subject && matchesOwner(initial, origin.subject, address.cursor, locale)
        ? { initialData: initial }
        : {}),
      gcTime: 0,
      staleTime: Infinity,
      refetchOnMount: false,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    origin.client,
  );
  const readCurrent = useHistoryReadOrigin(
    origin.client,
    queryKey,
    (value) =>
      !!value && !!origin.subject && matchesOwner(value as MyLogsViewerHistory, origin.subject, address.cursor, locale),
  );
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    if (current()) void query.refetch();
  }, [initial, query.refetch, origin.lifetime(0)]);
  const read = query.isError ? undefined : query.data;
  const owner = read && origin.subject && matchesOwner(read, origin.subject, address.cursor, locale);
  const failure =
    read &&
    read.sessionSubject === null &&
    read.page.state !== 'loaded' &&
    matchesAddress(read, address.cursor, locale);
  const page: MyLogsPage = invalidPosition
    ? { state: 'invalid-position' }
    : !origin.subject || !origin.allowed[0]
      ? !origin.hydrated && matchesAddress(initial, address.cursor, locale) && initial.page.state !== 'loaded'
        ? initial.page
        : {
            state:
              origin.session.state === 'signed-out'
                ? 'signed-out'
                : origin.session.state === 'unknown'
                  ? 'preparing'
                  : origin.subject
                    ? 'denied'
                    : 'unavailable',
          }
      : origin.current(0, false) && address.isCurrent() && (owner || failure)
        ? read!.page
        : { state: query.isError || read ? 'unavailable' : 'preparing' };
  useLayoutEffect(() => {
    if (!windowAuthorityKey) return;
    if (page.state === 'loaded' && read && owner && current() && readCurrent()) {
      windows.accept(windowAuthorityKey, address.cursor, page.restarted);
    } else if (
      (page.state === 'denied' || page.state === 'unavailable') &&
      windowSnapshot.movement?.target === address.cursor
    ) {
      windows.failMovement(windowAuthorityKey, address.cursor);
    }
  }, [
    windows,
    windowAuthorityKey,
    address.cursor,
    page.state,
    page.state === 'loaded' ? page.restarted : false,
    read,
    owner,
    query.isError,
    readCurrent,
  ]);
  return (
    <MyLogsPageView
      origin={{ lifetime: origin.boundary.lifetime, isCurrent: () => current() && readCurrent() }}
      page={page}
      cursor={page.state === 'loaded' && !page.restarted ? (address.cursor ?? undefined) : undefined}
      windows={windows}
      windowSnapshot={windowSnapshot}
      windowAuthorityKey={windowAuthorityKey}
      returnSubject={origin.subject}
      returnCursor={address.cursor}
      onRetry={
        origin.subject && origin.allowed[0]
          ? () => {
              if (!current()) return;
              if (windowAuthorityKey) windows.retryMovement(windowAuthorityKey, address.cursor);
              void query.refetch();
            }
          : undefined
      }
    />
  );
}

function SnapshotDate({ label, value }: { label: string; value: string }) {
  return (
    <span className="[overflow-wrap:anywhere]">
      {label}: <time dateTime={value}>{fullDateTime(value, getLocale())}</time>
    </span>
  );
}

export function MyLogsPageView({
  page,
  cursor,
  onRetry,
  origin,
  windows,
  windowSnapshot = emptyWindowsSnapshot,
  windowAuthorityKey,
  returnSubject,
  returnCursor,
}: {
  page: MyLogsPage;
  cursor?: string | undefined;
  onRetry?: (() => void) | undefined;
  origin?: HistoryOrigin;
  windows?: MyLogsWindowNavigation;
  windowSnapshot?: MyLogsWindowSnapshot;
  windowAuthorityKey?: string | null;
  returnSubject?: string | null;
  returnCursor?: string | null;
}) {
  const router = useRouter({ warn: false });
  const listHeading = useRef<HTMLHeadingElement>(null);
  const listRoot = useRef<HTMLElement>(null);
  const locale = getLocale();
  const routeHref = router?.state.location.href ?? '/library/logs';
  const effectiveCursor = page.state === 'loaded' && page.restarted ? null : (cursor ?? null);
  const acceptedCurrent =
    page.state === 'loaded' &&
    windowAuthorityKey !== null &&
    windowAuthorityKey !== undefined &&
    windowSnapshot.current === effectiveCursor &&
    windowSnapshot.coordinates.at(-1) === effectiveCursor;
  const admittedNext =
    page.state === 'loaded' && page.next !== null && myLogsSearch({ cursor: page.next }).cursor === page.next
      ? page.next
      : null;
  const canPrevious = acceptedCurrent && !windowSnapshot.movement && windowSnapshot.coordinates.length > 1;
  const previousCursor = canPrevious ? (windowSnapshot.coordinates.at(-2) ?? null) : null;
  const canNewest = acceptedCurrent && !windowSnapshot.movement && effectiveCursor !== null;
  const canNext = acceptedCurrent && !windowSnapshot.movement && admittedNext !== null;
  const ratio = rowRatio(page.state === 'loaded' ? page.logs.map((log) => log.subject) : []);
  useLayoutEffect(() => {
    if (page.state !== 'loaded' || !returnSubject || !origin?.isCurrent()) return;
    const frontier = readLogsReturn(locale, returnSubject);
    if (!frontier || !logsReturnMatchesWindow(frontier, returnCursor ?? null)) return;
    const trigger = logsReturnTrigger(listRoot.current, frontier.logId);
    if (!trigger) return;
    trigger.focus();
    clearLogsReturn();
  }, [page, locale, returnSubject, returnCursor, origin]);
  useEffect(() => {
    if (page.state !== 'loaded' || !windows || !windowAuthorityKey || !windowSnapshot.focusReady) return;
    if (!origin?.isCurrent()) {
      windows.cancelMovementFocus(windowAuthorityKey);
      return;
    }
    if (windows.consumeFocus(windowAuthorityKey)) listHeading.current?.focus();
  }, [page.state, windows, windowAuthorityKey, windowSnapshot.focusReady, origin]);
  const addressFor = (target: string | null) => myLogsWindowHrefs(routeHref, target, locale);
  const move = (action: MyLogsWindowAction, target: string | null, event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      (event.button !== 0 && event.detail !== 0) ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (!router) return;
    event.preventDefault();
    if (!windows || !windowAuthorityKey || !origin?.isCurrent()) return;
    const destination = addressFor(target);
    if (
      !windows.beginMovement(
        windowAuthorityKey,
        action,
        effectiveCursor,
        target,
        event.currentTarget,
        event.detail === 0,
      )
    )
      return;
    void router.navigate({ href: destination.route });
  };
  const newest = addressFor(null);
  const openNewest = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      (event.button !== 0 && event.detail !== 0) ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !router
    )
      return;
    event.preventDefault();
    void router.navigate({ href: newest.route });
  };
  const windowControlClass =
    'inline-flex min-h-11 min-w-11 max-w-full items-center justify-center rounded-lg border border-border px-4 py-2 text-start whitespace-normal text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
  return (
    <article ref={listRoot} className="min-w-0 max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-2">
        <PageHeading ref={listHeading} tabIndex={-1}>
          {m.library_my_logs_heading()}
        </PageHeading>
        <p className="text-muted-foreground">{m.library_my_logs_description()}</p>
      </header>
      {page.state === 'invalid-position' ? (
        <div className="space-y-3">
          <p role="alert">{m.library_my_logs_invalid_position()}</p>
          <a
            href={newest.link}
            onClick={openNewest}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded px-3 py-2 text-start whitespace-normal text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.library_my_logs_newest()}
          </a>
        </div>
      ) : page.state === 'signed-out' ? (
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`}
          className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded px-3 py-2 text-start whitespace-normal text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {m.library_my_logs_sign_in()}
        </a>
      ) : page.state !== 'loaded' ? (
        <div className="space-y-3">
          <p role={page.state === 'preparing' ? 'status' : 'alert'}>
            {page.state === 'denied'
              ? m.library_my_logs_denied()
              : page.state === 'preparing'
                ? m.library_my_logs_preparing()
                : m.library_my_logs_unavailable()}
          </p>
          {onRetry ? (
            <Button
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full px-3 py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={onRetry}
            >
              {m.library_my_logs_retry()}
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {page.restarted ? <p role="status">{m.library_my_logs_restarted()}</p> : null}
          {page.logs.length ? (
            <ol aria-label={m.library_logs_heading()} className="space-y-2">
              {page.logs.map((log) => {
                const title = log.subject
                  ? displayLibraryTitle(log.subject.label, getLocale())
                  : { text: m.library_subject_unavailable(), lang: undefined };
                const state =
                  log.sessionState === 'completed'
                    ? m.library_progress_state_completed()
                    : log.sessionState === 'abandoned'
                      ? m.library_progress_state_abandoned()
                      : m.library_progress_state_active();
                return (
                  <ContentItem
                    key={log.id}
                    title={title.text}
                    {...(title.lang === undefined ? {} : { titleLang: title.lang })}
                    headingLevel={2}
                    className="px-3 [overflow-wrap:anywhere]"
                    visual={<SubjectCover subject={log.subject} ratio={ratio} />}
                    state={
                      <p className="text-sm text-muted-foreground">
                        {m.library_logs_session_state()}: {state}
                      </p>
                    }
                    metadata={
                      <div className="flex flex-col gap-1">
                        <SnapshotDate label={m.library_logs_published()} value={log.publishedAt} />
                        <SnapshotDate label={m.library_logs_started()} value={log.startedAt} />
                        {log.completedAt ? (
                          <SnapshotDate label={m.library_logs_completed()} value={log.completedAt} />
                        ) : null}
                      </div>
                    }
                    actions={
                      <Exposure operation="published_log.read">
                        <a
                          href={`/${getLocale()}/logs/${encodeURIComponent(log.id)}`}
                          data-published-log={log.id}
                          aria-label={m.library_my_logs_read({
                            title: title.text,
                            date: fullDateTime(log.publishedAt, getLocale()),
                          })}
                          className="inline-flex min-h-11 items-center rounded text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          onClick={(event) =>
                            logsDestinationClick(
                              event,
                              () => origin?.isCurrent() !== false,
                              returnSubject
                                ? logsReturnFrontier(locale, returnSubject, returnCursor ?? null, log.id)
                                : null,
                            )
                          }
                        >
                          {m.library_my_logs_open_log()}
                        </a>
                      </Exposure>
                    }
                    preview={
                      log.note ? (
                        <details className="group/note min-w-0">
                          <summary className="cursor-pointer list-none rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                            <span
                              aria-hidden="true"
                              className="line-clamp-3 whitespace-pre-wrap [overflow-wrap:anywhere] group-open/note:hidden"
                            >
                              {log.note}
                            </span>
                            <span className="flex min-h-11 items-center text-sm text-primary underline underline-offset-4">
                              {m.library_my_logs_full_note()}
                            </span>
                          </summary>
                          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{log.note}</p>
                        </details>
                      ) : null
                    }
                  />
                );
              })}
            </ol>
          ) : (
            <p className="text-muted-foreground">
              {page.next || (cursor && !page.restarted) ? m.library_my_logs_no_visible() : m.library_logs_empty()}
            </p>
          )}
        </>
      )}
      {canPrevious || canNewest || canNext ? (
        <Exposure operation="published_log.list">
          <nav aria-label={m.library_logs_heading()} className="flex min-w-0 flex-wrap items-start gap-2">
            {canPrevious ? (
              <a
                href={addressFor(previousCursor).link}
                className={windowControlClass}
                onClick={(event) => move('previous', previousCursor, event)}
              >
                {m.library_my_logs_previous()}
              </a>
            ) : null}
            {canNewest ? (
              <a href={newest.link} className={windowControlClass} onClick={(event) => move('newest', null, event)}>
                {m.library_my_logs_newest()}
              </a>
            ) : null}
            {canNext ? (
              <a
                href={addressFor(admittedNext).link}
                className={windowControlClass}
                onClick={(event) => move('next', admittedNext, event)}
              >
                {m.library_my_logs_next()}
              </a>
            ) : null}
          </nav>
        </Exposure>
      ) : null}
    </article>
  );
}
