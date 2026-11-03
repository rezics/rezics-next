import { Button } from '@rezics/ui/shadcn/button';
import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Skeleton } from '@rezics/ui/shadcn/skeleton';
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import {
  createReportsBulkAction,
  type ReportsBulkAction,
  type BulkItem,
} from '../../../moderation/reports-bulk-action';
import {
  ReportsBulkControls,
  ReportsBulkRefreshFailure,
  reportReviewDepartureMessages,
  reportReviewNavigationContext,
} from '../../../moderation/reports-bulk-controls';
import { m } from '../../../paraglide/messages.js';
import type { ReportQueueAction } from '../../../moderation/reports-view-action';
import type { ReportReadState, Report, ReportedRevision, ResolvedReportTarget } from '../../../moderation/reports-read';
import { ReportReviewCard } from '../../../moderation/reports-view-card';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../../threads/authoring-departure';

export type { ReportQueueAction } from '../../../moderation/reports-view-action';
export type ReportQueueProps = {
  isCurrent?: () => boolean;
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
  onLeave?: () => void;
};

const emptyRevisions: ReportedRevision[] = [];
const diagnoseRender = (name: string) =>
  (globalThis as typeof globalThis & { __moderationRenderObserver?: (component: string) => void })
    .__moderationRenderObserver?.(name);

/** Injected queues keep the same decision UI without requiring a route or private reader. */
export function BoardReportQueue(props: ReportQueueProps) {
  diagnoseRender('board-report-queue');
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={reportReviewNavigationContext}>
      <ReportQueue {...props} />
    </AuthoringDepartureBoundary>
  );
}

/** Each data replacement or authority change retires all private intents, including sparse pages. */
function ReportQueue(props: ReportQueueProps) {
  diagnoseRender('report-queue');
  const generation = useRef<{
    props: ReportQueueProps;
    controller: ReportsBulkAction;
    receipt: readonly BulkItem[] | undefined;
  } | null>(null);
  const previous = generation.current;
  if (
    !previous ||
    previous.props.reports !== props.reports ||
    previous.props.targets !== props.targets ||
    previous.props.revisions !== props.revisions ||
    previous.props.isCurrent !== props.isCurrent ||
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
      controller: createReportsBulkAction(props.bulkEnabled === false ? [] : props.reports, props.isCurrent),
    };
  }
  const current = generation.current!;
  useLayoutEffect(() => {
    current.controller.attach();
    return () => current.controller.detach();
  }, [current]);
  return (
    <>
      {props.state === 'error' && current.receipt ? <ReportsBulkRefreshFailure items={current.receipt} /> : null}
      <QueueGeneration key={props.queueIdentity} {...props} controller={current.controller} />
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
  onLeave,
}: ReportQueueProps & { controller: ReportsBulkAction }) {
  diagnoseRender('queue-generation');
  const selectionId = useId();
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const { requestNavigation } = useAuthoringDeparture(
    controller.needsDecision,
    controller.unresolved,
    JSON.stringify(snapshot),
    undefined,
    () => {
      controller.leave();
      onLeave?.();
    },
    undefined,
    reportReviewDepartureMessages(),
    reportReviewNavigationContext,
  );
  const [takenDown, setTakenDown] = useState<ReadonlySet<string>>(() => new Set());
  const targetByKey = new Map(targets.map((target) => [target.key, target]));
  const revisionByReport = new Map(revisions.map((revision) => [revision.reportId, revision.value]));

  if (state === 'loading')
    return (
      <section aria-busy="true" className="space-y-4">
        <ContentItemFrame as="div" role="status" aria-live="polite" className="space-y-4 p-4 sm:p-6">
          <ContentItemHeading id={`${selectionId}-loading`} level={2} className="text-base font-semibold">
            {m.moderation_queue_loading()}
          </ContentItemHeading>
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </ContentItemFrame>
      </section>
    );
  if (state === 'denied' || state === 'stale')
    return (
      <ContentItemFrame as="div" role="alert" className="space-y-3 p-4 sm:p-6">
        <ContentItemHeading level={2} className="text-base font-semibold">
          {state === 'denied' ? m.moderation_queue_read_denied() : m.moderation_queue_stale()}
        </ContentItemHeading>
        {state === 'stale' && onRestart ? (
          <Button variant="outline" onClick={() => requestNavigation(() => onRestart?.())}>
            {m.moderation_queue_restart()}
          </Button>
        ) : null}
      </ContentItemFrame>
    );
  if (state === 'error')
    return (
      <ContentItemFrame as="div" role="alert" className="space-y-3 p-4 sm:p-6">
        <ContentItemHeading level={2} className="text-base font-semibold">
          {m.moderation_queue_error()}
        </ContentItemHeading>
        {onRetry ? (
          <Button variant="outline" className="min-h-11" onClick={() => requestNavigation(() => onRetry?.())}>
            {m.moderation_queue_retry()}
          </Button>
        ) : null}
      </ContentItemFrame>
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
        <ContentItemFrame as="div" className="space-y-2 p-4 sm:p-6">
          <ContentItemHeading level={2} className="text-base font-semibold">
            {m.moderation_reports_empty()}
          </ContentItemHeading>
          <p className="text-sm text-muted-foreground">
            {next ? m.moderation_queue_empty_next() : m.moderation_queue_end()}
          </p>
        </ContentItemFrame>
      )}
      {next && !snapshot.retired ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{m.moderation_queue_next_hint()}</p>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              if (!controller.isCurrent()) return;
              requestNavigation(() => onNext?.(next));
            }}
          >
            {m.threads_next_page()}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
