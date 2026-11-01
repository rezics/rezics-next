import { useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { NativeSelect, NativeSelectOption } from '@rezics/ui/shadcn/native-select';
import { DEFAULT_REPORT_SELECTION, type ReportSelection, type ReportReadState } from './reports-read';
import { useSession } from '../session/query';
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
}: {
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
  const controlsId = useId();
  const [retired, setRetired] = useState(false);
  const select = (value: ReportSelection) => {
    setRetired(true);
    void Promise.resolve(onSelection?.(value)).finally(() => setRetired(false));
  };
  const evidence = [...targets, ...revisions].map((target) => moderationEvidence(target.value));
  if (
    session.state !== 'unknown' &&
    ((viewerId !== undefined && (session.state !== 'signed-in' || session.subject !== viewerId)) ||
      evidence.some((item) => item && (session.state !== 'signed-in' || session.subject !== item.viewerId)))
  )
    return <p role="status">{m.moderation_target_unavailable()}</p>;
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
        bulkEnabled={tab === 'reports'}
        queueIdentity={JSON.stringify([
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
        ])}
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
