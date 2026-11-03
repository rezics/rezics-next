import { workbenchScope, workbenchSearch, type WorkbenchSearch } from '../workbench-queue/scope';

/** Open the board-only history view while keeping the queue's return position intact. */
export function openWorkbenchHistory(search: WorkbenchSearch): WorkbenchSearch {
  if (workbenchScope(search).kind !== 'board') return search;
  return workbenchSearch({ ...search, history: true, historyCursor: undefined, historyReturn: undefined });
}

/** Return to the same queue page and announce where keyboard focus should land. */
export function returnFromWorkbenchHistory(search: WorkbenchSearch): WorkbenchSearch {
  return workbenchSearch({ ...search, history: undefined, historyCursor: undefined, historyReturn: true });
}
