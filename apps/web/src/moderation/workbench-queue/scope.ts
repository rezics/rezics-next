import { workbenchCaseHref as reportCaseHref } from '../workbench-case/read-model';
import { reportSelection, type ReportSelection } from '../reports-read';

export const WORKBENCH_PAGE_SIZE = 20;
export type WorkbenchQueueKind = 'reports' | 'appeals' | 'resolved';
export type WorkbenchSearch = ReportSelection & {
  queue: WorkbenchQueueKind;
  history?: true;
  historyCursor?: string;
  historyReturn?: true;
  scope?: 'catalogue';
  realm?: string;
  board?: string;
  cursor?: string;
  realmsCursor?: string;
  boardsCursor?: string;
  /** Selected appeal on this exact bounded appeals page. Never a later-page scan. */
  case?: string;
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
  const cursor = token(search.cursor, 4096);
  if (search.scope === 'catalogue') {
    return {
      queue,
      status: queue === 'resolved' ? 'resolved' : 'pending',
      targetKind: 'all',
      order: selection.order,
      scope: 'catalogue',
      ...(cursor ? { cursor } : {}),
    };
  }
  const realm = token(search.realm, 128);
  const board = token(search.board, 128);
  const realmsCursor = token(search.realmsCursor, 4096);
  const boardsCursor = token(search.boardsCursor, 4096);
  const history = search.history === true && board ? true : undefined;
  const historyCursor = history ? token(search.historyCursor, 4096) : undefined;
  const historyReturn = !history && board && search.historyReturn === true ? true : undefined;
  const selected = queue === 'appeals' && board && !history ? token(search.case, 128) : undefined;
  return {
    queue,
    status: queue === 'resolved' ? 'resolved' : queue === 'reports' ? 'pending' : selection.status,
    targetKind: selection.targetKind,
    order: selection.order,
    ...(realm ? { realm } : {}),
    ...(board ? { board } : {}),
    ...(history ? { history } : {}),
    ...(historyCursor ? { historyCursor } : {}),
    ...(historyReturn ? { historyReturn } : {}),
    ...(selected ? { case: selected } : {}),
    ...(cursor ? { cursor } : {}),
    ...(realmsCursor ? { realmsCursor } : {}),
    ...(boardsCursor ? { boardsCursor } : {}),
  };
}

export function workbenchWithoutContinuation(search: WorkbenchSearch): WorkbenchSearch {
  return workbenchSearch({
    queue: search.queue,
    status: search.status,
    targetKind: search.targetKind,
    order: search.order,
    ...(search.scope ? { scope: search.scope } : {}),
    ...(search.realm ? { realm: search.realm } : {}),
    ...(search.board ? { board: search.board } : {}),
  });
}

/** Reconstruct the captured workbench queue, including filter, order and cursor. */
export function workbenchQueueHref(search: WorkbenchSearch): string {
  const params = new URLSearchParams({
    queue: search.queue,
    targetKind: search.targetKind,
    order: search.order,
  });
  if (search.scope === 'catalogue') params.set('scope', 'catalogue');
  if (search.realm) params.set('realm', search.realm);
  if (search.board) params.set('board', search.board);
  if (search.cursor) params.set('cursor', search.cursor);
  if (search.case) params.set('case', search.case);
  if (search.history) params.set('history', 'true');
  if (search.historyCursor) params.set('historyCursor', search.historyCursor);
  if (search.historyReturn) params.set('historyReturn', 'true');
  if (search.realmsCursor) params.set('realmsCursor', search.realmsCursor);
  if (search.boardsCursor) params.set('boardsCursor', search.boardsCursor);
  return `/moderation/workbench?${params}`;
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
    search.history ? 'history' : '',
    search.historyCursor ?? '',
    search.historyReturn ? 'history-return' : '',
    search.cursor ?? '',
    search.realmsCursor ?? '',
    search.boardsCursor ?? '',
  ]);
}

/** Stable native case reference with the exact scoped page snapshot that listed it. */
export function workbenchCaseHref(item: { kind: 'report' | 'appeal'; id: string }, search: WorkbenchSearch): string {
  const scope = workbenchScope(search);
  if (scope.kind === 'catalogue') return '/moderation/catalogue';
  if (scope.kind !== 'board') return '/moderation/workbench';
  if (item.kind === 'appeal') return workbenchQueueHref({ ...search, case: item.id });
  return reportCaseHref(item.id, {
    boardId: scope.boardId,
    status: search.queue === 'resolved' ? 'resolved' : 'pending',
    targetKind: search.targetKind,
    order: search.order,
    ...(search.cursor ? { cursor: search.cursor } : {}),
    ...(search.realm ? { realm: search.realm } : {}),
    queue: search.queue === 'resolved' ? 'resolved' : 'reports',
  });
}
