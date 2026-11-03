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
  realm?: string;
  queue?: 'reports' | 'resolved';
};

export function parseWorkbenchCaseSearch(input: Record<string, unknown>): WorkbenchCaseSearch | null {
  if (typeof input.boardId !== 'string' || !input.boardId || input.boardId.length > 128) return null;
  if (input.thread !== undefined && (typeof input.thread !== 'string' || input.thread.length > 128)) return null;
  if (input.post !== undefined && (typeof input.post !== 'string' || input.post.length > 128)) return null;
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096)) return null;
  if (input.realm !== undefined && (typeof input.realm !== 'string' || input.realm.length > 128)) return null;
  if (input.queue !== undefined && input.queue !== 'reports' && input.queue !== 'resolved') return null;
  const selection = reportSelection(input);
  for (const key of ['status', 'targetKind', 'order'] as const)
    if (input[key] !== undefined && input[key] !== selection[key]) return null;
  const queue = input.queue === 'resolved' || input.queue === 'reports' ? input.queue : undefined;
  if (queue === 'resolved' && selection.status !== 'resolved') return null;
  if (queue === 'reports' && selection.status === 'resolved') return null;
  return {
    boardId: input.boardId,
    ...selection,
    ...(typeof input.thread === 'string' && input.thread ? { thread: input.thread } : {}),
    ...(typeof input.post === 'string' && input.post ? { post: input.post } : {}),
    ...(typeof input.cursor === 'string' && input.cursor ? { cursor: input.cursor } : {}),
    ...(typeof input.realm === 'string' && input.realm ? { realm: input.realm } : {}),
    ...(queue ? { queue } : {}),
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

function caseParams(search: WorkbenchCaseSearch): URLSearchParams {
  const selection = reportSelection(search);
  const params = new URLSearchParams({
    status: selection.status,
    targetKind: selection.targetKind,
    order: selection.order,
    boardId: search.boardId,
    queue: search.queue ?? (selection.status === 'resolved' ? 'resolved' : 'reports'),
  });
  if (search.thread) params.set('thread', search.thread);
  if (search.post) params.set('post', search.post);
  if (search.cursor) params.set('cursor', search.cursor);
  if (search.realm) params.set('realm', search.realm);
  return params;
}

function asCaseSearch(input: WorkbenchCaseSearch | ReportReadInput): WorkbenchCaseSearch {
  if ('threadId' in input || 'postId' in input) {
    const selection = reportSelection(input);
    return {
      boardId: input.boardId,
      ...selection,
      ...(input.threadId ? { thread: input.threadId } : {}),
      ...(input.postId ? { post: input.postId } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...('realm' in input && typeof input.realm === 'string' && input.realm ? { realm: input.realm } : {}),
      queue:
        'queue' in input && (input.queue === 'reports' || input.queue === 'resolved')
          ? input.queue
          : selection.status === 'resolved'
            ? 'resolved'
            : 'reports',
    };
  }
  return input;
}

/** Stable case reference: the native report ID plus the exact scoped queue read that found it. */
export function workbenchCaseHref(reportId: string, input: WorkbenchCaseSearch | ReportReadInput): string {
  return `/moderation/cases/${encodeURIComponent(reportId)}?${caseParams(asCaseSearch(input))}`;
}

/** Reconstruct the captured workbench queue, including board, filter, order and cursor. */
export function workbenchCaseQueueHref(input: WorkbenchCaseSearch | ReportReadInput): string {
  const search = asCaseSearch(input);
  const params = new URLSearchParams({
    queue: search.queue ?? (search.status === 'resolved' ? 'resolved' : 'reports'),
    board: search.boardId,
    targetKind: search.targetKind,
    order: search.order,
  });
  if (search.realm) params.set('realm', search.realm);
  if (search.cursor) params.set('cursor', search.cursor);
  return `/moderation/workbench?${params}`;
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
