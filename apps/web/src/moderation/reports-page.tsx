import { useContext, useId, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import {
  DEFAULT_REPORT_SELECTION,
  reportPageIsCurrent,
  reportReadKey,
  reportSelection,
  type PrivateReportPage,
  type ReportReadInput,
  type ReportSelection,
  type ReportReadState,
} from './reports-read';
import { useSession } from '../session/query';
import { createPrivateReaderLifetime } from './private-reader-lifetime';
import { moderationEvidence } from './target-context';
import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { actionOnReport } from './actions';
import { BoardReportQueue, type ReportQueueAction } from '../stories/patterns/board-report-queue/board-report-queue';
import type { Report, ReportedRevision, ResolvedReportTarget } from './reports-read';
import { localizeHref } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../threads/authoring-departure';
import { useRouter } from '@tanstack/react-router';
import { reportReviewNavigationContext } from './reports-bulk-controls';

export { moderationTargetContent } from './target-content';
export type ModerationTarget = ResolvedReportTarget;

const submitReportAction: ReportQueueAction = async (data) => {
  return actionOnReport({ data, headers: csrfHeaders() });
};

export type ReportNavigation = { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };

/** Default route binding. Only a fresh native read can replace a retired private visit. */
export function ModerationReportsPage(props: {
  page: PrivateReportPage;
  input: ReportReadInput;
  active?: boolean;
  navigation?: ReportNavigation;
  onAction?: ReportQueueAction;
  onNext?: (cursor: string) => void;
  onSelection?: (selection: ReportSelection) => void | Promise<void>;
  onRestart?: () => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
}) {
  const client = useContext(QueryClientContext);
  const browserClient = typeof window !== 'undefined' ? client : undefined;
  const visit = useRef<ReturnType<typeof createVisit> | null>(null);
  function createVisit() {
    const original = props;
    const page = original.page;
    const owner = browserClient
      ? createPrivateReaderLifetime(browserClient, page, reportReadKey(page.input), original.navigation)
      : undefined;
    let retired = false;
    let departure = false;
    let connected = true;
    let serial = 0;
    const listeners = new Set<() => void>();
    const retire = () => {
      if (retired) return;
      retired = true;
      serial++;
      owner?.retire();
      for (const listener of listeners) listener();
    };
    const observe = () => {
      if (owner && !owner.healthy()) retire();
      if (original.navigation?.isCurrent() === false) retire();
      return retired;
    };
    const isCurrent = () => connected && !observe() && (!owner || owner.isCurrent());
    const leave = (callback: (() => void) | undefined) => {
      if (!departure && !isCurrent()) return;
      departure = false;
      retire();
      callback?.();
    };
    return {
      page,
      canCommand: () => isCurrent() && (!owner || owner.canCommand()),
      client: browserClient,
      owner,
      action: original.onAction,
      navigation: original.navigation,
      retire,
      depart: () => {
        if (!isCurrent()) return;
        departure = true;
        retire();
      },
      observe,
      isCurrent,
      subscribe(listener: () => void) {
        connected = true;
        listeners.add(listener);
        const disconnectSession = owner?.subscribe(() => {
          observe();
          for (const listener of listeners) listener();
        });
        const disconnectNavigation = !owner ? original.navigation?.subscribe(retire) : undefined;
        observe();
        return () => {
          connected = false;
          // The original owner fences new mounts. Inputs may be structurally shared with
          // a healthy new native generation and cannot serve as retirement markers.
          serial++;
          listeners.delete(listener);
          disconnectSession?.();
          disconnectNavigation?.();
          // Strict Mode may reconnect synchronously; disconnected settlements are already fenced.
          queueMicrotask(() => {
            if (!connected) retire();
          });
        };
      },
      next: (cursor: string) => leave(() => original.onNext?.(cursor)),
      select: (selection: ReportSelection) =>
        leave(() => {
          void original.onSelection?.(selection);
        }),
      restart: () => leave(original.onRestart),
      retry: () => leave(original.onRetry),
      async refresh() {
        if (!isCurrent()) return;
        const attempt = serial;
        await original.onRefresh?.();
        if (!isCurrent() || attempt !== serial) return;
      },
      async submit(input: Parameters<ReportQueueAction>[0]) {
        // Keep the original transport and exact intent. A retired caller never starts it.
        if (!isCurrent()) return;
        if (owner && !owner.canCommand()) return { ok: false as const, state: 'forbidden' as const };
        return (original.onAction ?? submitReportAction)(input);
      },
    };
  }
  const previous = visit.current;
  if (!previous || previous.page.generation !== props.page.generation) {
    previous?.retire();
    visit.current = createVisit();
  }
  const current = visit.current!;
  if (
    current.page.state !== props.page.state ||
    current.page.readKey !== props.page.readKey ||
    current.client !== browserClient ||
    current.action !== props.onAction ||
    current.navigation !== props.navigation ||
    props.active === false ||
    !reportPageIsCurrent(props.page, props.input)
  )
    current.retire();
  useSyncExternalStore(
    current.subscribe,
    () => current.owner?.snapshot() ?? Number(current.observe()),
    () => 0,
  );
  const retired = current.observe();
  // The browser cache is authoritative even before a session hook has hydrated. Standalone SSR
  // fixtures have no browser source; they retain only their explicit prepared native admission.
  if (retired || (typeof window !== 'undefined' && !browserClient) || (current.owner && !current.owner.available()))
    return (
      <ContentItemFrame as="div" role="status" className="p-4 sm:p-6">
        <ContentItemHeading level={2} className="text-base font-semibold">
          {m.moderation_target_unavailable()}
        </ContentItemHeading>
        {!retired && current.owner?.healthy() && props.onRetry ? (
          <Button onClick={current.retry}>{m.moderation_queue_retry()}</Button>
        ) : null}
      </ContentItemFrame>
    );
  const { page } = current;
  const input = page.input;
  return (
    <div
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a') && !current.isCurrent()) event.preventDefault();
      }}
    >
      <ModerationReportsView
        key={page.generation}
        boardId={input.boardId}
        {...(input.threadId ? { threadId: input.threadId } : {})}
        {...(input.postId ? { postId: input.postId } : {})}
        selection={reportSelection(input)}
        viewerId={page.viewerId}
        reports={page.reports}
        targets={page.targets}
        revisions={page.revisions}
        next={page.next}
        state={page.state}
        queueIdentity={page.generation}
        isCurrent={current.isCurrent}
        onLeave={current.depart}
        onAction={current.submit}
        {...(props.onNext ? { onNext: current.next } : {})}
        {...(props.onSelection ? { onSelection: current.select } : {})}
        {...(props.onRestart ? { onRestart: current.restart } : {})}
        {...(props.onRetry ? { onRetry: current.retry } : {})}
        {...(props.onRefresh ? { onRefresh: current.refresh } : {})}
      />
    </div>
  );
}

