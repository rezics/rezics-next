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
}: {
  boardId?: string;
  state?: 'ready' | 'loading' | 'error';
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
  const evidence = [...targets, ...revisions].map(target => moderationEvidence(target.value));
  if (session.state !== 'unknown' && evidence.some(item => item &&
    (session.state !== 'signed-in' || session.subject !== item.viewerId)))
    return <p role="status">{m.moderation_target_unavailable()}</p>;
  const filters = [
    threadId ? `thread=${encodeURIComponent(threadId)}` : '',
    postId ? `post=${encodeURIComponent(postId)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const reportsHref = filters ? `?${filters}` : '?';
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
      <BoardReportQueue
        reports={reports}
        targets={targets}
        revisions={revisions}
        onAction={onAction}
        next={next}
        {...(onNext ? { onNext } : {})}
        state={state}
        {...(onRetry ? { onRetry } : {})}
        {...(onRefresh ? { onRefresh } : {})}
      />
    </article>
  );
}
