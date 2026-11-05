import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment, type MouseEvent } from 'react';
import * as start from '../.storybook/react-start';
import type {
  InboxNoticeSeenAttempt,
  InboxPage,
  InboxPageQuery,
  InboxSeenAttempt,
  InboxSeenResult,
} from '../src/inbox/inbox-read';
import { readyInboxPage } from '../src/inbox/inbox-read';

let sessionSubject = 'alice';
let sessionToken = 'original-token';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () =>
    new Request('https://site.test/en/inbox', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
  setResponseHeader: () => {},
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'inbox-page',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ signedIn: async () => ({ signedIn: true, subject: sessionSubject, csrfToken: sessionToken }) }),
    },
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/inbox' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  useRouterState,
} = await import('@tanstack/react-router');
const buttonModule = await import('@rezics/ui/shadcn/button');
const OriginalButton = buttonModule.Button;
const buttonCallbacks = new Map<string, (event: MouseEvent<HTMLButtonElement>) => void>();
spyOn(buttonModule, 'Button').mockImplementation((props) => {
  if (typeof props.children === 'string' && props.onClick)
    buttonCallbacks.set(props.children, props.onClick as (event: MouseEvent<HTMLButtonElement>) => void);
  return createElement(OriginalButton, props);
});
const reads = await import('../src/inbox/inbox-read');
const countSpy = spyOn(reads, 'readUnreadCount').mockImplementation(async () => ({
  signedIn: true,
  state: 'ready',
  count: 2,
  capped: false,
  basis: 'current-visible-unread',
  witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
}));
const seenCommands: InboxSeenAttempt[] = [];
spyOn(reads, 'markInboxSeen').mockImplementation(async ({ data }) => {
  seenCommands.push(data);
  return { signedIn: true } satisfies InboxSeenResult;
});
const { InboxPageView } = await import('../src/inbox/inbox-page');
const { UnreadBadge } = await import('../src/inbox/unread-badge');
const { fetchInboxUnreadCount, inboxViewerQueryKey, unreadCountQueryFor } = await import('../src/inbox/inbox-query');
const { currentInboxViewer } = await import('../src/inbox/inbox-viewer');
const { subscribeInboxReturn } = await import('../src/inbox/inbox-return');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const notice = (id: string, unread = true, overrides: { text?: string } = {}) => ({
  id,
  unread,
  kind: 'reply',
  createdAt: '2026-10-29T10:00:00.000Z',
  actorId: 'actor',
  actorName: 'Momo',
  threadId: 'thread',
  postId: id,
  decisionId: null,
  reportId: null,
  href: `/threads/thread#post-${id}`,
  text: overrides.text ?? `Private reply ${id}`,
  unavailable: false,
});
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(
  loadPage: (query: InboxPageQuery) => Promise<InboxPage>,
  badge = false,
  acknowledgeNotice?: (attempt: InboxNoticeSeenAttempt, csrfToken: string) => Promise<void>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'alice',
    csrfToken: 'original-token',
  });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/inbox'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const tree = () =>
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        RouterContextProvider,
        { router },
        createElement(
          Fragment,
          null,
          badge ? createElement(UnreadBadge) : null,
          createElement(InboxPageView, { loadPage, ...(acknowledgeNotice ? { acknowledgeNotice } : {}) }),
        ),
      ),
    );
  await act(async () => {
    root.render(tree());
  });
  await tick();
  return {
    host,
    client,
    click: (label: string) =>
      act(async () => {
        const node = [...host.querySelectorAll('button')].find((button) => button.textContent === label);
        expect(node, label).toBeDefined();
        node!.click();
      }),
    rerender: () => act(async () => root.render(tree())),
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

async function mountRouted(
  loadPage: (query: InboxPageQuery) => Promise<InboxPage>,
  acknowledgeNotice?: (attempt: InboxNoticeSeenAttempt, csrfToken: string) => Promise<void>,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: 'alice',
    csrfToken: 'original-token',
  });
  const rootRoute = createRootRoute({
    component: () => createElement(Fragment, null, createElement(UnreadBadge), createElement(Outlet)),
  });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/inbox',
    component: () => {
      const historyKey = useRouterState({
        select: (state) => {
          const routeState = state.location.state as { key?: unknown; __TSR_key?: unknown };
          const key = typeof routeState.key === 'string' ? routeState.key : routeState.__TSR_key;
          return typeof key === 'string' ? key : state.location.href;
        },
      });
      return createElement(InboxPageView, {
        loadPage,
        historyKey,
        ...(acknowledgeNotice ? { acknowledgeNotice } : {}),
      });
    },
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/threads/$threadId',
    component: () => createElement('h1', null, 'Thread destination'),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([inboxRoute, threadRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/inbox'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await router.load();
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  });
  await tick();
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 180 && !ready(); count++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    if (!ready())
      throw new Error(
        `Route did not settle: ${JSON.stringify({
          href: router.state.location.href,
          matches: router.state.matches.map((match) => ({ routeId: match.routeId, status: match.status })),
          text: host.textContent?.slice(0, 500),
        })}`,
      );
  };
  const click = async (label: string) =>
    act(async () => {
      const node = [...host.querySelectorAll('button')].find((button) => button.textContent === label);
      expect(node, label).toBeDefined();
      node!.click();
    });
  return {
    host,
    client,
    router,
    click,
    settle,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        host.remove();
      });
      client.clear();
    },
  };
}

