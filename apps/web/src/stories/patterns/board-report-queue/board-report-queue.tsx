import { Button } from '@rezics/ui/shadcn/button';
import { Skeleton } from '@rezics/ui/shadcn/skeleton';
import { useState } from 'react';
import { m } from '../../../paraglide/messages.js';
import type { ReportQueueAction } from '../../../moderation/reports-view-action';
import type { Report, ReportedRevision, ResolvedReportTarget } from '../../../moderation/reports-read';
import { ReportReviewCard } from '../../../moderation/reports-view-card';

export type { ReportQueueAction } from '../../../moderation/reports-view-action';
export type ReportQueueProps = {
  reports: Report[];
  targets: ResolvedReportTarget[];
  revisions?: ReportedRevision[];
  onAction: ReportQueueAction;
  next?: string | null;
  onNext?: (cursor: string) => void;
  state?: 'ready' | 'loading' | 'error';
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
};

/** Review composition over one native page; it never discovers or fetches report details. */
export function BoardReportQueue({
  reports,
  targets,
  revisions = [],
  onAction,
  next,
  onNext,
  state = 'ready',
  onRetry,
  onRefresh,
}: ReportQueueProps) {
  const [takenDown, setTakenDown] = useState<ReadonlySet<string>>(() => new Set());
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const revisionByReport = new Map(revisions.map((revision) => [revision.reportId, revision.value]));

  if (state === 'loading')
    return (
      <section aria-busy="true" className="space-y-4">
        <p role="status">{m.moderation_queue_loading()}</p>
        <Skeleton className="h-52 rounded-2xl" />
        <Skeleton className="h-52 rounded-2xl" />
      </section>
    );
  if (state === 'error')
    return (
      <div className="space-y-3 rounded-2xl border p-6">
        <p role="alert">{m.moderation_queue_error()}</p>
        {onRetry ? (
          <Button variant="outline" className="min-h-11" onClick={onRetry}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </div>
    );
  return (
    <section className="space-y-6" aria-label={m.moderation_reports_tab()}>
      {reports.length ? (
        <ol className="space-y-5">
          {reports.map((report) => {
            const key = `${report.target.kind}:${report.target.id}`;
            return (
              <li key={report.id}>
                <ReportReviewCard
                  report={report}
                  target={takenDown.has(key) ? undefined : targetByKey.get(key)}
                  revision={takenDown.has(key) ? null : (revisionByReport.get(report.id) ?? null)}
                  takenDown={takenDown.has(key)}
                  onAction={onAction}
                  {...(onRefresh ? { onRefresh } : {})}
                  onTakenDown={() => setTakenDown((previous) => new Set([...previous, key]))}
                />
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="space-y-2 rounded-2xl border border-dashed p-6">
          <p className="font-medium">{m.moderation_reports_empty()}</p>
          <p className="text-sm text-muted-foreground">
            {next ? m.moderation_queue_empty_next() : m.moderation_queue_end()}
          </p>
        </div>
      )}
      {next ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{m.moderation_queue_next_hint()}</p>
          <Button variant="outline" className="min-h-11" onClick={() => onNext?.(next)}>
            {m.threads_next_page()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
