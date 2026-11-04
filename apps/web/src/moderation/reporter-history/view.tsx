import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { viewerExposureLifetime, viewerExposureQuery } from '../../kernel/viewer-exposure';
import { m } from '../../paraglide/messages.js';
import { getLocale, localizeHref } from '../../paraglide/runtime.js';
import { sessionQuery, useSession } from '../../session/query';
import {
  createReporterHistoryJourney,
  type ReporterHistoryNavigation,
  type ReporterHistoryReader,
  type ReporterHistoryState,
  type ReporterHistoryVisit,
} from './journey';
import type { ReporterHistoryEntry, ReporterHistoryPage, ReporterHistoryQuery } from './model';
import { reporterHistoryStatusHref } from './navigation';
import type { ReporterHistoryFocus } from './focus';
import { browserObservation } from '../../session/observation';

const idleSubscribe = () => () => {};
const browserReady = () => true;
const serverReady = () => false;
const readCurrent: ReporterHistoryReader = async (query) =>
  (await import('./server')).readReporterHistory({ data: query });

type Access = { state: 'loading' | 'denied' | 'unavailable' | 'ready'; identity: string };

function useReporterHistoryAccess(): Access {
  const cache = useQueryClient();
  const session = useSession();
  const hydrated = useSyncExternalStore(idleSubscribe, browserReady, serverReady);
  const lifetime = viewerExposureLifetime(cache);
  const admission = useSyncExternalStore(lifetime.subscribe, lifetime.getSnapshot, lifetime.getServerSnapshot);
  const observation = admission.state === 'signed-in' ? admission.observation : undefined;
  const exposure = useQuery(
    { ...viewerExposureQuery(observation), enabled: hydrated && observation !== undefined },
    cache,
  );
  const identity = useMemo(
    () => crypto.randomUUID(),
    [
      cache,
      session.state,
      session.state === 'signed-in' ? session.subject : null,
      observation?.id,
      exposure.status,
      exposure.dataUpdatedAt,
      exposure.data,
    ],
  );

  const sessionStatus = cache.getQueryState(sessionQuery.queryKey)?.status;
  if (session.state === 'unavailable' || sessionStatus === 'error') return { state: 'unavailable', identity };
  if (!hydrated || session.state === 'unknown') return { state: 'loading', identity };
  if (session.state !== 'signed-in') return { state: 'denied', identity };
  if (exposure.status === 'error') return { state: 'unavailable', identity };
  if (exposure.status !== 'success' || !observation) return { state: 'loading', identity };
  const currentSession = observation.subject === session.subject && exposure.data?.subject === session.subject;
  return { state: currentSession ? 'ready' : 'denied', identity };
}

export function ReporterHistoryCurrent(props: {
  initial: ReporterHistoryVisit;
  navigation?: ReporterHistoryNavigation;
  read?: ReporterHistoryReader;
  focus?: ReporterHistoryFocus;
}) {
  const access = useReporterHistoryAccess();
  const locale = getLocale();
  const visitKey = useMemo(
    () => crypto.randomUUID(),
    [props.initial.generation, props.navigation, props.read, access.identity, locale],
  );
  const active = useRef<{ key: string; retire?: () => void }>({ key: visitKey });
  const registerRetire = useMemo(
    () => (key: string, retire: () => void) => {
      if (active.current.key === key) active.current.retire = retire;
    },
    [],
  );
  if (active.current.key !== visitKey) {
    active.current.retire?.();
    active.current = { key: visitKey };
  }
  if (access.state !== 'ready') {
    active.current.retire?.();
    delete active.current.retire;
    return <ReporterHistoryPage result={{ state: access.state }} query={props.initial.query} />;
  }
  return (
    <ReporterHistoryVisit
      key={visitKey}
      visitKey={visitKey}
      initial={props.initial}
      {...(props.navigation ? { navigation: props.navigation } : {})}
      read={props.read ?? readCurrent}
      {...(props.focus ? { focus: props.focus } : {})}
      registerRetire={registerRetire}
    />
  );
}

