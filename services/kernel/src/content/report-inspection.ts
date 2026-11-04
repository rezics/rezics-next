import type { Anchored, ReportId } from './model.ts';
import {
  readModerationReportReference,
  readReportActionAdvice,
  readReportTargetInspection,
  type ReportDependencies,
  type ReportReadContext,
  type ReportTargetInspection,
  type ReportView,
} from './reports.ts';

export type ReportInspection = Readonly<{
  reportedRevision: ReportTargetInspection;
  currentTarget: ReportTargetInspection;
  viewer: Readonly<{ canDismiss: boolean; canTakeDown: boolean }>;
}>;

export type InspectedReport = Readonly<{ report: ReportView; inspection: ReportInspection }>;

function sameSource(left: ReportView, right: ReportView): boolean {
  return (
    left.id === right.id &&
    left.transactionId === right.transactionId &&
    left.target.kind === right.target.kind &&
    left.target.id === right.target.id &&
    left.revisionId === right.revisionId &&
    left.reporterId === right.reporterId &&
    left.createdAt === right.createdAt &&
    left.outcome === right.outcome &&
    left.resolvedAt === right.resolvedAt
  );
}

/** One bounded exact report read with independently observed evidence, target
 * context and current command advice. None of the advice authorizes a writer. */
export async function readReportInspection(
  dependencies: ReportDependencies,
  reportId: ReportId,
  context: ReportReadContext,
): Promise<Anchored<InspectedReport | null>> {
  const selected = await readModerationReportReference(dependencies, reportId, context);
  if (!selected.value) return { ...selected, value: null };
  const target = await readReportTargetInspection(dependencies, selected.value, context);
  const advice = await readReportActionAdvice(dependencies, selected.value, target.current, context);
  const final = await readModerationReportReference(dependencies, reportId, context);
  if (!final.value || !sameSource(selected.value, final.value)) return { ...final, value: null };
  return {
    ...final,
    value: {
      report: final.value,
      inspection: {
        reportedRevision: target.reportedRevision,
        currentTarget: target.current,
        viewer: { canDismiss: advice.dismiss, canTakeDown: advice.takeDown },
      },
    },
  };
}
