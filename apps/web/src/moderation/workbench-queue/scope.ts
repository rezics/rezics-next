import { reportSelection, type ReportSelection } from '../reports-read';

export const WORKBENCH_PAGE_SIZE = 20;
export type WorkbenchQueueKind = 'reports' | 'appeals' | 'resolved';
export type WorkbenchSearch = ReportSelection & {
  queue: WorkbenchQueueKind;
  scope?: 'catalogue';
  realm?: string;
  board?: string;
  cursor?: string;
  realmsCursor?: string;
  boardsCursor?: string;
};
export type WorkbenchScope =
  | { kind: 'none' }
  | { kind: 'realm'; realmId: string }
  | { kind: 'board'; realmId?: string; boardId: string }
  | { kind: 'catalogue' };

function token(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** One current queue identity. Catalogue never borrows a board or Realm selector. */
export function workbenchSearch(search: Record<string, unknown>): WorkbenchSearch {
  const selection = reportSelection(search);
  const queue: WorkbenchQueueKind =
    search.queue === 'appeals' || search.queue === 'resolved' ? search.queue : 'reports';
  if (search.scope === 'catalogue') {
    return {
      queue,
      status: queue === 'resolved' ? 'resolved' : 'pending',
      targetKind: 'all',
      order: selection.order,
      scope: 'catalogue',
      ...(token(search.cursor, 4096) ? { cursor: token(search.cursor, 4096) } : {}),
    };
  }
  return {
    queue,
    status: queue === 'resolved' ? 'resolved' : queue === 'reports' ? 'pending' : selection.status,
    targetKind: selection.targetKind,
    order: selection.order,
    ...(token(search.realm, 128) ? { realm: token(search.realm, 128) } : {}),
    ...(token(search.board, 128) ? { board: token(search.board, 128) } : {}),
    ...(token(search.cursor, 4096) ? { cursor: token(search.cursor, 4096) } : {}),
    ...(token(search.realmsCursor, 4096) ? { realmsCursor: token(search.realmsCursor, 4096) } : {}),
    ...(token(search.boardsCursor, 4096) ? { boardsCursor: token(search.boardsCursor, 4096) } : {}),
  };
}

export function workbenchScope(search: WorkbenchSearch): WorkbenchScope {
  if (search.scope === 'catalogue') return { kind: 'catalogue' };
  if (search.board) return { kind: 'board', boardId: search.board, ...(search.realm ? { realmId: search.realm } : {}) };
  if (search.realm) return { kind: 'realm', realmId: search.realm };
  return { kind: 'none' };
}

export function workbenchReadKey(search: WorkbenchSearch): string {
  const scope = workbenchScope(search);
  const realmId = scope.kind === 'realm' ? scope.realmId : scope.kind === 'board' ? (scope.realmId ?? '') : '';
  return JSON.stringify([
    scope.kind,
    scope.kind === 'board' ? scope.boardId : '',
    realmId,
    search.queue,
    search.status,
    search.targetKind,
    search.order,
    search.cursor ?? '',
    search.realmsCursor ?? '',
    search.boardsCursor ?? '',
  ]);
}

export function workbenchCaseHref(
  scope: Extract<WorkbenchScope, { kind: 'board' | 'catalogue' }>,
  kind: 'report' | 'appeal',
): string {
  if (scope.kind === 'catalogue') return '/moderation/catalogue';
  return kind === 'appeal'
    ? `/boards/${encodeURIComponent(scope.boardId)}/moderation?tab=appeals`
    : `/boards/${encodeURIComponent(scope.boardId)}/moderation`;
}
