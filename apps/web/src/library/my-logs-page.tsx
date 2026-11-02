import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
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
import { readMyPublishedLogHistoryForViewer, type MyLogsViewerHistory } from './logs-server';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';

const logOperations = ['published_log.list'] as const;

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
  useOperation('published_log.list');
  const locale = getLocale();
  const address = useHistoryAddress('/library/logs', myLogsSearch({ cursor }).cursor, locale);
  const origin = useHistoryCurrentOrigin(
    address.key,
    logOperations,
    initial.page.state === 'loaded' ? initial.sessionSubject : null,
  );
  const current = () => address.isCurrent() && origin.current(0);
  const queryKey = [
    'my-logs-current-viewer',
    origin.subject,
    'published_log.list',
    true,
    address.cursor,
    locale,
    origin.lifetime(0),
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
  return (
    <MyLogsPageView
      origin={{ lifetime: origin.boundary.lifetime, isCurrent: () => current() && readCurrent() }}
      page={page}
      cursor={page.state === 'loaded' ? (address.cursor ?? undefined) : undefined}
      onRetry={
        origin.subject && origin.allowed[0]
          ? () => {
              if (current()) void query.refetch();
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
}: {
  page: MyLogsPage;
  cursor?: string | undefined;
  onRetry?: (() => void) | undefined;
  origin?: HistoryOrigin;
}) {
  const ratio = rowRatio(page.state === 'loaded' ? page.logs.map((log) => log.subject) : []);
  return (
    <article className="min-w-0 max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="space-y-2">
        <PageHeading>{m.library_my_logs_heading()}</PageHeading>
        <p className="text-muted-foreground">{m.library_my_logs_description()}</p>
      </header>
      {page.state === 'invalid-position' ? (
        <div className="space-y-3">
          <p role="alert">{m.library_my_logs_invalid_position()}</p>
          <a
            href={`/${getLocale()}/library/logs`}
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
                          aria-label={m.library_my_logs_read({
                            title: title.text,
                            date: fullDateTime(log.publishedAt, getLocale()),
                          })}
                          className="inline-flex min-h-11 items-center rounded text-sm text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
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
      {(page.state === 'loaded' && (page.next || page.restarted)) || cursor ? (
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          {page.state === 'loaded' && page.next ? (
            <Exposure operation="published_log.list">
              <Link
                to="/library/logs"
                search={{ cursor: page.next }}
                onClick={(event) => {
                  if (origin && !origin.isCurrent()) event.preventDefault();
                }}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-lg border border-border px-4 py-2 text-start whitespace-normal text-primary hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {m.library_logs_more()}
              </Link>
            </Exposure>
          ) : null}
          {cursor || (page.state === 'loaded' && page.restarted) ? (
            <Link
              to="/library/logs"
              search={{}}
              onClick={(event) => {
                if (origin && !origin.isCurrent()) event.preventDefault();
              }}
              className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded px-3 py-2 text-start whitespace-normal text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.library_my_logs_newest()}
            </Link>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
