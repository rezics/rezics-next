import { appealTarget, type Appeal } from '../appeals-read';
import type { ResolvedReportTarget } from '../reports-read';
import type { WorkbenchReadState } from '../workbench-queue/read';

export type WorkbenchAppealPage = {
  state: WorkbenchReadState;
  appeals: readonly Appeal[];
  selectedAppeal?: Appeal;
  selectedTarget?: ResolvedReportTarget | null;
};

export type WorkbenchAppealResult =
  | { state: 'ready'; appeal: Appeal; target: ResolvedReportTarget | undefined }
  | { state: 'empty' | 'unavailable' }
  | { state: Exclude<WorkbenchReadState, 'ready'> };

/** Only the exact inspection can select an appeal. Pending rows never substitute for inspection. */
export function workbenchAppealFromPage(page: WorkbenchAppealPage, appealId: string): WorkbenchAppealResult {
  if (page.state !== 'ready') return { state: page.state };
  const appeal = page.selectedAppeal;
  if (!appeal || appeal.id !== appealId) return { state: 'unavailable' };
  const identity = appealTarget(appeal);
  const selected = page.selectedTarget;
  const target =
    identity && selected && selected.key === `${identity.kind}:${identity.id}` && selected.kind === identity.kind
      ? selected
      : undefined;
  return { state: 'ready', appeal, target };
}
