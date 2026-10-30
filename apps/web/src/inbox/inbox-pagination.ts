import type { InboxPage, ResolvedInboxPage } from './inbox-read';

/** Local to the mounted viewer owner; cursors are native opaque values. */
export type InboxPagination = {
  cursor: string | undefined;
  earlier: ResolvedInboxPage | null;
  current: ResolvedInboxPage | null;
  result: InboxPage | undefined;
};

export const emptyInboxPagination: InboxPagination = {
  cursor: undefined,
  earlier: null,
  current: null,
  result: undefined,
};

export const inboxTransportFailure: InboxPage = {
  signedIn: true,
  state: 'unavailable',
  failure: { status: null },
};

function transient(result: InboxPage): boolean {
  if (!result.signedIn || result.state === 'ready' || result.state === 'closed') return false;
  const { status, retryable, code } = result.failure;
  if (code === 'platform_closed' || code === 'unauthorized' || code === 'forbidden' || code === 'not_found') return false;
  return retryable !== false && (status === null || status === 408 || status === 429 || status >= 500);
}

/** Consume every refreshed response, including native privacy failures, before rendering. */
export function receiveInboxPage(state: InboxPagination, result: InboxPage | undefined): InboxPagination {
  if (state.result === result) return state;
  if (result?.signedIn && result.state === 'ready') {
    const refreshed = new Map(result.items.map((item) => [item.id, item]));
    const earlier = state.earlier
      ? { ...state.earlier, items: state.earlier.items.map((item) => refreshed.get(item.id) ?? item) }
      : null;
    return { ...state, earlier, current: result, result };
  }
  if (result && !transient(result)) return { ...state, earlier: null, current: null, result };
  return { ...state, result };
}

/** Keep native order and distinct notices, but let a fresh identical ID replace all cached details. */
export function readableInboxPage(state: InboxPagination): ResolvedInboxPage | null {
  if (!state.current) return state.earlier;
  const items = new Map<string, ResolvedInboxPage['items'][number]>();
  for (const item of state.earlier?.items ?? []) items.set(item.id, item);
  for (const item of state.current.items) items.set(item.id, item);
  return { items: [...items.values()], next: state.current.next };
}

/** Advance only after a successful page; an empty page can still have a continuation. */
export function nextInboxPage(state: InboxPagination): InboxPagination {
  if (!state.result?.signedIn || state.result.state !== 'ready') return state;
  const page = readableInboxPage(state);
  if (!page?.next || page.next === state.cursor) return state;
  return { cursor: page.next, earlier: page, current: null, result: undefined };
}
