import { DEFAULT_INBOX_SELECTION, type InboxPage, type InboxSelection, type ResolvedInboxPage } from './inbox-read';

/** Local to the mounted viewer owner; cursors are native opaque values bound to one selection. */
export type InboxPagination = {
  selection: InboxSelection;
  /** The mounted viewer episode owns all addresses in this stack. */
  episode: number;
  /** Distinguishes fresh admissions of the same opaque address inside one mounted episode. */
  readId: number;
  cursor: string | undefined;
  history: readonly InboxPageAddress[];
  earlier: ResolvedInboxPage | null;
  current: ResolvedInboxPage | null;
  result: InboxPage | undefined;
  direction: 'next' | 'previous' | null;
};

export type InboxPageAddress = Readonly<{
  selection: InboxSelection;
  cursor: string | undefined;
  episode: number;
}>;

export const MAX_INBOX_PRIOR_ADDRESSES = 8;
export const MAX_INBOX_CURSOR_LENGTH = 4096;

export const emptyInboxPagination: InboxPagination = {
  selection: DEFAULT_INBOX_SELECTION,
  episode: 0,
  readId: 0,
  cursor: undefined,
  history: [],
  earlier: null,
  current: null,
  result: undefined,
  direction: null,
};

export function inboxPaginationFor(
  selection: InboxSelection,
  episode = 0,
  readId = 0,
  cursor?: string,
): InboxPagination {
  return {
    ...emptyInboxPagination,
    selection,
    episode,
    readId,
    ...(cursor !== undefined ? { cursor } : {}),
  };
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

export function transientInboxPageFailure(result: InboxPage): boolean {
  return transient(result);
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
    // Keep the query data identity so a later render of the same page is a no-op.
    return { ...state, earlier: null, current, result, direction: null };
  }
  if (result && !transient(result))
    return { ...state, history: [], earlier: null, current: null, result, direction: null };
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
  const address = Object.freeze({ selection: state.selection, cursor: state.cursor, episode: state.episode });
  const history = [...state.history, address].slice(-MAX_INBOX_PRIOR_ADDRESSES);
  return {
    ...state,
    readId: state.readId + 1,
    cursor: page.next,
    history,
    earlier: page,
    current: null,
    result: undefined,
    direction: 'next',
  };
}

/** Re-admit the preceding exact address; no prior page body is retained as a replacement. */
export function previousInboxPage(state: InboxPagination): InboxPagination {
  if (!state.result?.signedIn || state.result.state !== 'ready' || state.history.length === 0) return state;
  const address = state.history[state.history.length - 1];
  const page = readableInboxPage(state);
  if (
    !address ||
    !page ||
    address.selection !== state.selection ||
    address.episode !== state.episode ||
    address.cursor === state.cursor
  )
    return state;
  return {
    ...state,
    readId: state.readId + 1,
    cursor: address.cursor,
    history: state.history.slice(0, -1),
    earlier: page,
    current: null,
    result: undefined,
    direction: 'previous',
  };
}

/** A continuation can be retired by a deliberate first-page refresh after success or failure. */
export function restartInboxPage(state: InboxPagination, forceRead = false): InboxPagination {
  if (!state.result?.signedIn || (state.cursor === undefined && state.history.length === 0 && !forceRead)) return state;
  return inboxPaginationFor(state.selection, state.episode, state.readId + 1);
}

/** Changing All/Unread always restarts without a cursor. */
export function selectInboxPage(state: InboxPagination, selection: InboxSelection): InboxPagination {
  return state.selection === selection ? state : inboxPaginationFor(selection, state.episode, state.readId + 1);
}