test('All/Unread restarts without a cursor, sparse unread is not empty, and invalid cursor is a distinct restart', async () => {
  const queries: InboxPageQuery[] = [];
  const view = await mount(async (query) => {
    queries.push(query);
    if (query.selection === 'unread' && !query.cursor) return readyInboxPage([], 'sparse-next', 'alice', 'unread');
    if (query.cursor === 'sparse-next')
      return { signedIn: true, state: 'unavailable', failure: { status: 400, code: 'invalid_cursor' } };
    return readyInboxPage([notice('newest')], 'all-next', 'alice', query.selection);
  });
  try {
    expect(queries).toEqual([{ selection: 'all' }]);
    await view.click(m.inbox_triage_filter_unread());
    await tick();
    expect(queries).toEqual([{ selection: 'all' }, { selection: 'unread' }]);
    expect(view.host.textContent).toContain(m.inbox_selection_sparse());
    expect(view.host.textContent).toContain(m.inbox_triage_no_unread_loaded());
    expect(view.host.textContent).not.toContain(m.inbox_empty());
    await view.click(m.inbox_next_page());
    await tick();
    expect(queries.at(-1)).toEqual({ selection: 'unread', cursor: 'sparse-next' });
    expect(view.host.textContent).toContain(m.inbox_invalid_cursor());
  } finally {
    await view.unmount();
  }
});

test('bulk acknowledgement uses the owner-supplied through and retries that original command', async () => {
  seenCommands.length = 0;
  const { InboxSeenError } = reads;
  let fail = true;
  spyOn(reads, 'markInboxSeen').mockImplementation(async ({ data }) => {
    seenCommands.push(data);
    if (fail) {
      fail = false;
      throw new InboxSeenError({ status: 503, retryable: true, code: 'deadline_exceeded' });
    }
    return { signedIn: true } satisfies InboxSeenResult;
  });
  const view = await mount(async () => readyInboxPage([notice('displayed'), notice('older')], null, 'alice'));
  try {
    await view.click(m.inbox_triage_mark());
    await tick();
    expect(seenCommands).toHaveLength(1);
    expect(seenCommands[0]?.through).toBe('displayed');
    const original = seenCommands[0]!;
    await view.click(m.inbox_retry());
    await tick();
    expect(seenCommands).toHaveLength(2);
    expect(seenCommands[1]).toEqual(original);
  } finally {
    await view.unmount();
  }
});

