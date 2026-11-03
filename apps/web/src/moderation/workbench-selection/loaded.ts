import type { Report } from '../reports-read';
import { workbenchScope, type WorkbenchSearch } from '../workbench-queue/scope';

/** Pending board reports actually loaded on this page. Never catalogue, appeals, resolved cases or later pages. */
export function workbenchLoadedReports(reports: readonly Report[], search: WorkbenchSearch): Report[] {
  if (workbenchScope(search).kind !== 'board' || search.queue !== 'reports') return [];
  return reports.filter((report) => !report.outcome).slice(0, 20);
}
