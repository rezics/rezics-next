import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement, StrictMode, act } from 'react';
import type { QueryClient as QueryClientType } from '@tanstack/react-query';
import type { BoardPageLoadResult, BoardPageCallerInput } from '../src/threads/board-page-caller';
import type { MyRealmsPage } from '../src/community/space';
import type { MyRealmsVisit } from '../src/community/my-realms-caller';
import boardRecording from '../src/kernel/recorded/board.json';
import threadsRecording from '../src/kernel/recorded/board-threads.json';
import accountsRecording from '../src/kernel/recorded/accounts.json';
import * as start from '../.storybook/react-start';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
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

type ReaderState = { subject: string; accessToken: string; csrfToken: string | null };
type NativeCall = {
  method: string;
  path: string;
  cursor: string | null;
  sort: string | null;
  limit: string | null;
  authorization: string | null;
  csrfToken: string | null;
};
type NativePause = {
  path: string;
  entered: Deferred<void>;
  release: Deferred<void>;
  realmsSnapshot?: {
    items: Array<{ realmId: string; name: string; description?: string | null }>;
    next: string | null;
  };
};

const sessionId = 'a'.repeat(43);
let reader: ReaderState = { subject: 'reader-a', accessToken: 'access-a', csrfToken: 'csrf-a' };
let activeRequest = new Request('https://site.test/en/boards/board-a', {
  headers: { cookie: `__Host-rezics_session=${sessionId}` },
});
let nativePause: NativePause | undefined;
let nativeCalls: NativeCall[] = [];
let sessionPreparationCalls = 0;
let myRealmItems: Array<{ realmId: string; name: string; description?: string | null }> = [
  {
    realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000401',
    name: 'Reader A realm',
    description: 'Private A description',
  },
  { realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000404', name: 'Reader A second realm' },
];
let myRealmNext: string | null = 'native-next';
let recoverCursor = false;
let protectedBoard = false;
let deniedRealms = false;
const realmRecoveryCalls: string[] = [];

const sessionStore = {
  credential: async () => {
    sessionPreparationCalls++;
    return {
      status: 'active' as const,
      accessToken: reader.accessToken,
      subject: reader.subject,
      csrfToken: reader.csrfToken,
    };
  },
  credentialIfFresh: async () => {
    sessionPreparationCalls++;
    return {
      status: 'active' as const,
      accessToken: reader.accessToken,
      subject: reader.subject,
      csrfToken: reader.csrfToken,
    };
  },
  signedIn: async () => ({ signedIn: true, subject: reader.subject, csrfToken: reader.csrfToken }),
};
const environment = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid profile',
  WEBSITE_CLIENT_ID: 'web-client',
  WEBSITE_CLIENT_KEY: 'configured-test-key',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => sessionStore,
  },
};

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => activeRequest,
  setResponseHeader: () => undefined,
  setResponseStatus: () => undefined,
}));
mock.module('cloudflare:workers', () => ({ env: environment }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards/board-a' });
window.document.documentElement.lang = 'en';
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Event: window.Event,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const previousFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization');
  nativeCalls.push({
    method: request.method,
    path: url.pathname,
    cursor: url.searchParams.get('cursor'),
    sort: url.searchParams.get('sort'),
    limit: url.searchParams.get('limit'),
    authorization,
    csrfToken: request.headers.get('x-csrf-token'),
  });
  let pausedRequest: NativePause | undefined;
  if (nativePause && url.pathname === nativePause.path) {
    const pending = nativePause;
    nativePause = undefined;
    pausedRequest = pending;
    if (url.pathname === '/v1/me/realms') {
      pending.realmsSnapshot = { items: structuredClone(myRealmItems), next: myRealmNext };
    }
    pending.entered.resolve();
    await pending.release.promise;
  }
  if (url.pathname === `/v1/boards/${boardRecording.board.id}`) {
    if (!authorization && protectedBoard)
      return Response.json({ detail: 'Not found' }, { status: 404 });
    return Response.json({
      ...boardRecording,
      board: {
        ...boardRecording.board,
        id: boardRecording.board.id,
        title: authorization ? 'Reader A protected Board' : 'Public Board',
        visibility: authorization ? 'protected' : 'public',
      },
    });
  }
  if (url.pathname === `/v1/boards/${boardRecording.board.id}/threads`)
    return Response.json({
      threads: threadsRecording.threads.map((thread) => ({
        ...thread,
        boardId: boardRecording.board.id,
        title: authorization ? 'Reader A private thread' : 'Public thread',
      })),
      next: url.searchParams.get('cursor') === 'sparse' ? 'opaque-next-page' : null,
    });
  if (url.pathname === '/v1/accounts') return Response.json(accountsRecording);
  if (url.pathname === '/v1/me/realms') {
    const cursor = url.searchParams.get('cursor');
    realmRecoveryCalls.push(cursor ?? '');
    if (recoverCursor && cursor === 'expired-cursor') return Response.json({ detail: 'Expired cursor' }, { status: 409 });
    if (deniedRealms) return Response.json({ detail: 'Denied' }, { status: 403 });
    return Response.json({
      items: pausedRequest?.realmsSnapshot?.items ?? myRealmItems,
      next: pausedRequest?.realmsSnapshot ? pausedRequest.realmsSnapshot.next : myRealmNext,
    });
  }
  throw new Error(`Unexpected native compatibility request ${request.method} ${url.pathname}`);
}) as typeof fetch;

