import type { Appeal } from '../appeals-read';
import type { WorkbenchReadState } from '../workbench-queue/read';

export type WorkbenchAppealPage = {
  state: WorkbenchReadState;
  appeals: readonly Appeal[];
  selectedAppeal?: Appeal;
};

export type WorkbenchAppealResult =
  | { state: 'ready'; appeal: Appeal }
  | { state: 'empty' | 'unavailable' }
  | { state: Exclude<WorkbenchReadState, 'ready'> };

/** Only the exact inspection can select an appeal. Pending rows never substitute for inspection. */
export function workbenchAppealFromPage(page: WorkbenchAppealPage, appealId: string): WorkbenchAppealResult {
  if (page.state !== 'ready') return { state: page.state };
  const appeal = page.selectedAppeal;
  if (!appeal || appeal.id !== appealId) return { state: 'unavailable' };
  return { state: 'ready', appeal };
}
