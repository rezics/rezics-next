import { m } from '../paraglide/messages.js';
import { csrfHeaders } from '../threads/composer';
import { actionOnReport } from './actions';
import { BoardReportQueue } from '../stories/patterns/board-report-queue/board-report-queue';
import type { Report, ReportedRevision, ResolvedReportTarget } from './reports-read';
import { PageHeading } from '../shell/page-heading';

export { moderationTargetContent } from '../stories/patterns/board-report-queue/target-content';
export type ModerationTarget = ResolvedReportTarget;

export function ModerationReportsView({
  reports,
  targets,
  revisions = [],
  next,
  tab = 'reports',
  threadId,
  postId,
  onNext,
}: {
  reports: Report[];
  targets: ModerationTarget[];
  revisions?: ReportedRevision[];
  next: string | null;
  tab?: 'reports' | 'appeals';
  threadId?: string;
  postId?: string;
  onNext?: (cursor: string) => void;
}) {
  const filters = [
    threadId ? `thread=${encodeURIComponent(threadId)}` : '',
    postId ? `post=${encodeURIComponent(postId)}` : '',
  ]
    .filter(Boolean)
    .join('&');
  const reportsHref = filters ? `?${filters}` : '?';
  const appealsHref = `?tab=appeals${filters ? `&${filters}` : ''}`;
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">{m.moderation_reports_tab()}</p>
        <PageHeading>{m.moderation_reports_heading()}</PageHeading>
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
      {threadId ? <p className="text-sm text-muted-foreground">{m.moderation_thread_filter()}</p> : null}
      <BoardReportQueue
        reports={reports}
        targets={targets}
        revisions={revisions}
        onAction={async (data) => {
          await actionOnReport({ data, headers: csrfHeaders() });
          location.reload();
        }}
      />
      {next ? (
        <button type="button" className="rounded-md border px-4 py-2" onClick={() => onNext?.(next)}>
          {m.threads_next_page()}
        </button>
      ) : null}
    </article>
  );
}