const {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
  dehydrate,
  hydrate,
  notifyManager,
} = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { Route: BoardRoute } = await import('../src/routes/boards/$id');
const { Route: MyRealmsRoute } = await import('../src/routes/realms/index');
const { BoardPageCallerHost } = await import('../src/threads/board-page-caller');
const { BoardCommunity } = await import('../src/threads/board-community');
const { MyRealmsCallerHost } = await import('../src/community/my-realms-caller');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');

const boardLoader = (BoardRoute as unknown as { options: { loader: (args: unknown) => Promise<BoardPageLoadResult> } })
  .options.loader;
const myRealmsLoader = (
  MyRealmsRoute as unknown as {
    options: { loader: (args: unknown) => Promise<{ page: MyRealmsPage; visit: MyRealmsVisit }> };
  }
).options.loader;

function sessionValue(value: ReaderState = reader) {
  return { state: 'signed-in' as const, subject: value.subject, csrfToken: value.csrfToken };
}

function requestFor(path: string, options: { explicitAuthorization?: string; anonymous?: boolean } = {}) {
  const headers = new Headers();
  if (!options.anonymous) headers.set('cookie', `__Host-rezics_session=${sessionId}`);
  if (options.explicitAuthorization) headers.set('authorization', options.explicitAuthorization);
  activeRequest = new Request(`https://site.test/en/${path}`, { headers });
}

function clientFor(value: ReaderState = reader) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, sessionValue(value));
  return client;
}

function serialize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function wireQueries(client: QueryClientType) {
  return serialize(
    dehydrate(client, {
      shouldDehydrateQuery: (query) => query.queryKey[0] !== 'session',
    }),
  );
}

function inputForBoard(mode: 'anonymous' | 'session' = 'session', cursor?: string, sort?: 'hot' | 'new') {
  return {
    id: boardRecording.board.id,
    ...(cursor === undefined ? {} : { cursor }),
    ...(sort === undefined ? {} : { sort }),
    locale: getLocale(),
    credentialMode: mode,
  } satisfies BoardPageCallerInput;
}

async function loadBoard(
  client: QueryClientType,
  mode: 'anonymous' | 'session' = 'session',
  cursor?: string,
  sort?: 'hot' | 'new',
) {
  const input = inputForBoard(mode, cursor, sort);
  return boardLoader({
    params: { id: input.id },
    deps: { ...(cursor === undefined ? {} : { cursor }), ...(sort === undefined ? {} : { sort }) },
    abortController: new AbortController(),
    context: { queryClient: client, credentialMode: mode },
  });
}

async function loadMyRealms(client: QueryClientType, cursor?: string) {
  return myRealmsLoader({
    context: { queryClient: client, credentialMode: 'session' },
    deps: { ...(cursor === undefined ? {} : { cursor }) },
    abortController: new AbortController(),
  });
}

type TestRouterContext = { queryClient: QueryClientType; credentialMode: 'anonymous' | 'session' };