function ReporterHistoryVisit({
  visitKey,
  initial,
  navigation,
  read,
  registerRetire,
  focus,
}: {
  visitKey: string;
  initial: ReporterHistoryVisit;
  navigation?: ReporterHistoryNavigation;
  read: ReporterHistoryReader;
  focus?: ReporterHistoryFocus;
  registerRetire: (key: string, retire: () => void) => void;
}) {
  const cache = useQueryClient();
  const [original] = useState({ cache, initial, navigation, read });
  const journey = useMemo(
    () => createReporterHistoryJourney(original.cache, original.initial, original.read, getLocale, original.navigation),
    [original],
  );
  if (
    cache !== original.cache ||
    navigation !== original.navigation ||
    read !== original.read ||
    initial.generation !== original.initial.generation
  )
    journey.retire();
  useLayoutEffect(() => {
    registerRetire(visitKey, journey.retire);
    return () => journey.retire();
  }, [journey, registerRetire, visitKey]);
  const result = useSyncExternalStore(journey.subscribe, journey.snapshot, journey.serverSnapshot);
  const boundary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (result.state !== 'loading' && result.state !== 'retired' && boundary.current)
      focus?.arrive(boundary.current, journey.operands(), journey.isConnected);
  }, [focus, journey, result]);
  return (
    <div
      ref={boundary}
      onClickCapture={(event) => {
        const source = (event.target as Element).closest<HTMLElement>('button, a[data-reporter-status]');
        if (source && event.detail === 0 && journey.isConnected()) {
          const observation = browserObservation(cache).getSnapshot();
          focus?.activate(source, () => {
            const next = browserObservation(cache).getSnapshot();
            return (
              getLocale() === initial.locale &&
              observation.state === 'signed-in' &&
              next.state === 'signed-in' &&
              next.observation === observation.observation
            );
          });
        }
        if ((event.target as Element).closest('a') && !journey.isCurrent()) event.preventDefault();
      }}
    >
      <ReporterHistoryPage
        result={result}
        query={journey.operands()}
        {...(navigation?.openStatus ? { onOpenStatus: navigation.openStatus } : {})}
        onRefresh={() => journey.refresh()}
        onRetry={() => journey.retry()}
        onContinue={() => journey.next()}
        onSelect={(reportId) => journey.select(reportId)}
        onRestart={() => journey.restart()}
      />
    </div>
  );
}

type Retry = () => void | Promise<void>;

export function ReporterHistoryPage({
  result,
  query,
  onRetry = () => undefined,
  onContinue = () => undefined,
  onSelect = () => undefined,
  onRestart = () => undefined,
  onRefresh,
  onOpenStatus,
}: {
  result: ReporterHistoryState;
  query: ReporterHistoryQuery;
  onRetry?: Retry;
  onContinue?: Retry;
  onSelect?: (reportId: string) => void | Promise<void>;
  onRestart?: Retry;
  onRefresh?: Retry;
  onOpenStatus?: (reportId: string, cursor?: string) => Promise<void>;
}) {
  return (
    <section
      className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 sm:py-10"
      aria-labelledby="reporter-history-heading"
      aria-busy={result.state === 'loading'}
    >
      <header className="space-y-2">
        <h1 id="reporter-history-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {m.reporter_history_heading()}
        </h1>
        <p className="text-sm text-muted-foreground">{m.reporter_history_intro()}</p>
        {onRefresh && result.state === 'loaded' ? (
          <button
            type="button"
            className="min-h-11 rounded-md border px-4 font-medium"
            onClick={() => void onRefresh()}
          >
            {m.reporter_status_refresh()}
          </button>
        ) : null}
      </header>
      {result.state === 'loading' ? <p role="status">{m.reporter_history_loading()}</p> : null}
      {result.state === 'denied' ? <HistoryFailure message={m.reporter_history_denied()} retry={onRetry} /> : null}
      {result.state === 'unavailable' ? (
        <HistoryFailure
          message={
            query.cursor !== undefined
              ? m.reporter_history_continuation_unavailable()
              : m.reporter_history_unavailable()
          }
          retry={onRetry}
        />
      ) : null}
      {result.state === 'expired' ? (
        <div role="alert" className="space-y-3 rounded-lg border p-4">
          <p>{m.reporter_history_expired()}</p>
          <button
            type="button"
            className="min-h-11 rounded-md border px-4 font-medium"
            onClick={() => void onRestart()}
          >
            {m.reporter_history_restart()}
          </button>
        </div>
      ) : null}
      {result.state === 'retired' ? <p role="status">{m.reporter_history_denied()}</p> : null}
      {result.state === 'loaded' ? (
        <ReporterHistoryResults
          page={result.page}
          query={query}
          onSelect={onSelect}
          onContinue={onContinue}
          {...(onOpenStatus ? { onOpenStatus } : {})}
        />
      ) : null}
    </section>
  );
}

function HistoryFailure({ message, retry }: { message: string; retry: Retry }) {
  return (
    <div role="alert" className="space-y-3 rounded-lg border p-4">
      <p>{message}</p>
      <button type="button" className="min-h-11 rounded-md border px-4 font-medium" onClick={() => void retry()}>
        {m.reporter_history_retry()}
      </button>
    </div>
  );
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case 'off_topic':
      return m.report_off_topic();
    case 'inappropriate':
      return m.report_inappropriate();
    case 'spam':
      return m.report_spam();
    case 'illegal':
      return m.report_illegal();
    case 'other':
      return m.report_other();
    default:
      return reason;
  }
}

