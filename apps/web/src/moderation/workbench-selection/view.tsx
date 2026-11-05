import { useId, useSyncExternalStore, type ReactNode } from 'react';
import { Checkbox } from '@rezics/ui/shadcn/checkbox';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { createReportsBulkAction, type ReportsBulkAction, type BulkItem } from '../reports-bulk-action';
import {
  ReportsBulkControls,
  ReportsBulkRefreshFailure,
  reportReviewDepartureMessages,
  reportReviewNavigationContext,
} from '../reports-bulk-controls';
import type { ReportQueueAction } from '../reports-view-action';
import type { Report } from '../reports-read';
import { m } from '../../paraglide/messages.js';
import { AuthoringDepartureBoundary, useAuthoringDeparture } from '../../threads/authoring-departure';
import { workbenchLoadedReports } from './loaded';
import type { WorkbenchSearch } from '../workbench-queue/scope';

export function createWorkbenchSelection(
  reports: readonly Report[],
  search: WorkbenchSearch,
  isCurrent: () => boolean,
): ReportsBulkAction {
  return createReportsBulkAction(workbenchLoadedReports(reports, search), isCurrent);
}

export function WorkbenchSelection({
  controller,
  boardId,
  reports,
  onAction,
  onRefresh,
  onLeave,
}: {
  controller: ReportsBulkAction;
  boardId: string;
  reports: readonly Report[];
  onAction: ReportQueueAction;
  onRefresh?: () => Promise<void>;
  onLeave?: () => void;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useAuthoringDeparture(
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
  if (snapshot.retired && !snapshot.items.length) return null;
  const eligible = reports.some((report) => !report.outcome);
  if (!eligible && !snapshot.items.length) return null;
  return (
    <div className="space-y-3">
      {snapshot.phase === 'review' ? (
        <p role="status" className="text-sm leading-relaxed [overflow-wrap:anywhere]">
          {m.moderation_workbench_selection_identity({
            board: boardId,
            reports: snapshot.selected.join(', '),
          })}
        </p>
      ) : null}
      <ReportsBulkControls
        controller={controller}
        snapshot={snapshot}
        onAction={onAction}
        {...(onRefresh ? { onRefresh } : {})}
      />
    </div>
  );
}

export function WorkbenchSelectionRefreshFailure({ items }: { items: readonly BulkItem[] }) {
  return <ReportsBulkRefreshFailure items={items} />;
}

export function WorkbenchReportSelect({
  controller,
  reportId,
  number,
}: {
  controller: ReportsBulkAction;
  reportId: string;
  number: number;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const id = useId();
  const selectable = controller.selectable(reportId);
  if (!selectable && !snapshot.selected.includes(reportId)) return null;
  return (
    <Field orientation="horizontal" data-disabled={!selectable}>
      <Checkbox
        id={id}
        checked={snapshot.selected.includes(reportId)}
        disabled={!selectable}
        onCheckedChange={() => controller.toggle(reportId)}
      />
      <FieldLabel htmlFor={id} className="min-h-11">
        {m.moderation_bulk_select_report({ number })}
      </FieldLabel>
    </Field>
  );
}

export function WorkbenchSelectionBoundary({ children }: { children: ReactNode }) {
  return (
    <AuthoringDepartureBoundary sessionBound={false} navigationContext={reportReviewNavigationContext}>
      {children}
    </AuthoringDepartureBoundary>
  );
}