function makeHost(
  client: QueryClientType,
  mode: TestRouterContext['credentialMode'],
  path: string,
  view: () => unknown,
) {
  const rootRoute = createRootRouteWithContext<TestRouterContext>()({ component: view as never });
  const router = createRouter({
    routeTree: rootRoute,
    context: { queryClient: client, credentialMode: mode },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(StrictMode, null, createElement(RouterProvider, { router })),
  );
  return { client, host, root, router, tree };
}

async function mount(surface: ReturnType<typeof makeHost>) {
  await surface.router.load();
  await act(async () => surface.root.render(surface.tree));
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function until(predicate: () => boolean, label: string) {
  for (let turn = 0; turn < 40; turn++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterAll(async () => {
  await window.happyDOM.close();
  globalThis.fetch = previousFetch;
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Board and MyRealms preserve same-prepared reader provenance across independent QueryClient hydration and lifetime changes', async () => {
  nativeCalls = [];
  realmRecoveryCalls.length = 0;
  recoverCursor = false;
  protectedBoard = false;
  deniedRealms = false;
  await setLocale('en', { reload: false });

  // The real Board route loader binds the original cache observation, calls its real server reader, and remembers
  // canonical thread titles before returning its serializable loader receipt.
  reader = { subject: 'reader-a', accessToken: 'access-a', csrfToken: 'csrf-a' };
  requestFor('boards/board-a');
  const serverBoardClient = clientFor();
  const preparationsBeforeBoardRead = sessionPreparationCalls;
  const boardResult = await loadBoard(serverBoardClient, 'session', 'sparse', 'new');
  expect(sessionPreparationCalls - preparationsBeforeBoardRead).toBe(1);
  expect(boardResult.caller.readerOrigin).toEqual({
    kind: 'session',
    subject: 'reader-a',
    csrfFingerprint: await (async () => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('token\0csrf-a'));
      return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    })(),
  });
  expect(boardResult.caller.expectedReader?.subject).toBe('reader-a');
  expect(boardResult.threads.next).toBe('opaque-next-page');
  expect(nativeCalls.filter((call) => call.path.endsWith('/threads')).map((call) => call.cursor)).toEqual(['sparse']);
  expect(nativeCalls.filter((call) => call.path.endsWith('/threads')).map((call) => call.sort)).toEqual([null]);
  expect(nativeCalls.filter((call) => call.path.endsWith('/threads')).map((call) => call.limit)).toEqual([null]);
  expect(nativeCalls.filter((call) => call.path.endsWith('/threads')).every((call) => call.authorization === 'Bearer access-a'))
    .toBe(true);
  expect(nativeCalls.filter((call) => call.path === `/v1/boards/${boardRecording.board.id}`).every((call) => call.method === 'GET'))
    .toBe(true);
  expect(JSON.stringify(boardResult)).not.toContain('access-a');
  expect(JSON.stringify(boardResult)).not.toContain('csrf-a');

  const boardWire = serialize({ result: boardResult, queries: wireQueries(serverBoardClient) });
  expect(JSON.stringify(boardWire)).not.toContain('access-a');
  expect(JSON.stringify(boardWire)).not.toContain('csrf-a');
  const browserBoardClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  hydrate(browserBoardClient, boardWire.queries);
  browserBoardClient.setQueryData(sessionQuery.queryKey, sessionValue());
  const boardSurface = makeHost(
    browserBoardClient,
    'session',
    `/en/boards/${boardRecording.board.id}?cursor=sparse&sort=new`,
    () =>
      createElement(
        BoardPageCallerHost,
        { result: boardWire.result, input: inputForBoard('session', 'sparse', 'new') },
        (page) => createElement(BoardCommunity, { page, sort: 'new' }),
      ),
  );
  await mount(boardSurface);
  await until(() => boardSurface.host.textContent?.includes('Reader A protected Board') ?? false, 'the transferred Board page');
  expect(boardSurface.host.querySelector(`a[href*="/threads/${threadsRecording.threads[0]!.id}/"]`)).not.toBeNull();

  const mismatchedBoardClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  hydrate(mismatchedBoardClient, boardWire.queries);
  mismatchedBoardClient.setQueryData(
    sessionQuery.queryKey,
    sessionValue({ subject: 'reader-b', accessToken: 'access-b', csrfToken: 'csrf-b' }),
  );
  const mismatchedBoardResult = serialize(boardWire.result);
  const mismatchedBoardSurface = makeHost(
    mismatchedBoardClient,
    'session',
    `/en/boards/${boardRecording.board.id}?cursor=sparse&sort=new`,
    () =>
      createElement(
        BoardPageCallerHost,
        { result: mismatchedBoardResult, input: inputForBoard('session', 'sparse', 'new') },
        (page) => createElement(BoardCommunity, { page, sort: 'new' }),
      ),
  );
  await mount(mismatchedBoardSurface);
  await until(
    () => mismatchedBoardClient.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] }).length === 0,
    'the mismatched hydrated Board cache retirement',
  );
  expect(mismatchedBoardSurface.host.textContent).not.toContain('Reader A protected Board');

  // A real anonymous read remains anonymous. Its native result is public, and its receipt cannot borrow the signed-in
  // browser QueryClient's subject or credential.
  requestFor('boards/board-a');
  const anonymousClient = clientFor();
  const preparationsBeforeAnonymousRead = sessionPreparationCalls;
  const { duringPublicCacheRender } = await import('../src/security/page-cache');
  const anonymousBoard = await duringPublicCacheRender(activeRequest, () => loadBoard(anonymousClient, 'anonymous'));
  expect(sessionPreparationCalls - preparationsBeforeAnonymousRead).toBe(0);
  expect(anonymousBoard.caller.readerOrigin).toEqual({ kind: 'anonymous' });
  expect(anonymousBoard.board.visibility).toBe('public');
  expect(nativeCalls.filter((call) => call.path === `/v1/boards/${boardRecording.board.id}`).at(-1)?.authorization).toBeNull();
  requestFor('realms', { anonymous: true });
  const { readMyRealmsPage } = await import('../src/community/space-actions');
  const realmCallsBeforeAnonymousAction = nativeCalls.filter((call) => call.path === '/v1/me/realms').length;
  const anonymousRealms = await readMyRealmsPage({ data: {} });
  expect(anonymousRealms).toMatchObject({ signedIn: false, realms: [], next: null, readerOrigin: { kind: 'anonymous' } });
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms')).toHaveLength(realmCallsBeforeAnonymousAction);

  protectedBoard = true;
  const deniedBoardClient = clientFor();
  await expect(loadBoard(deniedBoardClient, 'anonymous')).rejects.toThrow();
  expect(deniedBoardClient.getQueryData(['board-page', boardRecording.board.id, null, null, 'anonymous'])).toBeUndefined();
  protectedBoard = false;

  // A separately hydrated MyRealms cache consumes the actual action and query result. The native order, next cursor,
  // private description and current destination survive wire serialization.
  requestFor('realms');
  const serverRealmsClient = clientFor();
  const preparationsBeforeRealmsRead = sessionPreparationCalls;
  const realmNativeCallsBefore = nativeCalls.filter((call) => call.path === '/v1/me/realms').length;
  const realmsResult = await loadMyRealms(serverRealmsClient);
  expect(sessionPreparationCalls - preparationsBeforeRealmsRead).toBe(1);
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms')).toHaveLength(realmNativeCallsBefore + 1);
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms').at(-1)?.limit).toBeNull();
  expect(realmsResult.page.readerOrigin?.kind).toBe('session');
  expect(realmsResult.page.realms.map((realm) => realm.name)).toEqual(['Reader A realm', 'Reader A second realm']);
  expect(realmsResult.page.next).toBe('native-next');
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms').at(-1)?.authorization).toBe('Bearer access-a');
  requestFor('realms?cursor=native-next');
  const continuationClient = clientFor();
  const continuation = await loadMyRealms(continuationClient, 'native-next');
  expect(continuation.page.realms[0]?.name).toBe('Reader A realm');
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms').at(-1)?.cursor).toBe('native-next');
  expect(JSON.stringify(realmsResult)).not.toContain('access-a');
  expect(JSON.stringify(realmsResult)).not.toContain('csrf-a');
  const realmsWire = serialize({ result: realmsResult, queries: wireQueries(serverRealmsClient) });
  expect(JSON.stringify(realmsWire)).not.toContain('access-a');
  expect(JSON.stringify(realmsWire)).not.toContain('csrf-a');
  const browserRealmsClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  hydrate(browserRealmsClient, realmsWire.queries);
  browserRealmsClient.setQueryData(sessionQuery.queryKey, sessionValue());
  const realmsSurface = makeHost(browserRealmsClient, 'session', '/en/realms', () =>
    createElement(MyRealmsCallerHost, { initial: realmsWire.result, cursor: undefined }),
  );
  await mount(realmsSurface);
  await until(() => realmsSurface.host.textContent?.includes('Private A description') ?? false, 'the transferred MyRealms page');
  expect(realmsSurface.host.querySelector('a[href="/en/realms/0192f3a0-6c1e-7b2a-9d4e-000000000401"]')).not.toBeNull();
  expect(realmsSurface.host.querySelector('a[href*="cursor=native-next"]')).not.toBeNull();

  const { myRealmsCallerForVisit } = await import('../src/community/my-realms-caller');
  const mismatchedRealmsClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  hydrate(mismatchedRealmsClient, realmsWire.queries);
  mismatchedRealmsClient.setQueryData(
    sessionQuery.queryKey,
    sessionValue({ subject: 'reader-b', accessToken: 'access-b', csrfToken: 'csrf-b' }),
  );
  const mismatchedRealmsCaller = myRealmsCallerForVisit(mismatchedRealmsClient, realmsWire.result.visit);
  mismatchedRealmsCaller.verifyHydration();
  expect(mismatchedRealmsCaller.isCurrent()).toBe(false);
  expect(mismatchedRealmsClient.getQueryData(['my-realms', ''])).toBeUndefined();

  // A hidden expected/actual mismatch and an explicit credential without a prepared subject cannot admit private
  // reader data for either route.
  const expectedA = clientFor({ subject: 'reader-a', accessToken: 'unused-a', csrfToken: 'csrf-a' });
  reader = { subject: 'reader-b', accessToken: 'access-b', csrfToken: 'csrf-b' };
  requestFor('boards/board-a');
  await expect(loadBoard(expectedA, 'session')).rejects.toThrow();
  expect(expectedA.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] })).toHaveLength(0);
  const expectedRealmA = clientFor({ subject: 'reader-a', accessToken: 'unused-a', csrfToken: 'csrf-a' });
  requestFor('realms');
  await expect(loadMyRealms(expectedRealmA)).rejects.toThrow();
  expect(expectedRealmA.getQueryData(['my-realms', ''])).toBeUndefined();

  reader = { subject: 'reader-a', accessToken: 'access-a', csrfToken: 'csrf-a' };
  requestFor('boards/board-a', { explicitAuthorization: 'Bearer explicit-reader' });
  const explicitBoardClient = clientFor();
  await expect(loadBoard(explicitBoardClient, 'session')).rejects.toThrow();
  expect(explicitBoardClient.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] })).toHaveLength(0);
  requestFor('realms', { explicitAuthorization: 'Bearer explicit-reader' });
  const explicitRealmsClient = clientFor();
  await expect(loadMyRealms(explicitRealmsClient)).rejects.toThrow();
  expect(explicitRealmsClient.getQueryData(['my-realms', ''])).toBeUndefined();

  // A signed-in reader with no CSRF token can still perform the original read-only GET. The envelope contains the
  // fingerprint of null, and no write or CSRF header is synthesized.
  reader = { subject: 'reader-a', accessToken: 'access-a', csrfToken: null };
  requestFor('boards/board-a');
  const nullCsrfBoardClient = clientFor();
  const nullCsrfBoard = await loadBoard(nullCsrfBoardClient, 'session');
  expect(nullCsrfBoard.caller.readerOrigin.kind).toBe('session');
  expect(nativeCalls.filter((call) => call.path.startsWith('/v1/boards/')).at(-1)?.csrfToken).toBeNull();
  requestFor('realms');
  const nullCsrfRealmsClient = clientFor();
  const nullCsrfRealms = await loadMyRealms(nullCsrfRealmsClient);
  expect(nullCsrfRealms.page.readerOrigin?.kind).toBe('session');
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms').at(-1)?.method).toBe('GET');
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms').at(-1)?.csrfToken).toBeNull();

  // Cursor recovery is the same native first-page recovery, with one authenticated bounded request per attempt.
  reader = { subject: 'reader-a', accessToken: 'access-a', csrfToken: null };
  requestFor('realms?cursor=expired-cursor');
  recoverCursor = true;
  const recoveryClient = clientFor();
  const recovered = await loadMyRealms(recoveryClient, 'expired-cursor');
  expect(recovered.page.realms[0]?.name).toBe('Reader A realm');
  expect(realmRecoveryCalls.slice(-2)).toEqual(['expired-cursor', '']);
  recoverCursor = false;

  // A sparse empty reader result and a cursor continuation stay distinct from a denied page and retain the native
  // cursor order. No caller issues a per-row request.
  myRealmItems = [];
  myRealmNext = 'empty-page-next';
  requestFor('realms?cursor=opaque-cursor');
  const sparseClient = clientFor();
  const sparse = await loadMyRealms(sparseClient, 'opaque-cursor');
  expect(sparse.page.signedIn).toBe(true);
  expect(sparse.page.realms).toEqual([]);
  expect(sparse.page.next).toBe('empty-page-next');
  deniedRealms = true;
  requestFor('realms');
  const deniedRealmsClient = clientFor();
  await expect(loadMyRealms(deniedRealmsClient)).rejects.toThrow();
  expect(deniedRealmsClient.getQueryData(['my-realms', ''])).toBeUndefined();
  deniedRealms = false;
  myRealmItems = [
    { realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000401', name: 'Reader A realm', description: 'Private A description' },
    { realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000404', name: 'Reader A second realm' },
  ];
  myRealmNext = 'native-next';

  // Session fetch and observer notifications alone leave a ready visit usable. A successful equal-data replacement,
  // an error, removal or observed batched ABA advances the generation and retires it.
  const observerClient = clientFor();
  requestFor('boards/board-a');
  const observerBoard = await loadBoard(observerClient, 'session');
  const { isBoardPageResultCurrent } = await import('../src/threads/board-page-caller');
  const observerInput = inputForBoard('session');
  const observer = new QueryObserver(observerClient, sessionQuery);
  const stopObserver = observer.subscribe(() => undefined);
  expect(isBoardPageResultCurrent(observerClient, observerBoard, observerInput)).toBe(true);
  stopObserver();
  expect(isBoardPageResultCurrent(observerClient, observerBoard, observerInput)).toBe(true);
  const fetching = deferred<ReturnType<typeof sessionValue>>();
  const refresh = observerClient.fetchQuery({
    ...sessionQuery,
    staleTime: 0,
    queryFn: () => fetching.promise,
  });
  await Promise.resolve();
  expect(isBoardPageResultCurrent(observerClient, observerBoard, observerInput)).toBe(true);
  fetching.resolve(sessionValue());
  await refresh;
  expect(isBoardPageResultCurrent(observerClient, observerBoard, observerInput)).toBe(false);

  const observerRealmsClient = clientFor();
  requestFor('realms');
  const observerRealmsResult = await loadMyRealms(observerRealmsClient);
  const observerRealmsCaller = myRealmsCallerForVisit(observerRealmsClient, observerRealmsResult.visit);
  const realmsObserver = new QueryObserver(observerRealmsClient, sessionQuery);
  const stopRealmsObserver = realmsObserver.subscribe(() => undefined);
  expect(observerRealmsCaller.isCurrent()).toBe(true);
  stopRealmsObserver();
  const realmsFetching = deferred<ReturnType<typeof sessionValue>>();
  const realmsRefresh = observerRealmsClient.fetchQuery({
    ...sessionQuery,
    staleTime: 0,
    queryFn: () => realmsFetching.promise,
  });
  await Promise.resolve();
  expect(observerRealmsCaller.isCurrent()).toBe(true);
  realmsFetching.resolve(sessionValue());
  await realmsRefresh;
  expect(observerRealmsCaller.isCurrent()).toBe(false);

  const boardReplacementClient = clientFor();
  requestFor('boards/board-a');
  const boardReplacementResult = await loadBoard(boardReplacementClient, 'session');
  const boardCachedRead = boardReplacementClient.getQueryData(boardReplacementResult.caller.queryKey as never);
  expect(boardCachedRead).toBeDefined();
  boardReplacementClient.setQueryData(
    boardReplacementResult.caller.queryKey as never,
    structuredClone(boardCachedRead) as never,
  );
  expect(isBoardPageResultCurrent(boardReplacementClient, boardReplacementResult, inputForBoard('session'))).toBe(false);
  expect(boardReplacementClient.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] })).toHaveLength(0);

  const realmsReplacementClient = clientFor();
  requestFor('realms');
  const realmsReplacementResult = await loadMyRealms(realmsReplacementClient);
  const realmsReplacementCaller = myRealmsCallerForVisit(realmsReplacementClient, realmsReplacementResult.visit);
  realmsReplacementClient.setQueryData(
    ['my-realms', ''],
    structuredClone(realmsReplacementResult.page),
  );
  expect(realmsReplacementCaller.isCurrent()).toBe(false);
  expect(realmsReplacementClient.getQueryData(['my-realms', ''])).toBeUndefined();

  const queryRemovalClient = clientFor();
  requestFor('realms');
  const queryRemovalResult = await loadMyRealms(queryRemovalClient);
  const queryRemovalCaller = myRealmsCallerForVisit(queryRemovalClient, queryRemovalResult.visit);
  queryRemovalClient.removeQueries({ queryKey: ['my-realms', ''], exact: true });
  expect(queryRemovalCaller.isCurrent()).toBe(false);

  const equalRealmsClient = clientFor();
  requestFor('realms');
  const equalRealmsResult = await loadMyRealms(equalRealmsClient);
  const equalRealmsCaller = myRealmsCallerForVisit(equalRealmsClient, equalRealmsResult.visit);
  await equalRealmsClient.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: async () => sessionValue() });
  expect(equalRealmsCaller.isCurrent()).toBe(false);
  expect(equalRealmsClient.getQueryData(['my-realms', ''])).toBeUndefined();

  const abaClient = clientFor();
  requestFor('realms');
  const abaResult = await loadMyRealms(abaClient);
  const abaCaller = myRealmsCallerForVisit(abaClient, abaResult.visit);
  await act(async () => {
    notifyManager.batch(() => {
      abaClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      abaClient.setQueryData(sessionQuery.queryKey, sessionValue());
    });
  });
  expect(abaCaller.isCurrent()).toBe(false);
  expect(abaClient.getQueryData(['my-realms', ''])).toBeUndefined();

  const removalClient = clientFor();
  requestFor('realms');
  const removalResult = await loadMyRealms(removalClient);
  const removalCaller = myRealmsCallerForVisit(removalClient, removalResult.visit);
  removalClient.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  expect(removalCaller.isCurrent()).toBe(false);
  expect(removalClient.getQueryData(['my-realms', ''])).toBeUndefined();

  const errorClient = clientFor();
  requestFor('realms');
  const errorResult = await loadMyRealms(errorClient);
  const errorCaller = myRealmsCallerForVisit(errorClient, errorResult.visit);
  await errorClient.fetchQuery({
    ...sessionQuery,
    staleTime: 0,
    queryFn: async () => {
      throw new Error('session refresh failed');
    },
  }).catch(() => undefined);
  expect(errorCaller.isCurrent()).toBe(false);
  expect(errorClient.getQueryData(['my-realms', ''])).toBeUndefined();

  const pendingRealmsClient = clientFor();
  myRealmItems = [{ realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000402', name: 'Old realm result' }];
  myRealmNext = 'old-next';
  requestFor('realms');
  const realmsPause = {
    path: '/v1/me/realms',
    entered: deferred<void>(),
    release: deferred<void>(),
  };
  nativePause = realmsPause;
  const staleRealmsRead = loadMyRealms(pendingRealmsClient);
  await realmsPause.entered.promise;
  pendingRealmsClient.setQueryData(sessionQuery.queryKey, sessionValue());
  myRealmItems = [{ realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000403', name: 'Fresh realm result' }];
  myRealmNext = 'fresh-next';
  requestFor('realms');
  const freshRealmsRead = loadMyRealms(pendingRealmsClient);
  await until(
    () => !!pendingRealmsClient.getQueryCache().find({ queryKey: ['my-realms', ''], exact: true }),
    'the newer MyRealms query object',
  );
  const freshQuery = pendingRealmsClient.getQueryCache().find({ queryKey: ['my-realms', ''], exact: true });
  realmsPause.release.resolve();
  await expect(staleRealmsRead).rejects.toThrow();
  const freshResult = await freshRealmsRead;
  expect(freshResult.page.realms[0]?.name).toBe('Fresh realm result');
  expect(pendingRealmsClient.getQueryCache().find({ queryKey: ['my-realms', ''], exact: true })).toBe(freshQuery);
  myRealmItems = [
    { realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000401', name: 'Reader A realm', description: 'Private A description' },
  ];
  myRealmNext = 'native-next';

  // The original native reader can be pending while the cache changes. Settle its transport before observing the
  // rejected loader, and confirm that its stale result never appears in a query cache.
  const pendingClient = clientFor();
  requestFor('boards/board-a');
  const pause = { path: `/v1/boards/${boardRecording.board.id}`, entered: deferred<void>(), release: deferred<void>() };
  nativePause = pause;
  const pendingRead = loadBoard(pendingClient, 'session');
  await pause.entered.promise;
  pendingClient.setQueryData(sessionQuery.queryKey, sessionValue());
  pause.release.resolve();
  await expect(pendingRead).rejects.toThrow();
  expect(pendingClient.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] })).toHaveLength(0);

  // The import/read queue guard prevents a now-stale MyRealms query from issuing a native request; a newer query
  // object survives the old operation's finally and conditional cache cleanup.
  const queuedClient = clientFor();
  requestFor('realms');
  const callsBeforeQueue = nativeCalls.filter((call) => call.path === '/v1/me/realms').length;
  const originalFetchQuery = queuedClient.fetchQuery.bind(queuedClient);
  queuedClient.fetchQuery = ((options: { queryKey?: readonly unknown[] }) => {
    const pending = originalFetchQuery(options as never);
    if (options.queryKey?.[0] === 'my-realms')
      queuedClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    return pending;
  }) as typeof queuedClient.fetchQuery;
  await expect(loadMyRealms(queuedClient)).rejects.toThrow();
  expect(nativeCalls.filter((call) => call.path === '/v1/me/realms')).toHaveLength(callsBeforeQueue);
  expect(queuedClient.getQueryData(['my-realms', ''])).toBeUndefined();

  // Effect replay keeps the original caller; a final cleanup retires it. Both caller APIs are the ones connected by
  // the production hosts, so no duplicate mount or hidden transport is introduced here.
  const replayClient = clientFor();
  requestFor('boards/board-a');
  const replayBoard = await loadBoard(replayClient, 'session');
  const replayInput = inputForBoard('session');
  const replayHost = makeHost(replayClient, 'session', `/en/boards/${replayInput.id}`, () =>
    createElement(
      BoardPageCallerHost,
      { result: replayBoard, input: replayInput },
      (page) => createElement(BoardCommunity, { page, sort: 'active' }),
    ),
  );
  await mount(replayHost);
  expect(replayHost.host.textContent).toContain('Reader A protected Board');
  await act(async () => replayHost.root.unmount());
  await Promise.resolve();
  expect(replayClient.getQueryCache().findAll({ queryKey: ['board-page', replayInput.id] })).toHaveLength(0);

  await act(async () => {
    await realmsSurface.root.unmount();
    await boardSurface.root.unmount();
    await mismatchedBoardSurface.root.unmount();
  });
  await Promise.resolve();
  expect(browserRealmsClient.getQueryData(['my-realms', ''])).toBeUndefined();
  expect(browserBoardClient.getQueryCache().findAll({ queryKey: ['board-page', boardRecording.board.id] })).toHaveLength(0);
  realmsSurface.host.remove();
  boardSurface.host.remove();
  mismatchedBoardSurface.host.remove();
  replayHost.host.remove();
  browserBoardClient.clear();
  browserRealmsClient.clear();
});
