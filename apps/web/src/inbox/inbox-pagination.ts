import {
  DEFAULT_INBOX_SELECTION,
  type InboxPage,
  type InboxSelection,
  type ResolvedInboxPage,
} from './inbox-read';

/** Local to the mounted viewer owner; cursors are native opaque values bound to one selection. */
export type InboxPagination = {
  selection: InboxSelection;
  cursor: string | undefined;
  earlier: ResolvedInboxPage | null;
  current: ResolvedInboxPage | null;
  result: InboxPage | undefined;
};

export const emptyInboxPagination: InboxPagination = {
  selection: DEFAULT_INBOX_SELECTION,
  cursor: undefined,
  earlier: null,
  current: null,
  result: undefined,
};

export function inboxPaginationFor(selection: InboxSelection): InboxPagination {
  return selection === DEFAULT_INBOX_SELECTION ? emptyInboxPagination : { ...emptyInboxPagination, selection };
}

/** Native order, one row per notice id; a later duplicate replaces earlier details in that first slot. */
export function distinctInboxNotices<T extends { id: string }>(items: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const item of items) latest.set(item.id, item);
  const order: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    order.push(latest.get(item.id)!);
  }
  return order;
}

/** A confirmed item action changes only that notice in the retained page window. */
export function confirmInboxNoticeSeen(state: InboxPagination, noticeId: string): InboxPagination {
  const mark = (page: ResolvedInboxPage | null) => {
    if (!page || !page.items.some((item) => item.id === noticeId && item.unread)) return page;
    return {
      ...page,
      items: page.items.map((item) => (item.id === noticeId ? { ...item, unread: false } : item)),
    };
  };
  const current = mark(state.current);
  const earlier = mark(state.earlier);
  return current === state.current && earlier === state.earlier ? state : { ...state, current, earlier };
}

export const inboxTransportFailure: InboxPage = {
  signedIn: true,
  state: 'unavailable',
  failure: { status: null },
};

function transient(result: InboxPage): boolean {
  if (!result.signedIn || result.state === 'ready' || result.state === 'closed') return false;
  const { status, retryable, code } = result.failure;
  if (code === 'platform_closed' || code === 'unauthorized' || code === 'forbidden' || code === 'not_found')
    return false;
  return retryable !== false && (status === null || status === 408 || status === 429 || status >= 500);
}

/** Consume every refreshed response, including native privacy failures, before rendering. */
export function receiveInboxPage(
  state: InboxPagination,
  data: InboxPage | undefined,
  transportFailed = false,
): InboxPagination {
  // A failed refetch can retain query data; a known native denial still takes precedence.
  const result = transportFailed && (!data || (data.signedIn && data.state === 'ready')) ? inboxTransportFailure : data;
  if (state.result === result) return state;
  if (result?.signedIn && result.state === 'ready') {
    if (result.selection !== state.selection) return state;
    const items = distinctInboxNotices(result.items);
    const current = {
      items,
      next: result.next,
      viewer: result.viewer,
      selection: result.selection,
      actions: result.actions,
    };
    // The last successful page replaces the prior window so retained rows stay bounded by 20.
    return { ...state, earlier: null, current, result: { ...result, items } };
  }
  if (result && !transient(result)) return { ...state, earlier: null, current: null, result };
  return { ...state, result };
}

/** Keep native order and distinct notices, but let a fresh identical ID replace all cached details. */
export function readableInboxPage(state: InboxPagination): ResolvedInboxPage | null {
  return state.current ?? state.earlier;
}

/** Confirm only notices held by the deliberate attempt; a fresh current read always wins. */
export function confirmLoadedInboxSeen(state: InboxPagination, loaded: ReadonlySet<string>): InboxPagination {
  const fresh = state.result?.signedIn && state.result.state === 'ready' ? state.current : null;
  const authoritative = new Set(fresh?.items.map((item) => item.id));
  const reconcile = (page: ResolvedInboxPage | null) => {
    if (!page || page === fresh) return page;
    return {
      ...page,
      items: page.items.map((item) =>
        item.unread && loaded.has(item.id) && !authoritative.has(item.id) ? { ...item, unread: false } : item,
      ),
    };
  };
  // Never restore rows removed by a denial or a first-page restart.
  return { ...state, earlier: reconcile(state.earlier), current: reconcile(state.current) };
}

/** Advance only after a successful page; an empty page can still have a continuation. */
export function nextInboxPage(state: InboxPagination): InboxPagination {
  if (!state.result?.signedIn || state.result.state !== 'ready') return state;
  const page = readableInboxPage(state);
  if (!page?.next || page.next === state.cursor) return state;
  return { ...state, cursor: page.next, earlier: page, current: null, result: undefined };
}

/** A continuation can be retired by a deliberate first-page refresh after success or failure. */
export function restartInboxPage(state: InboxPagination): InboxPagination {
  if (state.cursor === undefined || !state.result?.signedIn) return state;
  return inboxPaginationFor(state.selection);
}

/** Changing All/Unread always restarts without a cursor. */
export function selectInboxPage(state: InboxPagination, selection: InboxSelection): InboxPagination {
  return state.selection === selection ? state : inboxPaginationFor(selection);
}
