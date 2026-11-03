import {
  reportSelection,
  type PrivateReportPage,
  type Report,
  type ReportReadInput,
  type ReportReadState,
  type ReportTargetValue,
  type ReportedRevision,
  type ResolvedReportTarget,
} from '../reports-read';

export type WorkbenchCaseSearch = {
  boardId: string;
  thread?: string;
  post?: string;
  cursor?: string;
  status: 'all' | 'pending' | 'resolved';
  targetKind: 'all' | 'board' | 'thread' | 'post';
  order: 'newest' | 'oldest';
};

export function parseWorkbenchCaseSearch(input: Record<string, unknown>): WorkbenchCaseSearch | null {
  if (typeof input.boardId !== 'string' || !input.boardId || input.boardId.length > 128) return null;
  if (input.thread !== undefined && (typeof input.thread !== 'string' || input.thread.length > 128)) return null;
  if (input.post !== undefined && (typeof input.post !== 'string' || input.post.length > 128)) return null;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096)) return null;
  const selection = reportSelection(input);
  for (const key of ['status', 'targetKind', 'order'] as const)
    if (input[key] !== undefined && input[key] !== selection[key]) return null;
  return {
    boardId: input.boardId,
    ...selection,
    ...(typeof input.thread === 'string' && input.thread ? { thread: input.thread } : {}),
    ...(typeof input.post === 'string' && input.post ? { post: input.post } : {}),
    ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
  };
}

export function workbenchCaseInput(search: WorkbenchCaseSearch): ReportReadInput {
  return {
    boardId: search.boardId,
    ...reportSelection(search),
    ...(search.thread ? { threadId: search.thread } : {}),
    ...(search.post ? { postId: search.post } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
  };
}

function queueParams(input: ReportReadInput): URLSearchParams {
  const selection = reportSelection(input);
  const params = new URLSearchParams({
    status: selection.status,
    targetKind: selection.targetKind,
    order: selection.order,
  });
  if (input.threadId) params.set('thread', input.threadId);
  if (input.postId) params.set('post', input.postId);
  if (input.cursor) params.set('cursor', input.cursor);
  return params;
}

/** Stable case reference: the native report ID plus the exact scoped queue read that found it. */
export function workbenchCaseHref(reportId: string, input: ReportReadInput): string {
  const params = queueParams(input);
  params.set('boardId', input.boardId);
  return `/moderation/cases/${encodeURIComponent(reportId)}?${params}`;
}

/** Reconstruct the original report queue, including target scope, cursor, filters and order. */
export function workbenchCaseQueueHref(input: ReportReadInput): string {
  return `/boards/${encodeURIComponent(input.boardId)}/moderation?${queueParams(input)}`;
}

export type WorkbenchCaseResult =
  | { state: 'ready'; report: Report; target: ResolvedReportTarget | undefined; revision: ReportTargetValue | null }
  | { state: 'empty' | 'unavailable' }
  | { state: Exclude<ReportReadState, 'ready'> };

type CaseRead = Pick<PrivateReportPage, 'state' | 'reports' | 'targets' | 'revisions'> & {
  reports: readonly Report[];
  targets: readonly ResolvedReportTarget[];
  revisions: readonly ReportedRevision[];
};

/** Selects only an exact report present on the referenced native page. */
export function workbenchCaseFromPage(page: CaseRead, reportId: string): WorkbenchCaseResult {
  if (page.state !== 'ready') return { state: page.state };
  if (page.reports.length === 0) return { state: 'empty' };
  const report = page.reports.find((entry) => entry.id === reportId);
  if (!report) return { state: 'unavailable' };
  const kind: string = (report.target as { kind: string }).kind;
  if (!['board', 'thread', 'post'].includes(kind)) return { state: 'unavailable' };
  const key = `${kind}:${report.target.id}`;
  const target = page.targets.find((entry) => entry.key === key && entry.kind === kind);
  const revision = page.revisions.find((entry) => entry.reportId === report.id)?.value ?? null;
  return { state: 'ready', report, target, revision };
}