function outcomeLabel(entry: ReporterHistoryEntry): string {
  if (entry.outcome === null) return m.reporter_status_pending();
  return entry.outcome === 'actioned' ? m.moderation_actioned() : m.moderation_dismissed();
}

function ReporterHistoryResults({
  page,
  query,
  onSelect,
  onContinue,
  onOpenStatus,
}: {
  page: ReporterHistoryPage;
  query: ReporterHistoryQuery;
  onSelect: (reportId: string) => void | Promise<void>;
  onOpenStatus?: (reportId: string, cursor?: string) => Promise<void>;
  onContinue: Retry;
}) {
  const selectedUnavailable =
    page.state === 'ready' && query.reportId !== undefined && page.selectedReportId !== query.reportId;
  return (
    <div className="space-y-5">
      {page.state === 'ready' && page.entries.length > 0 ? <p role="status">{m.reporter_history_ready()}</p> : null}
      {page.state === 'preparing' ? <p role="status">{m.reporter_history_preparing()}</p> : null}
      {selectedUnavailable ? <p role="alert">{m.reporter_history_selected_unavailable()}</p> : null}
      {page.entries.length > 0 ? (
        <ol className="space-y-4">
          {page.entries.map((entry) => (
            <HistoryEntry
              key={entry.id}
              entry={entry}
              selected={page.selectedReportId === entry.id}
              query={query}
              onSelect={onSelect}
              {...(onOpenStatus ? { onOpenStatus } : {})}
            />
          ))}
        </ol>
      ) : page.state === 'ready' && !selectedUnavailable && page.nextCursor === null ? (
        <p role="status">{m.reporter_history_empty()}</p>
      ) : page.state === 'ready' && page.entries.length === 0 && !selectedUnavailable ? (
        <p role="status">{m.reporter_history_sparse()}</p>
      ) : null}
      {page.state === 'ready' && page.nextCursor !== null ? (
        <button type="button" className="min-h-11 rounded-md border px-4 font-medium" onClick={() => void onContinue()}>
          {m.reporter_history_continue()}
        </button>
      ) : null}
    </div>
  );
}

function HistoryEntry({
  entry,
  selected,
  query,
  onSelect,
  onOpenStatus,
}: {
  entry: ReporterHistoryEntry;
  selected: boolean;
  query: ReporterHistoryQuery;
  onSelect: (reportId: string) => void | Promise<void>;
  onOpenStatus?: (reportId: string, cursor?: string) => Promise<void>;
}) {
  const summary = entry.targetSummary;
  const targetLabel = summary.state === 'available' ? summary.label || m.reporter_status_target() : null;
  const statusHref = selected ? localizeHref(reporterHistoryStatusHref(entry.id, query.cursor)) : undefined;
  return (
    <li className="min-w-0 break-words rounded-lg border p-4 sm:p-5" data-selected={selected || undefined}>
      <article className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="font-semibold">
              {summary.state === 'available' ? (
                <a className="underline underline-offset-4" href={summary.href}>
                  {targetLabel}
                </a>
              ) : (
                <span>{m.reporter_history_item_unavailable()}</span>
              )}
            </h2>
            <p className="text-sm text-muted-foreground">
              {m.reporter_status_submitted()}: <time dateTime={entry.createdAt}>{timeLabel(entry.createdAt)}</time>
            </p>
          </div>
          <span className="rounded-full border px-3 py-1 text-sm">{outcomeLabel(entry)}</span>
        </header>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="font-medium text-muted-foreground">{m.moderation_reason_label()}</dt>
            <dd className="break-words">{reasonLabel(entry.reason)}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">{m.reporter_history_outcome()}</dt>
            <dd>{outcomeLabel(entry)}</dd>
          </div>
          <div>
            <dt className="font-medium text-muted-foreground">{m.reporter_status_reviewed()}</dt>
            <dd>
              {entry.resolvedAt ? (
                <time dateTime={entry.resolvedAt}>{timeLabel(entry.resolvedAt)}</time>
              ) : (
                m.reporter_status_awaiting_review()
              )}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="min-h-11 rounded-md border px-4 font-medium"
            data-report-id={entry.id}
            aria-pressed={selected}
            onClick={() => void onSelect(entry.id)}
          >
            {selected ? m.reporter_history_selected() : m.reporter_history_select()}
          </button>
          {statusHref ? (
            <a
              className="inline-flex min-h-11 items-center px-2 font-medium underline underline-offset-4"
              href={statusHref}
              data-reporter-status
              onClick={(event) => {
                if (
                  !onOpenStatus ||
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                void onOpenStatus(entry.id, query.cursor);
              }}
            >
              {m.reporter_status_view()}
            </a>
          ) : null}
        </div>
      </article>
    </li>
  );
}
