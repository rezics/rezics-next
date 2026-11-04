import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import type { ReadCredentialMode } from '../src/kernel/credential';
import type { CommunityBoardPage } from '../src/threads/board-feed-data';
import type { BoardPageRead } from '../src/threads/reads';
import boardRecording from '../src/kernel/recorded/board.json';
import threadsRecording from '../src/kernel/recorded/board-threads.json';
import accountsRecording from '../src/kernel/recorded/accounts.json';
import * as startApi from '../.storybook/react-start';

type BoardReadInput = {
  id: string;
  cursor?: string;
  sort?: 'hot' | 'new';
  credentialMode: ReadCredentialMode;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Session = { state: 'signed-in' | 'signed-out'; subject?: string; csrfToken: string | null };
type ReadCall = { input: BoardReadInput; session: Session | undefined; result: Deferred<BoardPageRead> };
const calls: ReadCall[] = [];
let mockReaderSession: Session | undefined;

mock.module('@tanstack/react-start', () => startApi);
mock.module('@tanstack/react-start/server', () => ({
  ...startApi,
  getRequest: () => new Request('https://site.test/en/boards'),
}));
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));

const existingReads = await import('../src/threads/reads');
mock.module('../src/threads/reads', () => ({
  ...existingReads,
  readBoardPage: ({ data }: { data: BoardReadInput }) => {
    const result = deferred<BoardPageRead>();
    calls.push({ input: data, session: mockReaderSession, result });
    return result.promise;
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards' });
window.document.documentElement.lang = 'en';
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { createKernelClient } = await import('@rezics/client');
const { fromPlainText } = await import('@rezics/document');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const { sessionQuery } = await import('../src/session/query');
const { Route } = await import('../src/routes/boards/$id');
const { loadBoardPageWithAuthors } = await import('../src/identity/page-loaders');

type RouterMode = {
  id: string;
  mode: ReadCredentialMode;
  session: Session;
  cursor?: string;
  sort?: 'hot' | 'new';
};

const boardA = boardRecording.board.id;
const boardB = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const accountId = accountsRecording.accounts[0]!.id;

async function csrfFingerprint(token: string | null): Promise<string> {
  const value = token === null ? 'null\u0000' : `token\u0000${token}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function makeQueryClient(session: Session) {
  mockReaderSession = session;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const setQueryData = client.setQueryData.bind(client);
  client.setQueryData = ((key: readonly unknown[], value: unknown, options?: unknown) => {
    const result = setQueryData(key as never, value as never, options as never);
    if (key.length === 1 && key[0] === 'session') mockReaderSession = value as Session;
    return result;
  }) as typeof client.setQueryData;
  client.setQueryData(sessionQuery.queryKey, session);
  return client;
}

function makeRouter(client: InstanceType<typeof QueryClient>, options: RouterMode) {
  const root = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: ReadCredentialMode;
  }>()({ component: Outlet });
  const boardRoute = Route.update({
    id: '/boards/$id',
    path: '/boards/$id',
    getParentRoute: () => root,
  } as never);
  const routeTree = root.addChildren([boardRoute]);
  const history = createMemoryHistory({
    initialEntries: [
      `/boards/${options.id}${options.cursor === undefined && options.sort === undefined ? '' : `?${new URLSearchParams({ ...(options.cursor === undefined ? {} : { cursor: options.cursor }), ...(options.sort === undefined ? {} : { sort: options.sort }) })}`}`,
    ],
  });
  const router = createRouter({
    routeTree,
    context: { queryClient: client, credentialMode: options.mode },
    history,
  });
  return router;
}

function app(client: InstanceType<typeof QueryClient>, router: ReturnType<typeof createRouter>) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(StrictMode, null, createElement(RouterProvider, { router })),
  );
}

function noWindow<T>(operation: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'window');
  try {
    return operation();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
  }
}

async function noWindowAsync<T>(operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'window');
  try {
    return await operation();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
  }
}

async function pageFor(input: BoardReadInput, label: string): Promise<CommunityBoardPage> {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (inputUrl, init) => {
      const request = new Request(inputUrl, init);
      const { pathname } = new URL(request.url);
      if (pathname === `/v1/boards/${input.id}/page`) {
        const threads = threadsRecording.threads.map((thread) => ({
          ...thread,
          boardId: input.id,
          title: `${label} Thread`,
          firstPost: {
            ...thread.firstPost,
            boardId: input.id,
            body: fromPlainText(`${label} opening text`, 'blocks'),
          },
        }));
        const author = (id: string) => {
          const account = accountsRecording.accounts.find((entry) => entry.id === id);
          return account
            ? {
                state: 'available',
                id: account.id,
                kind: account.kind,
                handle: account.handle,
                displayName: account.displayName,
                automated: false,
              }
            : { state: 'unavailable' };
        };
        const advice = request.headers.has('authorization') ? 'allowed' : 'sign-in';
        return Response.json({
          board: {
            ...boardRecording.board,
            id: input.id,
            title: `${label} Board`,
            visibility: input.credentialMode === 'session' ? 'protected' : 'public',
          },
          pinnedThreads: [],
          threads: threads.map((thread) => ({
            thread,
            target: { kind: 'thread', id: thread.id, boardId: input.id },
            authors: { thread: author(thread.authorId), openingPost: author(thread.firstPost.authorId) },
            media: { state: 'none', images: [] },
            interaction: {
              target: { kind: 'thread', id: thread.id },
              counts: { state: 'unavailable' },
              viewer: { state: 'not-applicable' },
            },
            comments: { state: 'unavailable' },
            actions: { reply: advice, react: advice, share: 'available' },
          })),
          next: null,
          rankRefreshedAt: null,
          reactionsAsOf: null,
          viewer: { participation: advice },
          actions: { createThread: advice },
        });
      }
      throw new Error(`Unexpected Board fixture request ${pathname}`);
    },
  });
  const loaded = await loadBoardPageWithAuthors(
    client,
    {
      id: input.id,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.sort ? { sort: input.sort } : {}),
    },
    input.credentialMode === 'session' ? 'Bearer original-session' : undefined,
  );
  return {
    ...loaded,
    board: {
      ...loaded.board,
      title: `${label} Board`,
      visibility: input.credentialMode === 'session' ? 'protected' : 'public',
    },
    threads: {
      ...loaded.threads,
      threads: loaded.threads.threads.map((thread) => ({
        ...thread,
        title: `${label} Thread`,
        firstPost: { ...thread.firstPost, body: fromPlainText(`${label} opening text`, 'blocks') },
      })),
    },
  };
}

async function resolveRead(index: number, label: string) {
  const call = calls[index]!;
  const page = await pageFor(call.input, label);
  const session = call.session;
  const readerOrigin =
    call.input.credentialMode === 'anonymous'
      ? { kind: 'anonymous' as const }
      : session?.state === 'signed-in' && session.subject
        ? {
            kind: 'session' as const,
            subject: session.subject,
            csrfFingerprint: await csrfFingerprint(session.csrfToken),
          }
        : { kind: 'anonymous' as const };
  call.result.resolve({ page, readerOrigin });
  await call.result.promise;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function start(operation: () => Promise<unknown>) {
  let pending!: Promise<unknown>;
  await act(async () => {
    pending = operation();
    await Promise.resolve();
    await Promise.resolve();
  });
  void pending.catch(() => {});
  return { pending };
}

function resolved(router: ReturnType<typeof createRouter>) {
  return new Promise<void>((resolve) => {
    let stop = () => {};
    stop = router.subscribe('onResolved', () => {
      stop();
      resolve();
    });
  });
}

function visible(host: HTMLElement, label: string) {
  expect(host.textContent).toContain(`${label} Board`);
  expect(host.textContent).toContain(`${label} Thread`);
  expect(host.textContent).toContain('Mira Okabe');
}

function absent(host: HTMLElement, ...labels: string[]) {
  for (const label of labels) {
    expect(host.textContent).not.toContain(`${label} Board`);
    expect(host.textContent).not.toContain(`${label} Thread`);
    expect(host.textContent).not.toContain(`${label} opening text`);
  }
}

test('Complete Board listing page caller lifetime through actual route/query/render composition', async () => {
  calls.length = 0;
  await setLocale('en', { reload: false });

  // The server-produced anonymous page crosses one real render/hydration boundary and remains public.
  const anonymousClient = makeQueryClient({ state: 'signed-in', subject: accountId, csrfToken: 'original-csrf' });
  const anonymousRouter = makeRouter(anonymousClient, {
    id: boardA,
    mode: 'anonymous',
    session: { state: 'signed-in', subject: accountId, csrfToken: 'original-csrf' },
  });
  const { pending: anonymousLoad } = await noWindowAsync(() => start(() => anonymousRouter.load()));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.input).toEqual({ id: boardA, credentialMode: 'anonymous' });
  await resolveRead(0, 'Anonymous public');
  await anonymousLoad;

  const anonymousHtml = noWindow(() => renderToString(app(anonymousClient, anonymousRouter)));
  expect(anonymousHtml).toContain('Anonymous public Board');
  expect(anonymousHtml).toContain('Anonymous public Thread');
  const anonymousHost = window.document.createElement('main') as unknown as HTMLElement;
  anonymousHost.innerHTML = anonymousHtml;
  window.document.body.append(anonymousHost);
  let anonymousRoot = hydrateRoot(anonymousHost, app(anonymousClient, anonymousRouter));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Anonymous public');
  await act(async () => anonymousRoot.render(app(anonymousClient, anonymousRouter)));
  visible(anonymousHost, 'Anonymous public');

  // Root's existing anonymous-to-session refresh changes the read mode and starts a new caller visit.
  const privateRefresh = resolved(anonymousRouter);
  anonymousRouter.update({ context: { queryClient: anonymousClient, credentialMode: 'session' } });
  const { pending: privateLoad } = await start(() => anonymousRouter.invalidate());
  absent(anonymousHost, 'Anonymous public');
  expect(calls).toHaveLength(2);
  expect(calls[1]!.input).toEqual({ id: boardA, credentialMode: 'session' });
  await resolveRead(1, 'Signed in initial');
  await privateLoad;
  await privateRefresh;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Signed in initial');

  // A same-account CSRF replacement retires the ready result and its private query entry, then a fresh visit works.
  const replacementDone = resolved(anonymousRouter);
  await act(async () => {
    anonymousClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: accountId,
      csrfToken: 'replacement-csrf',
    });
  });
  absent(anonymousHost, 'Signed in initial');
  expect(calls).toHaveLength(3);
  expect(calls[2]!.input).toEqual({ id: boardA, credentialMode: 'session' });
  const boardPages = anonymousClient.getQueryCache().findAll({ queryKey: ['board-page', boardA] });
  expect(boardPages.filter((query) => query.queryKey[4] === 'session')).toHaveLength(1);
  await resolveRead(2, 'Signed in replacement');
  await replacementDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Signed in replacement');

  // Query cache updates are monotonic across signed-out and away/back batches, even for the same account.
  const signOutDone = resolved(anonymousRouter);
  await act(async () => {
    anonymousClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  });
  absent(anonymousHost, 'Signed in replacement');
  expect(calls).toHaveLength(3);
  await signOutDone;

  await act(async () => {
    anonymousClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: accountId,
      csrfToken: 'replacement-csrf',
    });
  });
  const restoredDone = resolved(anonymousRouter);
  const { pending: restoredLoad } = await start(() => anonymousRouter.invalidate());
  expect(calls).toHaveLength(4);
  expect(calls[3]!.input.credentialMode).toBe('session');
  await resolveRead(3, 'Signed in after sign out');
  await restoredLoad;
  await restoredDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Signed in after sign out');

  const awayBackDone = resolved(anonymousRouter);
  const { notifyManager } = await import('@tanstack/react-query');
  await act(async () => {
    notifyManager.batch(() => {
      anonymousClient.setQueryData(sessionQuery.queryKey, {
        state: 'signed-out',
        subject: null,
        csrfToken: null,
      });
      anonymousClient.setQueryData(sessionQuery.queryKey, {
        state: 'signed-in',
        subject: accountId,
        csrfToken: 'replacement-csrf',
      });
    });
  });
  absent(anonymousHost, 'Signed in after sign out');
  expect(calls).toHaveLength(5);
  await resolveRead(4, 'Signed in after away back');
  await awayBackDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Signed in after away back');

  // Cursor, sort, Board and locale transitions retire the prior page before their deferred reads settle.
  const routeChangeDone = resolved(anonymousRouter);
  const { pending: routeChange } = await start(() =>
    anonymousRouter.navigate({
      to: '/boards/$id',
      params: { id: boardA },
      search: { cursor: 'native-cursor-2', sort: 'hot' },
    }),
  );
  absent(anonymousHost, 'Signed in after away back');
  expect(calls).toHaveLength(6);
  expect(calls[5]!.input).toEqual({
    id: boardA,
    cursor: 'native-cursor-2',
    sort: 'hot',
    credentialMode: 'session',
  });
  await resolveRead(5, 'Cursor and hot');
  await routeChange;
  await routeChangeDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Cursor and hot');

  const boardChangeDone = resolved(anonymousRouter);
  const { pending: boardChange } = await start(() =>
    anonymousRouter.navigate({
      to: '/boards/$id',
      params: { id: boardB },
      search: { cursor: 'native-cursor-2', sort: 'hot' },
    }),
  );
  absent(anonymousHost, 'Cursor and hot');
  expect(calls).toHaveLength(7);
  expect(calls[6]!.input.id).toBe(boardB);
  await resolveRead(6, 'Second Board');
  await boardChange;
  await boardChangeDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'Second Board');

  await setLocale('fr', { reload: false });
  const localeDone = resolved(anonymousRouter);
  const { pending: localeLoad } = await start(() => anonymousRouter.invalidate());
  absent(anonymousHost, 'Second Board');
  expect(calls).toHaveLength(8);
  await resolveRead(7, 'French Board visit');
  await localeLoad;
  await localeDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(anonymousHost, 'French Board visit');
  await setLocale('en', { reload: false });

  // A deferred private response that completes after its captured session changes cannot be cached or published.
  const queuedClient = makeQueryClient({ state: 'signed-in', subject: accountId, csrfToken: 'queued-original' });
  const queuedRouter = makeRouter(queuedClient, {
    id: boardA,
    mode: 'session',
    session: { state: 'signed-in', subject: accountId, csrfToken: 'queued-original' },
  });
  const { pending: queuedLoad } = await start(() => queuedRouter.load());
  expect(calls).toHaveLength(9);
  await act(async () => {
    queuedClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: accountId,
      csrfToken: 'queued-replacement',
    });
  });
  await resolveRead(8, 'Obsolete queued result');
  await queuedLoad.catch(() => {});
  expect(queuedClient.getQueryCache().findAll({ queryKey: ['board-page', boardA] })).toHaveLength(0);
  expect(calls).toHaveLength(9);

  // Error retry is tied to the error visit's mounted connection; a current visit can still retry successfully.
  const errorClient = makeQueryClient({ state: 'signed-in', subject: accountId, csrfToken: 'error-original' });
  const errorRouter = makeRouter(errorClient, {
    id: boardA,
    mode: 'session',
    session: { state: 'signed-in', subject: accountId, csrfToken: 'error-original' },
  });
  const errorHost = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(errorHost);
  const { pending: errorFirst } = await start(() => errorRouter.load());
  expect(calls).toHaveLength(10);
  calls[9]!.result.reject(new Error('deferred Board page error'));
  await errorFirst.catch(() => {});
  let errorRoot = createRoot(errorHost);
  await act(async () => errorRoot.render(app(errorClient, errorRouter)));
  const oldRetry = errorHost.querySelector('button');
  expect(oldRetry).not.toBeNull();
  await act(async () => {
    errorClient.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: accountId,
      csrfToken: 'error-replacement',
    });
    oldRetry!.click();
  });
  expect(calls).toHaveLength(10);

  const freshRetryDone = resolved(errorRouter);
  const { pending: freshVisit } = await start(() => errorRouter.invalidate());
  expect(calls).toHaveLength(11);
  calls[10]!.result.reject(new Error('current retry source error'));
  await freshVisit.catch(() => {});
  await act(async () => errorRoot.render(app(errorClient, errorRouter)));
  const currentRetry = errorHost.querySelector('button');
  expect(currentRetry).not.toBeNull();
  const retryVisitDone = resolved(errorRouter);
  await act(async () => currentRetry!.click());
  expect(calls).toHaveLength(12);
  await resolveRead(11, 'Current explicit retry');
  await retryVisitDone;
  await freshRetryDone.catch(() => {});
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(errorHost, 'Current explicit retry');

  // Remounting a retired private loader result cannot revive it; a new loader read supplies the new visit.
  await act(async () => errorRoot.unmount());
  await Promise.resolve();
  errorRoot = createRoot(errorHost);
  const remountDone = resolved(errorRouter);
  await act(async () => errorRoot.render(app(errorClient, errorRouter)));
  absent(errorHost, 'Current explicit retry');
  expect(calls).toHaveLength(13);
  await resolveRead(12, 'Fresh remount');
  await remountDone;
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(errorHost, 'Fresh remount');

  // A ready signed-in route also survives a server render and its matching hydration visit.
  const signedClient = makeQueryClient({ state: 'signed-in', subject: accountId, csrfToken: null });
  const signedRouter = makeRouter(signedClient, {
    id: boardA,
    mode: 'session',
    session: { state: 'signed-in', subject: accountId, csrfToken: null },
  });
  const { pending: signedLoad } = await noWindowAsync(() => start(() => signedRouter.load()));
  expect(calls).toHaveLength(14);
  expect(calls[13]!.input).toEqual({ id: boardA, credentialMode: 'session' });
  await resolveRead(13, 'Signed in server page');
  await signedLoad;
  const signedHtml = noWindow(() => renderToString(app(signedClient, signedRouter)));
  expect(signedHtml).toContain('Signed in server page Board');
  const signedHost = window.document.createElement('main') as unknown as HTMLElement;
  signedHost.innerHTML = signedHtml;
  window.document.body.append(signedHost);
  const signedRoot = hydrateRoot(signedHost, app(signedClient, signedRouter));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  visible(signedHost, 'Signed in server page');

  await act(async () => {
    anonymousRoot.unmount();
    errorRoot.unmount();
    signedRoot.unmount();
  });
  await Promise.resolve();
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
