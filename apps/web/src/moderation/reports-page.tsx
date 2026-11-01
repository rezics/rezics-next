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

export { moderationTargetContent } from './target-content';
export type ModerationTarget = ResolvedReportTarget;

const submitReportAction: ReportQueueAction = async (data) => {
  return actionOnReport({ data, headers: csrfHeaders() });
};

export type ReportNavigation = { isCurrent: () => boolean; subscribe: (retire: () => void) => () => void };
// Each native read allocates its own original input object. Shallow loader copies retain this
// read token; weak retention cannot accumulate a history of private pages.
const retiredReads = new WeakSet<ReportReadInput>();

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
    let retired = retiredReads.has(page.input);
    let connected = true;
    let serial = 0;
    const listeners = new Set<() => void>();
    const retire = () => {
      if (retired) return;
      retired = true;
      serial++;
      retiredReads.add(page.input);
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
      if (!isCurrent()) return;
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
          // Mark the read synchronously for any new mount. Strict Mode reconnects this same
          // visit, whose local retirement flag remains separate from the admission marker.
          retiredReads.add(page.input);
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

export function ModerationReportsView({
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
}: {
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
}) {
  const session = useSession();
  const browserClient = useContext(QueryClientContext);
  const controlsId = useId();
  const [retired, setRetired] = useState(false);
  const select = (value: ReportSelection) => {
    setRetired(true);
    void Promise.resolve(onSelection?.(value)).finally(() => setRetired(false));
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
  return (
    <article className="mx-auto w-full max-w-4xl space-y-6 text-foreground">
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
      <nav aria-label={m.moderation_tabs_label()} className="flex gap-4 border-b pb-2">
        {tab === 'reports' ? (
          <span aria-current="page" className="font-semibold">
            {m.moderation_reports_tab()}
          </span>
        ) : (
          <a href={reportsHref}>{m.moderation_reports_tab()}</a>
        )}
        {tab === 'appeals' ? (
          <span aria-current="page" className="font-semibold">
            {m.moderation_appeals_tab()}
          </span>
        ) : (
          <a href={appealsHref}>{m.moderation_appeals_tab()}</a>
        )}
      </nav>
      <fieldset className="flex flex-wrap items-end gap-3" disabled={!onSelection || retired}>
        <legend className="sr-only">{m.moderation_filter_label()}</legend>
        <label htmlFor={`${controlsId}-status`} className="space-y-1 text-sm">
          <span className="block">{m.moderation_filter_status()}</span>
          <NativeSelect
            id={`${controlsId}-status`}
            value={selection.status}
            onChange={(event) => select({ ...selection, status: event.target.value as ReportSelection['status'] })}
          >
            <NativeSelectOption value="all">{m.moderation_filter_all_status()}</NativeSelectOption>
            <NativeSelectOption value="pending">{m.moderation_filter_pending()}</NativeSelectOption>
            <NativeSelectOption value="resolved">{m.moderation_filter_resolved()}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label htmlFor={`${controlsId}-kind`} className="space-y-1 text-sm">
          <span className="block">{m.moderation_filter_kind()}</span>
          <NativeSelect
            id={`${controlsId}-kind`}
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
        <label htmlFor={`${controlsId}-order`} className="space-y-1 text-sm">
          <span className="block">{m.moderation_filter_order()}</span>
          <NativeSelect
            id={`${controlsId}-order`}
            value={selection.order}
            onChange={(event) => select({ ...selection, order: event.target.value as ReportSelection['order'] })}
          >
            <NativeSelectOption value="newest">{m.moderation_filter_newest()}</NativeSelectOption>
            <NativeSelectOption value="oldest">{m.moderation_filter_oldest()}</NativeSelectOption>
          </NativeSelect>
        </label>
        <Button type="button" variant="outline" onClick={() => select(DEFAULT_REPORT_SELECTION)}>
          {m.moderation_filter_reset()}
        </Button>
      </fieldset>
      <BoardReportQueue
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
