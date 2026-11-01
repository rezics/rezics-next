import { Button } from '@rezics/ui/shadcn/button';
import { Skeleton } from '@rezics/ui/shadcn/skeleton';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  createReportsBulkAction,
  type ReportsBulkAction,
  type BulkItem,
} from '../../../moderation/reports-bulk-action';
import { ReportsBulkControls, ReportsBulkRefreshFailure } from '../../../moderation/reports-bulk-controls';
import { m } from '../../../paraglide/messages.js';
import type { ReportQueueAction } from '../../../moderation/reports-view-action';
import type { ReportReadState, Report, ReportedRevision, ResolvedReportTarget } from '../../../moderation/reports-read';
import { ReportReviewCard } from '../../../moderation/reports-view-card';

export type { ReportQueueAction } from '../../../moderation/reports-view-action';
export type ReportQueueProps = {
  queueIdentity?: string;
  bulkEnabled?: boolean;
  reports: Report[];
  targets: ResolvedReportTarget[];
  revisions?: ReportedRevision[];
  onAction: ReportQueueAction;
  next?: string | null;
  onNext?: (cursor: string) => void;
  state?: ReportReadState;
  onRestart?: () => void;
  onRetry?: () => void;
  onRefresh?: () => Promise<void>;
};

const emptyRevisions: ReportedRevision[] = [];

/** Each data replacement or authority change retires all private intents, including sparse pages. */
export function BoardReportQueue(props: ReportQueueProps) {
  const generation = useRef<{
    props: ReportQueueProps;
    controller: ReportsBulkAction;
    number: number;
    receipt: readonly BulkItem[] | undefined;
  } | null>(null);
  const previous = generation.current;
  if (
    !previous ||
    previous.props.reports !== props.reports ||
    previous.props.queueIdentity !== props.queueIdentity ||
    previous.props.bulkEnabled !== props.bulkEnabled ||
    previous.props.state !== props.state ||
    previous.props.next !== props.next
  ) {
    const old = previous?.controller.getSnapshot();
    const receipt =
      previous?.props.queueIdentity === props.queueIdentity && (props.state === 'error' || props.state === 'loading')
        ? old?.hideCards && old.items.some((item) => item.state === 'dismissed')
          ? old.items
          : previous?.receipt
        : undefined;
    previous?.controller.retire();
    generation.current = {
      receipt,
      props,
      controller: createReportsBulkAction(props.bulkEnabled === false ? [] : props.reports),
      number: (previous?.number ?? 0) + 1,
    };
  }
  const current = generation.current!;
  useLayoutEffect(() => {
    current.controller.attach();
    return () => current.controller.retire();
  }, [current]);
  return (
    <>
      {props.state === 'error' && current.receipt ? <ReportsBulkRefreshFailure items={current.receipt} /> : null}
      <QueueGeneration key={current.number} {...props} controller={current.controller} />
    </>
  );
}

/** Review composition over one native page; it never discovers or fetches report details. */
function QueueGeneration({
  reports,
  targets,
  revisions = emptyRevisions,
  onAction,
  next,
  onNext,
  state = 'ready',
  onRetry,
  onRefresh,
  onRestart,
  controller,
  bulkEnabled = true,
}: ReportQueueProps & { controller: ReportsBulkAction }) {
  const selectionId = useId();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
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
  if (state === 'denied' || state === 'stale')
    return (
      <div className="space-y-3 rounded-2xl border p-6">
        <p role="alert">{state === 'denied' ? m.moderation_queue_read_denied() : m.moderation_queue_stale()}</p>
        {state === 'stale' && onRestart ? (
          <Button variant="outline" onClick={onRestart}>
            {m.moderation_queue_restart()}
          </Button>
        ) : null}
      </div>
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
      {(bulkEnabled && !snapshot.retired && reports.some((report) => !report.outcome)) || snapshot.items.length ? (
        <ReportsBulkControls
          controller={controller}
          snapshot={snapshot}
          onAction={onAction}
          {...(onRefresh ? { onRefresh } : {})}
        />
      ) : null}
      {snapshot.hideCards ? null : reports.length ? (
        <ol className="space-y-5">
          {reports.map((report, index) => {
            const key = `${report.target.kind}:${report.target.id}`;
            return (
              <li key={report.id} className="flex flex-col gap-2">
                {bulkEnabled && !report.outcome && index < 20 ? (
                  <Field orientation="horizontal" data-disabled={!controller.selectable(report.id)}>
                    <Checkbox
                      id={`${selectionId}-${index}`}
                      checked={snapshot.selected.includes(report.id)}
                      disabled={!controller.selectable(report.id)}
                      onCheckedChange={() => controller.toggle(report.id)}
                    />
                    <FieldLabel htmlFor={`${selectionId}-${index}`} className="min-h-11">
                      {m.moderation_bulk_select_report({ number: index + 1 })}
                    </FieldLabel>
                  </Field>
                ) : null}
                <ReportReviewCard
                  report={report}
                  target={takenDown.has(key) ? undefined : targetByKey.get(key)}
                  revision={takenDown.has(key) ? null : (revisionByReport.get(report.id) ?? null)}
                  takenDown={takenDown.has(key)}
                  onAction={onAction}
                  intentOwner={controller}
                  bulkBlocked={controller.individualBlocked(report.id)}
                  {...(onRefresh ? { onRefresh: () => controller.read(onRefresh) } : {})}
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
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              controller.leave();
              onNext?.(next);
            }}
          >
            {m.threads_next_page()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
