import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import { boardOpeningExample, boardOpeningCard, boardOpeningId } from '../src/threads/board-opening-fixtures';
import { receiveBoardOpeningPage } from '../src/threads/board-opening';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import { BoardPageCursorError } from '../src/threads/board-reading';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const reads = await import('../src/threads/reads');
const { Route: BoardRoute } = await import('../src/routes/boards/$id');
const { Route: ThreadRoute } = await import('../src/routes/threads/$id_.$slug');
const { Route: IdRoute } = await import('../src/routes/threads/$id');
const { boardSearch, admittedBoardReturn, boardRequestHref, boardReturnRestart } =
  await import('../src/threads/board-navigation');
const { threadSearch, threadLocation } = await import('../src/threads/thread-href');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { returnTarget } = await import('../src/session/return-target');
const sessionClient = await import('../src/session/client');
const oidc = await import('openid-client');
const { authRequest } = await import('../src/session/routes');
const response = boardOpeningExample();
const card = boardOpeningCard(8);
const duplicate = structuredClone(card);
duplicate.thread = { ...duplicate.thread, title: 'Second occurrence', securityRevision: '2' };
duplicate.authors.thread = { state: 'unavailable' };
response.pinnedThreads = [];
response.threads = [card, duplicate];
const boardPage = receiveBoardOpeningPage(response);
const parentId = boardOpeningCard(99).thread.firstPost.id;
const reading: ThreadReadingPage = {
  thread: duplicate.thread,
  board: response.board,
  realm: { id: response.board.realmId!, title: 'Readers' },
  posts: {
    posts: [
      duplicate.thread.firstPost,
      { ...card.thread.firstPost, id: boardOpeningCard(9).thread.firstPost.id, parentId },
    ],
    next: 'reply/+next==',
  },
  composed: authoredReadingPage(duplicate.thread),
  authors: boardPage.authors,
  mentions: {},
  subjects: [],
  provenanceSubjects: [],
  verification: { sitekey: '', scriptUrl: '' },
  now: boardPage.now,
};
const cursor = 'original/+frontier==';
const subjectId = boardOpeningCard(10).thread.id;
const subjectReturn = `/en/subjects/${subjectId}/work/reviews?realm=${response.board.realmId}&cursor=subject%2F%2Bopaque&node=reviews#subject-community-reviews`;
const boardHref = boardRequestHref('en', boardOpeningId, { cursor, sort: 'hot', returnTo: subjectReturn });
const boardCalls: { cursor?: string; sort?: string }[] = [];
let failure: 'none' | 'once' | 'expired' = 'none';
const boardReader = spyOn(reads, 'readBoardPage').mockImplementation(async ({ data }) => {
  boardCalls.push(data);
  if (failure === 'expired') throw new BoardPageCursorError(boardOpeningId, 'hot');
  if (failure === 'once') {
    failure = 'none';
    throw new Error('temporary board read failure');
  }
  const page =
    data.cursor === 'sparse'
      ? receiveBoardOpeningPage({ ...response, threads: [], next: 'examined/+next==' })
      : boardPage;
  return { page, readerOrigin: { kind: 'anonymous' } };
});
const threadReader = spyOn(reads, 'readThreadPage').mockResolvedValue(reading);
const slugReader = spyOn(reads, 'readThreadSlug').mockResolvedValue({
  id: duplicate.thread.id,
  title: duplicate.thread.title,
});