test('individual Retry-After survives a shorter page wait and one deliberate retry sends the same intent', async () => {
  const { InboxSeenError } = reads;
  buttonCallbacks.clear();
  let pageReads = 0;
  const attempts: InboxNoticeSeenAttempt[] = [];
  const view = await mount(
    async () => {
      pageReads += 1;
      return pageReads === 1
        ? readyInboxPage([notice('chosen')], null, 'alice')
        : { signedIn: true, state: 'unavailable', failure: { status: 503, retryable: true, retryAfter: '1' } };
    },
    false,
    async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) throw new InboxSeenError({ status: 503, retryable: true, retryAfter: '2' });
    },
  );
  try {
    await view.click(m.inbox_notice_mark_seen());
    await tick();
    expect(attempts).toHaveLength(1);
    const retry = buttonCallbacks.get(m.inbox_notice_seen_retry());
    expect(retry).toBeDefined();
    const retryButton = () =>
      [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === m.inbox_notice_seen_retry(),
      );
    expect(retryButton()).toBeDefined();

    const viewer = currentInboxViewer(view.client)!;
    await act(async () => {
      await view.client.refetchQueries({ queryKey: inboxViewerQueryKey(viewer) });
    });
    await tick();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    await act(async () => retry!(undefined as unknown as MouseEvent<HTMLButtonElement>));
    expect(attempts).toHaveLength(1);
    expect(retryButton()?.disabled).toBe(true);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_050));
    });
    await act(async () => {
      retry!(undefined as unknown as MouseEvent<HTMLButtonElement>);
      retry!(undefined as unknown as MouseEvent<HTMLButtonElement>);
    });
    await tick();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(view.host.textContent).toContain(m.inbox_notice_marked_seen());
  } finally {
    await view.unmount();
  }
});

test('A to B to A retires individual acknowledgement custody and fences its late completion', async () => {
  let finishOld: (() => void) | undefined;
  const oldCompletion = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const attempts: InboxNoticeSeenAttempt[] = [];
  const view = await mount(
    async () => readyInboxPage([notice('chosen')], null, 'alice'),
    false,
    async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) await oldCompletion;
    },
  );
  try {
    await view.click(m.inbox_notice_mark_seen());
    expect(attempts).toHaveLength(1);
    await act(async () => {
      view.client.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: 'bob',
        csrfToken: 'bob-token',
      });
      view.client.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: 'alice',
        csrfToken: 'original-token',
      });
    });
    await view.rerender();
    await tick();
    finishOld!();
    await tick();
    expect(view.host.textContent).not.toContain(m.inbox_notice_marked_seen());
    await view.click(m.inbox_notice_mark_seen());
    await tick();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.accountId).toBe('alice');
    expect(attempts[1]!.noticeId).toBe('chosen');
    expect(attempts[1]!.idempotencyKey).not.toBe(attempts[0]!.idempotencyKey);
  } finally {
    finishOld?.();
    await view.unmount();
  }
});

const nativeCount = (
  count: number,
  extras: { capped?: boolean; basis?: 'current-visible-unread' | 'current-visible-lower-bound' } = {},
) => ({
  signedIn: true as const,
  state: 'ready' as const,
  count,
  capped: extras.capped ?? false,
  basis: extras.basis ?? 'current-visible-unread',
  witness: { kind: 'current-disclosure' as const, at: '2026-11-04T00:00:00.000Z' },
});

test('a failed unread summary stays unavailable on a usable page, and Retry-After blocks count IO until a deliberate eligible retry', async () => {
  seenCommands.length = 0;
  const clock = Date.now;
  let now = Date.parse('2026-11-05T00:00:00.000Z');
  Date.now = () => now;
  let countReads = 0;
  countSpy.mockImplementation(async () => {
    countReads += 1;
    return countReads === 1
      ? { signedIn: true, state: 'unavailable', failure: { status: 503, retryAfter: '5' } }
      : nativeCount(4);
  });
  let pageReads = 0;
  const view = await mount(async () => {
    pageReads += 1;
    return readyInboxPage([notice('displayed')], null, 'alice');
  }, true);
  try {
    expect(countReads).toBe(1);
    expect(pageReads).toBe(1);
    expect(view.host.textContent).toContain(m.inbox_unread_unavailable());
    expect(view.host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(m.inbox_unread_unavailable());
    expect(view.host.textContent).toContain('Private reply displayed');
    expect(view.host.textContent).toContain(m.inbox_triage_mark());
    const viewer = currentInboxViewer(view.client)!;
    const key = unreadCountQueryFor(viewer).queryKey;
    const captured = () => view.client.refetchQueries({ queryKey: key });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: key });
    });
    await act(async () => {
      await captured();
    });
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: key, exact: true });
    });
    expect(countReads).toBe(1);
    now += 5_000;
    expect(countReads).toBe(1);
    await view.rerender();
    await view.click(m.inbox_unread_retry());
    await tick();
    expect(countReads).toBe(2);
    expect(pageReads).toBe(1);
    expect(view.host.textContent).toContain(m.inbox_unread_count({ count: '4' }));
    expect(
      [...view.host.querySelectorAll('[aria-label]')].some(
        (node) => node.getAttribute('aria-label') === m.inbox_unread_count({ count: '4' }),
      ),
    ).toBe(true);
    expect(seenCommands).toHaveLength(0);
    view.client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'bob',
      csrfToken: 'original-token',
    });
    await expect(fetchInboxUnreadCount(viewer)).rejects.toThrow('Inbox viewer changed');
  } finally {
    Date.now = clock;
    await view.unmount();
  }
});

