import { appealTarget, type Appeal } from '../appeals-read';
import type { ResolvedReportTarget } from '../reports-read';
import type { WorkbenchReadState } from '../workbench-queue/read';

export type WorkbenchAppealPage = {
  state: WorkbenchReadState;
  appeals: readonly Appeal[];
  selectedTarget?: ResolvedReportTarget | null;
};

export type WorkbenchAppealResult =
  | { state: 'ready'; appeal: Appeal; target: ResolvedReportTarget | undefined }
  | { state: 'empty' | 'unavailable' }
  | { state: Exclude<WorkbenchReadState, 'ready'> };

/** Selects only an exact appeal present on the referenced native page. Never scans a later page. */
export function workbenchAppealFromPage(page: WorkbenchAppealPage, appealId: string): WorkbenchAppealResult {
  if (page.state !== 'ready') return { state: page.state };
  if (page.appeals.length === 0) return { state: 'empty' };
  const appeal = page.appeals.find((entry) => entry.id === appealId);
  if (!appeal) return { state: 'unavailable' };
  const identity = appealTarget(appeal);
  const selected = page.selectedTarget;
  const target =
    identity && selected && selected.key === `${identity.kind}:${identity.id}` && selected.kind === identity.kind
      ? selected
      : undefined;
  return { state: 'ready', appeal, target };
}