async function mount(href: string) {
  setLocale('en', { reload: false });
  notifyManager.setScheduler((callback) => callback());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
  const rootRoute = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: 'anonymous';
  }>()({ component: Outlet });
  BoardRoute.update({ id: '/boards/$id', path: '/en/boards/$id', getParentRoute: () => rootRoute } as never);
  ThreadRoute.update({
    id: '/threads/$id_/$slug',
    path: '/en/threads/$id/$slug',
    getParentRoute: () => rootRoute,
  } as never);
  IdRoute.update({ id: '/threads/$id', path: '/en/threads/$id', getParentRoute: () => rootRoute } as never);
  const router = createRouter({
    routeTree: rootRoute.addChildren([BoardRoute, ThreadRoute, IdRoute]),
    context: { queryClient: client, credentialMode: 'anonymous' },
    history: createMemoryHistory({ initialEntries: [href] }),
    defaultPendingMinMs: 0,
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    await router.load();
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  const navigate = async (href: string) => {
    await act(async () => {
      await router.navigate({ href });
    });
  };
  const link = (label: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((node) => node.textContent === label)!;
  return {
    host,
    router,
    client,
    navigate,
    link,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}
afterAll(() => {
  boardReader.mockRestore();
  threadReader.mockRestore();
  slugReader.mockRestore();
  mock.restore();
  setLocale('en', { reload: false });
  window.happyDOM.abort();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('actual mounted Board, duplicate row, reply, sign-in and canonical routes consume the original Board request', async () => {
  const visit = await mount(boardHref);
  try {
    const rows = [...visit.host.querySelectorAll<HTMLElement>('[data-thread-id]')];
    expect(rows.map((row) => row.dataset.threadId)).toEqual([card.thread.id, card.thread.id]);
    expect(rows.map((row) => row.id)).toEqual([
      `board-thread-${card.thread.id}--ordinary-0`,
      `board-thread-${card.thread.id}--ordinary-1`,
    ]);
    const selected = rows[1]!.querySelector<HTMLAnchorElement>('a[href]')!;
    const destination = new URL(selected.href);
    const original = `${boardHref}#${rows[1]!.id}`;
    expect(destination.searchParams.get('boardReturn')).toBe(original);
    expect(rows[1]!.textContent).toContain('Second occurrence');
    expect(rows[1]!.textContent).not.toContain('reader-2');
    await visit.navigate(destination.pathname + destination.search + '#reply');
    expect(visit.link(m.board_reading_return())?.getAttribute('href')).toBe(original);
    expect(
      visit.host.querySelector('nav[aria-label="' + m.board_context_label() + '"] a:last-child')?.getAttribute('href'),
    ).toBe(original);
    const signIn = new URL(visit.link(m.threads_sign_in_to_reply()).href);
    const resume = signIn.searchParams.get('return_to')!;
    expect(threadSearch(Object.fromEntries(new URL(resume, 'https://site.test').searchParams)).boardReturn).toBe(
      original,
    );
    expect(resume.endsWith('#reply')).toBe(true);
    expect(returnTarget(resume, 'https://site.test')).toBe(resume);
    const config = spyOn(sessionClient, 'authClient').mockResolvedValue(
      new oidc.Configuration(
        {
          issuer: 'https://issuer.test',
          authorization_endpoint: 'https://issuer.test/authorize',
        },
        'website',
      ),
    );
    const transactions: { returnTo: string }[] = [];
    const env = {
      AUTH_ISSUER: 'https://issuer.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'thread:read',
      WEBSITE_CLIENT_ID: 'website',
      WEBSITE_CLIENT_KEY: 'prepared-by-auth-owner',
      SESSIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          create: async (value: { returnTo: string }) => {
            transactions.push(value);
          },
          takeLogin: async () => transactions[0],
        }),
      } as never,
    };
    try {
      const signedIn = await authRequest(new Request(signIn), env);
      expect(signedIn.status).toBe(302);
      expect(transactions[0]?.returnTo).toBe(resume);
      const state = new URL(signedIn.headers.get('location')!).searchParams.get('state')!;
      const cookie = signedIn.headers
        .getSetCookie()
        .find((value) => value.startsWith('__Host-rezics_login='))!
        .split(';')[0]!;
      const callback = await authRequest(
        new Request(`https://site.test/auth/callback?state=${state}&error=access_denied`, { headers: { cookie } }),
        env,
      );
      expect(callback.headers.get('location')).toBe(resume);
    } finally {
      config.mockRestore();
    }
    // The ID redirect is a real loader, followed by the canonical route and the existing reading region.
    await visit.navigate(resume);
    expect(visit.router.state.location.pathname).toContain('/threads/' + duplicate.thread.id + '/');
    const parent = visit.link(m.thread_branch_parent_destination());
    expect(parent).toBeDefined();
    expect(threadSearch(Object.fromEntries(new URL(parent.href).searchParams)).boardReturn).toBe(original);
    await visit.navigate(new URL(parent.href).pathname + new URL(parent.href).search);
    expect(visit.router.state.location.search.post).toBe(parentId);
    expect(visit.link(m.board_reading_return())?.getAttribute('href')).toBe(original);
    expect(visit.host.querySelector('form')).toBeNull();
    const next = visit.link(m.threads_next_page());
    expect(new URL(next.href).searchParams.get('boardReturn')).toBe(original);
    await visit.navigate(original);
    expect(boardCalls.at(-1)).toMatchObject({ cursor, sort: 'hot' });
    expect(visit.host.querySelectorAll('[data-thread-id]')).toHaveLength(2);
    expect(document.activeElement?.id).toBe(rows[1]!.id);
    await visit.navigate(threadLocation('en', { id: duplicate.thread.id, title: duplicate.thread.title }));
    expect(visit.link(m.board_reading_return())).toBeUndefined();
    expect(
      visit.host.querySelector('nav[aria-label="' + m.board_context_label() + '"] a:last-child')?.getAttribute('href'),
    ).not.toContain('cursor=');
  } finally {
    await visit.close();
  }
});

test('sparse examined pages, failed continuation retry and expired return keep native operands and explicit restart', async () => {
  const visit = await mount(
    boardRequestHref('en', boardOpeningId, { cursor: 'sparse', sort: 'hot', returnTo: subjectReturn }),
  );
  try {
    const next = visit.link(m.threads_next_page());
    const target = new URL(next.href);
    expect(target.searchParams.get('cursor')).toBe('examined/+next==');
    expect(target.searchParams.get('returnTo')).toBe(subjectReturn);
    failure = 'once';
    await visit.navigate(
      boardRequestHref('en', boardOpeningId, { cursor: 'examined/+next==', sort: 'hot', returnTo: subjectReturn }),
    );
    expect(visit.host.querySelectorAll('[data-thread-id]')).toHaveLength(0);
    const retry = [...visit.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (node) => node.textContent === m.board_community_retry(),
    )!;
    await act(async () => {
      retry.click();
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(boardCalls.slice(-2).map((call) => [call.cursor, call.sort])).toEqual([
      ['examined/+next==', 'hot'],
      ['examined/+next==', 'hot'],
    ]);
    expect(visit.host.querySelectorAll('[data-thread-id]')).toHaveLength(2);
    failure = 'expired';
    await visit.navigate(
      boardRequestHref('en', boardOpeningId, { cursor: 'retired', sort: 'hot', returnTo: subjectReturn }),
    );
    expect(visit.host.textContent).toContain(m.board_reading_invalid_cursor());
    const restart = new URL(visit.link(m.board_reading_restart()).href);
    expect(restart.searchParams.has('cursor')).toBe(false);
    expect(restart.searchParams.get('sort')).toBe('hot');
    expect(restart.searchParams.get('returnTo')).toBe(subjectReturn);
  } finally {
    failure = 'none';
    await visit.close();
  }
});

test('the actual route validators reject external returns and keep locale, opaque frontier and admitted Subject/place', () => {
  expect(BoardRoute.options.validateSearch).toBe(boardSearch);
  expect(ThreadRoute.options.validateSearch).toBe(threadSearch);
  expect(IdRoute.options.validateSearch).toBe(threadSearch);
  for (const value of [
    'https://evil.test/en/boards/' + boardOpeningId,
    '//evil.test/en/boards/' + boardOpeningId,
    '/\\evil.test/en/boards/' + boardOpeningId,
  ]) {
    expect(threadSearch({ boardReturn: value }).boardReturn).toBeUndefined();
    expect(returnTarget(value, 'https://site.test')).toBe('/');
  }
  for (const locale of ['en', 'zh-Hant', 'ja']) {
    const href = boardRequestHref(locale, boardOpeningId, {
      sort: 'new',
      cursor: 'a/+?=&版%',
      returnTo: subjectReturn.replace('/en/', `/${locale}/`),
    });
    expect(admittedBoardReturn(href)).toBe(href);
    const search = threadSearch({ boardReturn: href, command: 'reply' });
    expect(search).toEqual({ boardReturn: href });
    expect(new URL(boardReturnRestart(search.boardReturn!)!, 'https://site.test').searchParams.has('cursor')).toBe(
      false,
    );
  }
});