test('ready zero and lower-bound summaries stay distinct from the selected page, and signed-out is not a zero count', async () => {
  countSpy.mockImplementation(async () => nativeCount(0));
  const empty = await mount(async () => readyInboxPage([notice('visible')], null, 'alice'));
  try {
    expect(empty.host.textContent).toContain(m.inbox_unread_none());
    expect(empty.host.textContent).toContain(m.inbox_unread_none_not_empty());
    expect(empty.host.textContent).not.toContain(m.inbox_empty());
    expect(empty.host.textContent).toContain('Private reply visible');
  } finally {
    await empty.unmount();
  }
  countSpy.mockImplementation(async () => nativeCount(100, { capped: true, basis: 'current-visible-lower-bound' }));
  const capped = await mount(async () => readyInboxPage([notice('visible')], null, 'alice'));
  try {
    expect(capped.host.textContent).toContain(m.inbox_unread_lower_bound({ count: '100' }));
    expect(capped.host.textContent).not.toContain(m.inbox_unread_none());
  } finally {
    await capped.unmount();
  }
  countSpy.mockImplementation(async () => ({ signedIn: false }));
  const signedOut = await mount(async () => readyInboxPage([notice('visible')], null, 'alice'));
  try {
    expect(signedOut.host.textContent).toContain(m.inbox_unread_signed_out());
    expect(signedOut.host.textContent).not.toContain(m.inbox_unread_none());
    expect(signedOut.host.textContent).toContain('Private reply visible');
  } finally {
    await signedOut.unmount();
  }
});

