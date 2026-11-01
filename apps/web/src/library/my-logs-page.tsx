import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Exposure, useOperation } from '../kernel/exposure';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import { fullDateTime } from '../threads/byline';
import { myLogsSearch, type MyLogsPage } from './my-logs';
import { readMyPublishedLogHistoryForViewer, type MyLogsViewerHistory } from './logs-server';
import { SubjectCover, rowRatio } from './subject-row';
import { displayLibraryTitle } from './title';

const subscribe = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;

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
}: {
  initial: MyLogsViewerHistory;
  cursor?: string | undefined;
}) {
  const hydrated = useSyncExternalStore(subscribe, hydratedSnapshot, serverSnapshot);
  const session = useSession();
  const canList = useOperation('published_log.list');
  const address = myLogsSearch({ cursor }).cursor ?? null;
  const locale = getLocale();
  const subject = hydrated
    ? session.state === 'signed-in' && session.subject
      ? session.subject
      : null
    : initial.page.state === 'loaded'
      ? initial.sessionSubject
      : null;
  // A successful SSR loader has already passed native list admission. The browser
  // must independently observe the current viewer and the current operation gate.
  const admitted = hydrated ? canList : initial.page.state === 'loaded';
  const key = JSON.stringify([subject, admitted, address, locale]);
  const [lifetime, setLifetime] = useState({ key, generation: 0, seed: true });
  if (lifetime.key !== key) setLifetime({ key, generation: lifetime.generation + 1, seed: false });

  if (!subject || !admitted) {
    const page: MyLogsPage =
      !hydrated && matchesAddress(initial, address, locale) && initial.page.state !== 'loaded'
        ? initial.page
        : {
            state:
              session.state === 'signed-out'
                ? 'signed-out'
                : session.state === 'unknown'
                  ? 'preparing'
                  : subject && !admitted
                    ? 'denied'
                    : 'unavailable',
          };
    return <MyLogsPageView page={page} />;
  }
  return (
    <MyLogsViewerRead
      key={lifetime.generation}
      subject={subject}
      cursor={address}
      locale={locale}
      hydrated={hydrated}
      initial={initial}
      seed={lifetime.seed}
    />
  );
}

function MyLogsViewerRead({
  subject,
  cursor,
  locale,
  hydrated,
  initial,
  seed,
}: {
  subject: string;
  cursor: string | null;
  locale: string;
  hydrated: boolean;
  initial: MyLogsViewerHistory;
  seed: boolean;
}) {
  // Retired owners, addresses and admissions cannot reuse a cache even on an ABA
  // return. CSRF rotation and equivalent response objects keep this lifetime.
  const [lifetime] = useState(() => crypto.randomUUID());
  const [initialData] = useState(() => (seed && matchesOwner(initial, subject, cursor, locale) ? initial : undefined));
  const query = useQuery({
    ...personalRead,
    queryKey: ['my-logs-current-viewer', subject, 'published_log.list', true, cursor, locale, lifetime],
    enabled: hydrated && personalRead.enabled,
    queryFn: async ({ signal }) => {
      const read = await readMyPublishedLogHistoryForViewer({ data: { cursor: cursor ?? undefined } });
      signal.throwIfAborted();
      return read;
    },
    initialData,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const previousLoader = useRef(initial);
  useEffect(() => {
    if (previousLoader.current === initial) return;
    previousLoader.current = initial;
    void query.refetch();
  }, [initial, query.refetch]);
  const read = query.isError ? undefined : query.data;
  const owner = read && matchesOwner(read, subject, cursor, locale);
  // Native failures have no asserted viewer or owner data. Keep their distinctions
  // within this request's lifetime instead of presenting successful empty history.
  const failure =
    read && read.sessionSubject === null && read.page.state !== 'loaded' && matchesAddress(read, cursor, locale);
  const page: MyLogsPage =
    owner || failure ? read.page : { state: query.isError || read ? 'unavailable' : 'preparing' };
  return (
    <MyLogsPageView
      page={page}
      cursor={owner ? (cursor ?? undefined) : undefined}
      onRetry={() => void query.refetch()}
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
}: {
  page: MyLogsPage;
  cursor?: string | undefined;
  onRetry?: () => void;
}) {
  const ratio = rowRatio(page.state === 'loaded' ? page.logs.map((log) => log.subject) : []);
  return (
    <article className="min-w-0 max-w-4xl space-y-6 text-foreground">
      <header className="space-y-2">
        <PageHeading>{m.library_my_logs_heading()}</PageHeading>
        <p className="text-muted-foreground">{m.library_my_logs_description()}</p>
      </header>
      {page.state === 'signed-out' ? (
        <a
          href={`/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/library/logs`)}`}
          className="text-primary underline"
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
            <Button variant="outline" onClick={onRetry}>
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
          {page.next ? (
            <Exposure operation="published_log.list">
              <Link
                to="/library/logs"
                search={{ cursor: page.next }}
                className="inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-primary hover:bg-muted"
              >
                {m.library_logs_more()}
              </Link>
            </Exposure>
          ) : null}
        </>
      )}
      {cursor || (page.state === 'loaded' && page.restarted) ? (
        <Link
          to="/library/logs"
          search={{}}
          className="inline-flex min-h-10 items-center text-primary underline-offset-4 hover:underline"
        >
          {m.library_my_logs_newest()}
        </Link>
      ) : null}
    </article>
  );
}
