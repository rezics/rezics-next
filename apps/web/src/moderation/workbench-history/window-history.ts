import type { QueryClient } from '@tanstack/react-query';
import type { WorkbenchRead } from '../workbench-queue/read';
import { workbenchReadKey, workbenchSearch, type WorkbenchSearch } from '../workbench-queue/scope';
import {
  WorkbenchQueueWindowHistory,
  workbenchReaderFence,
  type WorkbenchWindowMove,
  type WorkbenchNavigationTarget,
} from '../workbench-queue/window-history';

// Reuse the bounded coordinate engine, with independent history operands. This
// projection never changes the actual route's queue or directory return address.
function coordinates(search: WorkbenchSearch) {
  return workbenchSearch({
    board: search.board,
    realm: search.realm,
    queue: 'reports',
    targetKind: search.historyTargetKind ?? 'all',
    cursor: search.historyCursor,
  });
}

function historyPage(page: WorkbenchRead) {
  return { ...page, state: page.history?.state ?? ('unavailable' as const), next: page.history?.next ?? null };
}

function returnAddress(search: WorkbenchSearch) {
  return workbenchReadKey(
    workbenchSearch({
      ...search,
      history: undefined,
      historyCursor: undefined,
      historyDecision: undefined,
      historyTargetKind: undefined,
      historyReturn: undefined,
    }),
  );
}

export class WorkbenchHistoryWindows {
  private readonly windows = new WorkbenchQueueWindowHistory();
  private staged = false;
  private closeRow: string | undefined;
  subscribe = this.windows.subscribe;
  snapshot = this.windows.snapshot;

  clear() {
    this.staged = false;
    this.closeRow = undefined;
    this.windows.clearForVisit(undefined);
  }

  view(visitId: string | undefined, search: WorkbenchSearch, page: WorkbenchRead) {
    return this.windows.view(visitId, coordinates(search), historyPage(page).state);
  }

  begin(
    visitId: string | undefined,
    search: WorkbenchSearch,
    page: WorkbenchRead,
    locale: string,
    move: WorkbenchWindowMove | 'retry',
    source?: HTMLElement,
    keyboard = false,
  ) {
    const input = {
      visitId,
      search: coordinates(search),
      fence: workbenchReaderFence(page, locale),
      ...(source ? { source } : {}),
      keyboard,
    };
    const previous = this.windows.previousAddress(visitId, input.search);
    const started = move === 'retry' ? this.windows.beginRetry(input) : this.windows.beginMove({ ...input, move });
    if (!started) return null;
    this.staged = true;
    this.closeRow = undefined;
    if (move === 'retry' || move === 'refresh') return search;
    return workbenchSearch({
      ...search,
      historyDecision: undefined,
      historyCursor: move === 'first' ? undefined : move === 'previous' ? (previous ?? undefined) : page.history!.next!,
    });
  }

  prepare(
    visitId: string | undefined,
    current: WorkbenchSearch,
    next: WorkbenchSearch,
    page: WorkbenchRead,
    locale: string,
  ) {
    if (this.staged) return;
    if (
      !current.history ||
      !next.history ||
      returnAddress(current) !== returnAddress(next) ||
      current.historyTargetKind !== next.historyTargetKind ||
      current.historyCursor !== next.historyCursor
    ) {
      this.clear();
      return;
    }
    // Receipt Open/Close rereads replace the current page, without pushing it.
    this.begin(visitId, current, page, locale, 'refresh');
  }

  closing(id: string) {
    this.closeRow = id;
  }

  navigate(
    visitId: string | undefined,
    target: WorkbenchNavigationTarget,
    search: WorkbenchSearch,
    page: WorkbenchRead,
  ) {
    const next = workbenchSearch(target.search);
    if (
      !search.history ||
      !next.history ||
      !target.pathname.endsWith('/moderation/workbench') ||
      returnAddress(search) !== returnAddress(next)
    ) {
      this.clear();
      return;
    }
    this.windows.navigate(visitId, { ...target, search: coordinates(next) }, coordinates(search), historyPage(page));
    this.staged = false;
  }

  admit(visitId: string | undefined, search: WorkbenchSearch, page: WorkbenchRead, locale: string, admitted: boolean) {
    if (!search.history) {
      this.clear();
      return null;
    }
    const focus = this.windows.admitQueue({
      visitId,
      search: coordinates(search),
      page: historyPage(page),
      locale,
      admitted,
    });
    this.staged = false;
    const row = this.closeRow;
    this.closeRow = undefined;
    if (!focus || page.history?.state !== 'ready') return null;
    return { row: row && page.history.entries.some((entry) => entry.id === row) ? row : undefined };
  }
}

const histories = new WeakMap<QueryClient, WorkbenchHistoryWindows>();
export function workbenchHistoryWindows(client: QueryClient) {
  let history = histories.get(client);
  if (!history) {
    history = new WorkbenchHistoryWindows();
    histories.set(client, history);
  }
  return history;
}
