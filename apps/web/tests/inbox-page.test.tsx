import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, Fragment } from 'react';
import * as start from '../.storybook/react-start';
import type { InboxPage, InboxPageQuery, InboxSeenAttempt, InboxSeenResult } from '../src/inbox/inbox-read';
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const buttonModule = await import('@rezics/ui/shadcn/button');
const OriginalButton = buttonModule.Button;
spyOn(buttonModule, 'Button').mockImplementation((props) => createElement(OriginalButton, props));
const reads = await import('../src/inbox/inbox-read');
spyOn(reads, 'readUnreadCount').mockImplementation(async () => ({
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
const notice = (id: string, unread = true) => ({
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
  text: `Private reply ${id}`,
  unavailable: false,
});
const tick = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount(loadPage: (query: InboxPageQuery) => Promise<InboxPage>) {
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
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          RouterContextProvider,
          { router },
          createElement(Fragment, null, createElement(InboxPageView, { loadPage })),
        ),
      ),
    );
  });
  await tick();
  return {
    host,
    click: (label: string) =>
      act(async () => {
        const node = [...host.querySelectorAll('button')].find((button) => button.textContent === label);
        expect(node, label).toBeDefined();
        node!.click();
      }),
    unmount: () =>
      act(async () => {
        root.unmount();
        host.remove();
      }),
  };
}

test('All/Unread restarts without a cursor, sparse unread is not empty, and invalid cursor is a distinct restart', async () => {
  const queries: InboxPageQuery[] = [];
  const view = await mount(async (query) => {
    queries.push(query);
    if (query.selection === 'unread' && !query.cursor)
      return readyInboxPage([], 'sparse-next', 'alice', 'unread');
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