test('Previous and browser return re-admit the exact unread address and restore only its current notice', async () => {
  const queries: InboxPageQuery[] = [];
  const noticeAcknowledgements: InboxNoticeSeenAttempt[] = [];
  let unreadFirstPageReads = 0;
  const view = await mountRouted(
    async (query) => {
      queries.push(query);
      if (query.selection === 'all') return readyInboxPage([notice('all-first')], 'all-older', 'alice', 'all');
      if (query.cursor === 'unread-older')
        return readyInboxPage([notice('sparse-only')], 'unread-end', 'alice', 'unread');
      if (query.selection === 'unread') {
        unreadFirstPageReads += 1;
        if (unreadFirstPageReads === 1)
          return readyInboxPage(
            [notice('return-origin', true, { text: 'Original admitted notice' })],
            'unread-older',
            'alice',
            'unread',
          );
        if (unreadFirstPageReads === 2)
          return readyInboxPage(
            [notice('return-origin', true, { text: 'Previous fresh notice' }), notice('read-neighbor', false)],
            'unread-older',
            'alice',
            'unread',
          );
        return readyInboxPage(
          [notice('return-origin', true, { text: 'Current native replacement' })],
          'unread-older',
          'alice',
          'unread',
        );
      }
      throw new Error(`Unexpected inbox query: ${JSON.stringify(query)}`);
    },
    async (attempt) => {
      noticeAcknowledgements.push(attempt);
    },
  );
  const returnEvents: Array<{ phase: string | null; historyKey: string | null }> = [];
  const stopReturnEvents = subscribeInboxReturn(view.router, (receipt) =>
    returnEvents.push({ phase: receipt?.phase ?? null, historyKey: receipt?.historyKey ?? null }),
  );
  try {
    await view.settle(() => view.host.textContent?.includes('all-first') === true);
    await view.click(m.inbox_triage_filter_unread());
    await view.settle(() => view.host.textContent?.includes('Original admitted notice') === true);
    await view.click(m.inbox_load_more());
    await view.settle(() => view.host.textContent?.includes('sparse-only') === true);
    expect(view.host.textContent).toContain(m.inbox_previous_page());
    await view.click(m.inbox_previous_page());
    await view.settle(() => view.host.textContent?.includes('Previous fresh notice') === true);
    expect(view.host.textContent).toContain('read-neighbor');

    const destination = view.host.querySelector<HTMLAnchorElement>('[data-notice-id="return-origin"] a[href]');
    expect(destination?.getAttribute('href')).toBe('/threads/thread#post-return-origin');
    await act(async () => {
      destination!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await tick();
    expect(view.router.state.location.pathname).toBe('/threads/thread');
    await view.settle(() => view.host.textContent?.includes('Thread destination') === true);
    expect(returnEvents.map(({ phase }) => phase)).toEqual(['armed', 'departed']);
    await act(async () => view.router.history.back());
    await tick();
    expect(returnEvents.some(({ phase }) => phase === 'arrived')).toBe(true);
    await view.settle(() => view.host.textContent?.includes('Current native replacement') === true);

    expect(queries).toEqual([
      { selection: 'all' },
      { selection: 'unread' },
      { selection: 'unread', cursor: 'unread-older' },
      { selection: 'unread' },
      { selection: 'unread' },
    ]);
    expect(view.host.textContent).not.toContain('Original admitted notice');
    expect(view.host.textContent).toContain(m.inbox_return_notice_restored());
    expect(document.activeElement).toBe(
      view.host.querySelector('[data-notice-id="return-origin"] [data-inbox-notice-action]'),
    );
    expect(noticeAcknowledgements).toEqual([]);
    expect(seenCommands).toEqual([]);
  } finally {
    stopReturnEvents();
    await view.unmount();
  }
});

test('a missing returned notice names the changed result, focuses the heading, and offers a fresh first-page read', async () => {
  const queries: InboxPageQuery[] = [];
  const noticeAcknowledgements: InboxNoticeSeenAttempt[] = [];
  let firstPageReads = 0;
  const view = await mountRouted(
    async (query) => {
      queries.push(query);
      if (query.selection === 'all') return readyInboxPage([notice('all-first')], null, 'alice', 'all');
      if (query.cursor) return readyInboxPage([notice('sparse-only')], 'unread-end', 'alice', 'unread');
      firstPageReads += 1;
      if (firstPageReads <= 2)
        return readyInboxPage(
          [notice('disappearing-origin', true, { text: 'Original unread notice' })],
          'unread-old',
          'alice',
          'unread',
        );
      return readyInboxPage(
        [notice('current-neighbor', true, { text: 'Fresh selected page' })],
        null,
        'alice',
        'unread',
      );
    },
    async (attempt) => {
      noticeAcknowledgements.push(attempt);
    },
  );
  try {
    await view.settle(() => view.host.textContent?.includes('all-first') === true);
    await view.click(m.inbox_triage_filter_unread());
    await view.settle(() => view.host.textContent?.includes('Original unread notice') === true);
    await view.click(m.inbox_load_more());
    await view.settle(() => view.host.textContent?.includes('sparse-only') === true);
    await view.click(m.inbox_previous_page());
    await view.settle(() => view.host.textContent?.includes('Original unread notice') === true);
    const destination = view.host.querySelector<HTMLAnchorElement>('[data-notice-id="disappearing-origin"] a[href]');
    await act(async () => {
      destination!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0 }));
    });
    await view.settle(() => view.host.textContent?.includes('Thread destination') === true);
    await act(async () => view.router.history.back());
    await view.settle(() => view.host.textContent?.includes(m.inbox_return_notice_missing()) === true);

    expect(view.host.textContent).toContain('Fresh selected page');
    expect(view.host.textContent).not.toContain('Original unread notice');
    expect(document.activeElement).toBe(view.host.querySelector('h1'));
    expect(document.activeElement).not.toBe(
      view.host.querySelector('[data-notice-id="current-neighbor"] [data-inbox-notice-action]'),
    );
    expect(noticeAcknowledgements).toEqual([]);
    expect(seenCommands).toEqual([]);

    await view.click(m.inbox_start_first_page());
    await view.settle(() => view.host.textContent?.includes('Fresh selected page') === true);
    expect(queries).toEqual([
      { selection: 'all' },
      { selection: 'unread' },
      { selection: 'unread', cursor: 'unread-old' },
      { selection: 'unread' },
      { selection: 'unread' },
      { selection: 'unread' },
    ]);
    expect(noticeAcknowledgements).toEqual([]);
    expect(seenCommands).toEqual([]);
  } finally {
    await view.unmount();
  }
});