type ModerationReportsViewProps = {
  queueIdentity?: string;
  isCurrent?: () => boolean;
  boardId?: string;
  state?: ReportReadState;
  selection?: ReportSelection;
  onSelection?: (selection: ReportSelection) => void | Promise<void>;
  onRestart?: () => void;
  viewerId?: string;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
  reports: Report[];
  targets: ModerationTarget[];
  revisions?: ReportedRevision[];
  next: string | null;
  tab?: 'reports' | 'appeals';
  threadId?: string;
  postId?: string;
  onNext?: (cursor: string) => void;
  onAction?: ReportQueueAction;
  onLeave?: () => void;
};

export function ModerationReportsView(props: ModerationReportsViewProps) {
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={reportReviewNavigationContext}>
      <ReportsView
        key={
          props.queueIdentity ??
          JSON.stringify([props.boardId, props.threadId, props.postId, props.tab, props.selection])
        }
        {...props}
      />
    </AuthoringDepartureBoundary>
  );
}

function ReportsView({
  reports,
  targets,
  revisions = [],
  next,
  tab = 'reports',
  threadId,
  postId,
  onNext,
  onAction = submitReportAction,
  boardId,
  state = 'ready',
  onRetry,
  onRefresh,
  selection = DEFAULT_REPORT_SELECTION,
  onSelection,
  onRestart,
  viewerId,
  queueIdentity,
  isCurrent,
  onLeave,
}: ModerationReportsViewProps) {
  const session = useSession();
  const browserClient = useContext(QueryClientContext);
  const router = useRouter({ warn: false });
  const { requestNavigation } = useAuthoringDeparture(false, false, 'report-selectors');
  const controlsId = useId();
  const [retired, setRetired] = useState(false);
  const select = (value: ReportSelection) => {
    if (retired || isCurrent?.() === false) return;
    requestNavigation(() => {
      setRetired(true);
      void onSelection?.(value);
    });
  };
  const evidence = [...targets, ...revisions].map((target) => moderationEvidence(target.value));
  if (
    ((browserClient !== undefined && typeof window !== 'undefined') || session.state !== 'unknown') &&
    ((viewerId !== undefined && (session.state !== 'signed-in' || session.subject !== viewerId)) ||
      evidence.some((item) => item && (session.state !== 'signed-in' || session.subject !== item.viewerId)))
  )
    return (
      <ContentItemFrame as="div" role="status" className="p-4 sm:p-6">
        <ContentItemHeading level={2} className="text-base font-semibold">
          {m.moderation_target_unavailable()}
        </ContentItemHeading>
      </ContentItemFrame>
    );
  const filters = [
    threadId ? `thread=${encodeURIComponent(threadId)}` : '',
    postId ? `post=${encodeURIComponent(postId)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const selectedQuery = new URLSearchParams(selection).toString();
  const reportsHref = `?${filters ? `${filters}&` : ''}${selectedQuery}`;
  const appealsHref = `?tab=appeals${filters ? `&${filters}` : ''}`;
  const selectedStatus = {
    all: m.moderation_filter_all_status(),
    pending: m.moderation_filter_pending(),
    resolved: m.moderation_filter_resolved(),
  }[selection.status];
  const selectedKind = {
    all: m.moderation_filter_all_kinds(),
    board: m.moderation_queue_board(),
    thread: m.moderation_queue_thread(),
    post: m.moderation_queue_post(),
  }[selection.targetKind];
  const selectedOrder = {
    newest: m.moderation_filter_newest(),
    oldest: m.moderation_filter_oldest(),
  }[selection.order];
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]"
      onClick={(event) => {
        if (
          retired ||
          isCurrent?.() === false ||
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link = (event.target as Element).closest('a');
        if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return;
        const href = new URL(link.href, window.location.href);
        if (href.href === window.location.href) return;
        event.preventDefault();
        requestNavigation(() => {
          if (router && href.origin === window.location.origin)
            void router.navigate({ href: href.pathname + href.search + href.hash });
          else window.location.assign(href.href);
        });
      }}
    >
      <header className="space-y-3">
        {boardId ? (
          <a
            className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-4 hover:underline"
            href={localizeHref(`/boards/${encodeURIComponent(boardId)}`)}
          >
            {m.moderation_queue_back()}
          </a>
        ) : null}
        <PageHeading>{m.moderation_reports_heading()}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {postId
            ? m.moderation_queue_post_scope()
            : threadId
              ? m.moderation_thread_filter()
              : m.moderation_queue_board_scope()}
        </p>
      </header>
      <nav aria-label={m.moderation_tabs_label()} className="flex min-w-0 flex-wrap gap-2 border-b pb-2">
        {tab === 'reports' ? (
          <a
            href={reportsHref}
            aria-current="page"
            className="inline-flex min-h-11 min-w-11 max-w-full items-center border-b-2 border-primary px-3 py-2 font-semibold underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.moderation_reports_tab()}
          </a>
        ) : (
          <a
            href={reportsHref}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center border-b-2 border-transparent px-3 py-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.moderation_reports_tab()}
          </a>
        )}
        {tab === 'appeals' ? (
          <a
            href={appealsHref}
            aria-current="page"
            className="inline-flex min-h-11 min-w-11 max-w-full items-center border-b-2 border-primary px-3 py-2 font-semibold underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.moderation_appeals_tab()}
          </a>
        ) : (
          <a
            href={appealsHref}
            className="inline-flex min-h-11 min-w-11 max-w-full items-center border-b-2 border-transparent px-3 py-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.moderation_appeals_tab()}
          </a>
        )}
      </nav>
      <p id={`${controlsId}-summary`} className="min-w-0 text-sm leading-relaxed text-muted-foreground">
        {m.moderation_controls_details_summary({ status: selectedStatus, kind: selectedKind, order: selectedOrder })}
      </p>
      <fieldset
        className="flex min-w-0 flex-wrap items-end gap-3"
        aria-describedby={`${controlsId}-summary`}
        disabled={!onSelection || retired}
      >
        <legend className="sr-only">{m.moderation_filter_label()}</legend>
        <label htmlFor={`${controlsId}-status`} className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
          <span className="block">{m.moderation_filter_status()}</span>
          <NativeSelect
            id={`${controlsId}-status`}
            className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11"
            value={selection.status}
            onChange={(event) => select({ ...selection, status: event.target.value as ReportSelection['status'] })}
          >
            <NativeSelectOption value="all">{m.moderation_filter_all_status()}</NativeSelectOption>
            <NativeSelectOption value="pending">{m.moderation_filter_pending()}</NativeSelectOption>
            <NativeSelectOption value="resolved">{m.moderation_filter_resolved()}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label htmlFor={`${controlsId}-kind`} className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
          <span className="block">{m.moderation_filter_kind()}</span>
          <NativeSelect
            id={`${controlsId}-kind`}
            className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11"
            value={selection.targetKind}
            onChange={(event) =>
              select({ ...selection, targetKind: event.target.value as ReportSelection['targetKind'] })
            }
          >
            <NativeSelectOption value="all">{m.moderation_filter_all_kinds()}</NativeSelectOption>
            <NativeSelectOption value="board">{m.moderation_queue_board()}</NativeSelectOption>
            <NativeSelectOption value="thread">{m.moderation_queue_thread()}</NativeSelectOption>
            <NativeSelectOption value="post">{m.moderation_queue_post()}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label htmlFor={`${controlsId}-order`} className="min-w-0 flex-1 basis-48 space-y-1 text-sm">
          <span className="block">{m.moderation_filter_order()}</span>
          <NativeSelect
            id={`${controlsId}-order`}
            className="w-full min-w-0 max-w-full [&_select]:min-h-11 [&_select]:min-w-11"
            value={selection.order}
            onChange={(event) => select({ ...selection, order: event.target.value as ReportSelection['order'] })}
          >
            <NativeSelectOption value="newest">{m.moderation_filter_newest()}</NativeSelectOption>
            <NativeSelectOption value="oldest">{m.moderation_filter_oldest()}</NativeSelectOption>
          </NativeSelect>
        </label>
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full whitespace-normal break-words py-2"
          onClick={() => select(DEFAULT_REPORT_SELECTION)}
        >
          {m.moderation_filter_reset()}
        </Button>
      </fieldset>
      <BoardReportQueue
        {...(onLeave ? { onLeave } : {})}
        {...(isCurrent ? { isCurrent } : {})}
        bulkEnabled={tab === 'reports'}
        queueIdentity={
          queueIdentity ??
          JSON.stringify([
            boardId,
            threadId,
            postId,
            tab,
            selection.status,
            selection.targetKind,
            selection.order,
            viewerId,
            session.state,
            session.subject,
            session.csrfToken,
          ])
        }
        reports={reports}
        targets={targets}
        revisions={revisions}
        onAction={onAction}
        next={next}
        {...(onNext ? { onNext } : {})}
        state={retired ? 'loading' : state}
        {...(onRestart ? { onRestart } : {})}
        {...(onRetry ? { onRetry } : {})}
        {...(onRefresh ? { onRefresh } : {})}
      />
    </article>
  );
}
