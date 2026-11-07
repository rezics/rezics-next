import { afterAll, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname } from 'node:path';
import { act, StrictMode, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider, QueryObserver, dehydrate, hydrate } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { RealmBoard, PublishedSubject, SpacePageData } from '../src/community/space';
import type { RealmPageQueryResult, SpacePageQueryResult } from '../src/community/space-queries';
import type { SpacePageAdmission, SpacePageTarget } from '../src/community/space-page-lifetime';

// Authored UNRUN: real route queries, admission/lifetime code, actions, session preparation and native client.
// Only the Start request boundary, Worker bindings, kernel HTTP and definition HTTP transports are fixtures.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const requests = new AsyncLocalStorage<Request>();
let activeRequest: Request | undefined;

function createServerFn(options?: { method?: string }) {
  const delegate = start.createServerFn();
  const chain = {
    validator(validate: (input: unknown) => unknown) {
      delegate.validator(validate);
      return chain;
    },
    handler<T extends (...args: never[]) => unknown>(handler: T): T {
      const invoke = delegate.handler(handler);
      return ((input?: unknown) => {
        const request = requests.getStore() ?? activeRequest;
        if (!request) throw new Error(`No request for ${options?.method ?? 'GET'} server function`);
        return requests.run(request, () => invoke(input as never));
      }) as T;
    },
  };
  return chain;
}

const subject = 'reader-one';
const otherSubject = 'reader-two';
const address = 'atlas';
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const boardId = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
const oldSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000401';
const newSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000402';
const accessToken = 'private-access-token-for-test';
const csrfToken = 'private-csrf-token-for-test';
const credentialCsrf = 'credential-csrf-value';
const cookieId = 'a'.repeat(43);

let nativeSubject: string | null = subject;
let nativeAccessToken = accessToken;
let browserCsrfToken: string | null = csrfToken;
let credentialCsrfToken: string | null = credentialCsrf;
let nativeSpaceAddress: string | null = null;
let pageFailure: { path: string; status: number } | null = null;
let holdShelfReads = false;
let shelfFailure = new Map<string, number>();
let pendingShelfReads: { request: Request; work: ReturnType<typeof deferred<Response>>; settled: boolean }[] = [];
let nativeCalls: { path: string; cursor: string | null; authorization: string | null; limit: string | null }[] = [];

const sessions = {
  idFromName: (id: string) => id,
  get: () => ({
    signedIn: async () =>
      nativeSubject
        ? { signedIn: true, subject: nativeSubject, csrfToken: browserCsrfToken }
        : { signedIn: false, csrfToken: null },
    credential: async () =>
      nativeSubject
        ? {
            status: 'active',
            subject: nativeSubject,
            accessToken: nativeAccessToken,
            csrfToken: credentialCsrfToken,
          }
        : { status: 'absent' },
  }),
};

const env = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web-test',
  WEBSITE_CLIENT_KEY: 'unused-by-the-session-fixture',
  KERNEL_ORIGIN: 'https://kernel.test',
  SESSIONS: sessions,
};

mock.module('@tanstack/react-start', () => ({ ...start, createServerFn }));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => requests.getStore() ?? activeRequest ?? start.getRequest(),
}));
mock.module('cloudflare:workers', () => ({ env }));

function json(body: unknown, status = 200, problem = false) {
  return Response.json(body, {
    status,
    headers: problem ? { 'content-type': 'application/problem+json' } : undefined,
  });
}

function problem(status: number) {
  return json(
    {
      type: 'https://rezics.com/problems/test_failure',
      title: 'Test failure',
      status,
      code: 'test_failure',
      retryable: false,
      effect_status: 'not_applicable',
      request_id: '0192f3a0-6c1e-7b2a-9d4e-999999999999',
    },
    status,
    true,
  );
}

const boardWire = (title: string) => ({
  id: boardId,
  title,
  description: `${title} description`,
  purpose: 'discussion',
  visibility: 'published',
  availability: 'available',
});

const publicationWire = (id: string, publicationId: string) => ({
  realmId,
  subjectId: id,
  publicationId,
  subjectRevisionId: null,
  publishedAt: '2026-11-02T00:00:00.000Z',
  verdict: 'adopt',
});

function subjectWire(id: string, label: string) {
  return json({
    subject: {
      id,
      type: 'schema:Book',
      labels: { en: label },
      release: 'test-release',
      revision: 1,
      context: '0192f3a0-6c1e-7b2a-9d4e-000000000701',
      statements: {},
      aliases: {},
      descriptions: {},
      resolution: {},
    },
    related: {},
    summary: {
      id,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: label, language: 'en' },
      creativeWork: true,
      cover: null,
    },
  });
}

async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith('/v1/')) {
    const call = {
      path,
      cursor: url.searchParams.get('cursor'),
      authorization: request.headers.get('authorization'),
      limit: url.searchParams.get('limit'),
    };
    nativeCalls.push(call);
    if (pageFailure?.path === path) return problem(pageFailure.status);
    if (path.endsWith('/boards') || path.endsWith('/publications')) {
      const failure = shelfFailure.get(`${path}:${call.cursor ?? ''}`);
      if (failure) return problem(failure);
      if (holdShelfReads) {
        const work = deferred<Response>();
        pendingShelfReads.push({ request, work, settled: false });
        return work.promise;
      }
    }
    if (path === `/v1/spaceAddresses/${address}`) return json({ spaceId });
    if (path === `/v1/spaces/${spaceId}`)
      return json({
        space: {
          spaceId,
          realmId,
          state: 'active',
          headRevisionId: 'space-head-one',
          createdAt: '2026-11-02T00:00:00.000Z',
          creator: subject,
          predecessor: null,
          address: nativeSpaceAddress,
          title: 'Connected Space',
          summary: 'The original route read.',
          revisionCreatedAt: '2026-11-02T00:00:00.000Z',
          author: subject,
        },
      });
    const realmPath = `/v1/realms/${realmId}`;
    if (path === realmPath)
      return json({
        realm: {
          realmId,
          spaceId,
          state: 'active',
          visibility: 'public',
          contextId: '0192f3a0-6c1e-7b2a-9d4e-000000000701',
          title: 'Connected Realm',
          summary: 'Shelf continuation test.',
        },
      });
    if (path === `${realmPath}/boards`)
      return json(
        call.cursor ? { items: [boardWire('Native board')], next: null } : { items: [], next: 'board-first' },
      );
    if (path === `${realmPath}/publications`)
      return json(
        call.cursor
          ? { items: [publicationWire(newSubjectId, '0192f3a0-6c1e-7b2a-9d4e-000000000501')], next: null }
          : { items: [], next: 'publication-first' },
      );
    const subjectId = /^\/v1\/subjects\/([^/]+)$/.exec(path)?.[1];
    if (subjectId)
      return subjectId === oldSubjectId
        ? subjectWire(oldSubjectId, 'Obsolete publication')
        : subjectWire(subjectId, 'Native publication');
    if (path === '/v1/definitions/active') return json({ digest: 'test-release' });
    if (path === '/v1/definitions/releases/test-release')
      return json({
        digest: 'test-release',
        release: { types: { 'schema:Book': { labels: { en: 'Book' } } }, properties: {} },
      });
    return problem(404);
  }
  if (path === '/v1/definitions/active') return json({ digest: 'test-release' });
  if (path === '/v1/definitions/releases/test-release')
    return json({
      digest: 'test-release',
      release: { types: { 'schema:Book': { labels: { en: 'Book' } } }, properties: {} },
    });
  return problem(404);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = nativeFetch as typeof fetch;

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/atlas' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
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
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { sessionQuery } = await import('../src/session/query');
const { captureSpacePageAdmission, SpacePageLifetimeContext, SpacePageLifetimeHost, spacePageAdmissionIsCurrent } =
  await import('../src/community/space-page-lifetime');
const { useShelfList } = await import('../src/community/space-queries');
const { RealmShelf } = await import('../src/session/community-application');
const { readRealmBoards, readRealmPublications } = await import('../src/community/space-actions');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const { Route: spaceRoute } = await import('../src/routes/spaces/$address');
const { Route: realmRoute } = await import('../src/routes/realms/$id');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');

type RouteContext = { queryClient: QueryClient; credentialMode: 'anonymous' | 'session' };
function fileRouteTree(route: unknown, path: string) {
  const rootRoute = createRootRouteWithContext<RouteContext>()({ component: Outlet });
  const registered = (route as { update: (options: never) => unknown }).update({
    id: path,
    path,
    getParentRoute: () => rootRoute,
  } as never);
  return rootRoute.addChildren([registered as never]);
}

function createConnectedRouter(
  route: unknown,
  path: string,
  entry: string,
  queryClient: QueryClient,
  credentialMode: RouteContext['credentialMode'],
) {
  return createRouter({
    routeTree: fileRouteTree(route, path),
    history: createMemoryHistory({ initialEntries: [entry] }),
    context: { queryClient, credentialMode },
  });
}

async function mountConnectedRouter(router: ReturnType<typeof createConnectedRouter>, queryClient: QueryClient) {
  await unmount();
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await tick();
  });
}

type SpaceLoader = (input: {
  params: { address: string };
  context: RouteContext;
  abortController: AbortController;
}) => Promise<{
  page: SpacePageData;
  admission: SpacePageAdmission;
}>;
type RealmLoader = (input: {
  params: { id: string };
  context: RouteContext;
  abortController: AbortController;
}) => Promise<{
  page: SpacePageData;
  admission: SpacePageAdmission;
}>;
const loadSpaceRoute = (spaceRoute.options as unknown as { loader: SpaceLoader }).loader;
const loadRealmRoute = (realmRoute.options as unknown as { loader: RealmLoader }).loader;

function setRequest(options: { signedIn?: boolean; authorization?: string } = {}) {
  const headers = new Headers();
  if (options.signedIn !== false) headers.set('cookie', `__Host-rezics_session=${cookieId}`);
  if (options.authorization) headers.set('authorization', options.authorization);
  activeRequest = new Request('https://site.test/en/spaces/atlas', { headers });
  return activeRequest;
}

function signedInSession(account = subject, csrf: string | null = browserCsrfToken) {
  return { state: 'signed-in' as const, subject: account, csrfToken: csrf };
}

function routeTarget(): SpacePageTarget {
  return { kind: 'space', address };
}

async function loadSpace(
  client: QueryClient,
  credentialMode: RouteContext['credentialMode'] = 'anonymous',
  abortController = new AbortController(),
) {
  const request = activeRequest ?? setRequest();
  return requests.run(request, () =>
    loadSpaceRoute({ params: { address }, context: { queryClient: client, credentialMode }, abortController }),
  );
}

async function loadRealm(
  client: QueryClient,
  credentialMode: RouteContext['credentialMode'],
  abortController = new AbortController(),
) {
  const request = activeRequest ?? setRequest();
  return requests.run(request, () =>
    loadRealmRoute({ params: { id: realmId }, context: { queryClient: client, credentialMode }, abortController }),
  );
}

function ConnectedPage({
  page,
  admission,
  credentialMode = 'anonymous',
  target = routeTarget(),
}: {
  page: SpacePageData;
  admission: SpacePageAdmission;
  credentialMode?: RouteContext['credentialMode'];
  target?: SpacePageTarget;
}) {
  return (
    <SpacePageLifetimeHost
      page={page}
      admission={admission}
      target={target}
      locale="en"
      credentialMode={credentialMode}
    >
      <main>
        <h1>{page.space.title}</h1>
        {page.realm ? <RealmShelf realm={page.realm} frozen /> : null}
      </main>
    </SpacePageLifetimeHost>
  );
}

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: Root | undefined;

async function unmount() {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host.replaceChildren();
}

async function mount(
  client: QueryClient,
  page: SpacePageData,
  admission: SpacePageAdmission,
  mode: 'anonymous' | 'session' = 'anonymous',
  strict = false,
  target: SpacePageTarget = routeTarget(),
) {
  await unmount();
  root = createRoot(host);
  const content = <ConnectedPage page={page} admission={admission} credentialMode={mode} target={target} />;
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        {strict ? <StrictMode>{content}</StrictMode> : content}
      </QueryClientProvider>,
    );
    await tick();
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function resetTransport() {
  nativeCalls = [];
  pendingShelfReads = [];
  shelfFailure = new Map();
  holdShelfReads = false;
  nativeSpaceAddress = null;
  pageFailure = null;
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}

function pendingShelf(path: string, cursor: string) {
  const match = pendingShelfReads.find((entry) => {
    const url = new URL(entry.request.url);
    return url.pathname === path && (url.searchParams.get('cursor') ?? '') === cursor && !entry.settled;
  });
  if (!match) throw new Error(`Missing pending native shelf read ${path}?cursor=${cursor}`);
  return match;
}

function settleShelf(entry: (typeof pendingShelfReads)[number], body: unknown, status = 200) {
  entry.settled = true;
  entry.work.resolve(status >= 400 ? problem(status) : json(body));
}

function byButton(label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button ${label}`);
  return button;
}

async function click(label: string) {
  await act(async () => {
    byButton(label).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
  });
}

type ProbeState<T extends { id: string }> = ReturnType<typeof useShelfList<T>>;
let latestProbe: { boards: ProbeState<RealmBoard>; publications: ProbeState<PublishedSubject> } | undefined;

function sameQueryKey(actual: readonly unknown[], expected: readonly unknown[]) {
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function ShelfPairProbe() {
  const lifetime = useContext(SpacePageLifetimeContext);
  const boards = useShelfList(
    {
      items: [{ id: boardId, title: 'Original board', purpose: 'discussion', visibility: 'published' }],
      next: 'board-first',
      unavailable: 0,
      credentialMode: 'anonymous',
    },
    (input) => readRealmBoards({ data: { realmId, ...input } }),
    lifetime,
    true,
  );
  const publications = useShelfList(
    {
      items: [
        {
          id: oldSubjectId,
          labels: { en: 'Original publication' },
          label: 'Original publication',
          types: ['schema:Book'],
          cover: null,
        },
      ],
      next: 'publication-first',
      unavailable: 0,
      credentialMode: 'anonymous',
    },
    (input) => readRealmPublications({ data: { realmId, ...input } }),
    lifetime,
    true,
  );
  latestProbe = { boards, publications };
  return (
    <div>
      <output data-testid="boards">
        {boards.items.map((item) => item.title).join(',')} {String(boards.busy)}
      </output>
      <output data-testid="publications">
        {publications.items.map((item) => item.label).join(',')} {String(publications.busy)}
      </output>
      <button onClick={() => void boards.load()}>load boards</button>
      <button onClick={() => void boards.load(true)}>restart boards</button>
      <button onClick={() => void publications.load()}>load publications</button>
      <button onClick={() => void publications.load(true)}>restart publications</button>
    </div>
  );
}

function ProbePage({ page, admission }: { page: SpacePageData; admission: SpacePageAdmission }) {
  return (
    <SpacePageLifetimeHost
      page={page}
      admission={admission}
      target={routeTarget()}
      locale="en"
      credentialMode="anonymous"
    >
      <ShelfPairProbe />
    </SpacePageLifetimeHost>
  );
}

async function mountProbe(client: QueryClient, page: SpacePageData, admission: SpacePageAdmission) {
  await unmount();
  root = createRoot(host);
  latestProbe = undefined;
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ProbePage page={page} admission={admission} />
      </QueryClientProvider>,
    );
    await tick();
  });
}

function connectedShelfRow(name: string) {
  return boardWire(name);
}

function connectedPublicationRow(id: string, publicationId: string) {
  return publicationWire(id, publicationId);
}

afterAll(async () => {
  await unmount();
  globalThis.fetch = originalFetch;
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('connected Space and Realm reads preserve their original reader through hydration and shelf continuations', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  browserCsrfToken = csrfToken;
  credentialCsrfToken = credentialCsrf;
  setRequest();

  const serverClient = newClient();
  const loaded = await loadSpace(serverClient);
  expect(loaded.page.space.title).toBe('Connected Space');
  expect(loaded.admission.readerOrigin).toEqual({ kind: 'anonymous' });
  expect(nativeCalls.filter((call) => call.path.startsWith('/v1/')).every((call) => call.authorization === null)).toBe(
    true,
  );
  expect(
    renderToString(
      <QueryClientProvider client={serverClient}>
        <ConnectedPage page={loaded.page} admission={loaded.admission} />
      </QueryClientProvider>,
    ),
  ).toContain('Connected Space');

  const serverCache = JSON.parse(JSON.stringify(dehydrate(serverClient))) as ReturnType<typeof dehydrate>;
  const routeEnvelope = JSON.parse(JSON.stringify(loaded)) as typeof loaded;
  const serialized = JSON.stringify({ cache: serverCache, routeEnvelope });
  expect(serialized).not.toContain(accessToken);
  expect(serialized).not.toContain(credentialCsrf);
  expect(serialized).not.toContain(csrfToken);

  const browserClient = newClient();
  hydrate(browserClient, serverCache);
  const cached = browserClient.getQueryData<{ page: SpacePageData; admission: SpacePageAdmission }>(
    (await import('../src/community/space-queries')).spaceQuery(address, 'en', 'anonymous').queryKey,
  );
  expect(cached?.admission.readerOrigin).toEqual({ kind: 'anonymous' });
  await mount(browserClient, routeEnvelope.page, routeEnvelope.admission, 'anonymous', true);
  expect(host.textContent).toContain('Connected Space');
  // The normal first browser session refresh adopts this public anonymous SSR visit once.
  await tick();
  expect(browserClient.getQueryData(sessionQuery.queryKey)).toEqual(signedInSession(subject, csrfToken));
  expect(host.textContent).toContain('Connected Space');
  expect(spacePageAdmissionIsCurrent(routeEnvelope.admission, browserClient)).toBe(true);

  nativeCalls = [];
  await click(m.realm_boards_more());
  await click(m.realm_publications_more());
  await tick();
  expect(nativeCalls).toContainEqual(
    expect.objectContaining({
      path: `/v1/realms/${realmId}/boards`,
      cursor: 'board-first',
      authorization: null,
      limit: '20',
    }),
  );
  expect(nativeCalls).toContainEqual(
    expect.objectContaining({
      path: `/v1/realms/${realmId}/publications`,
      cursor: 'publication-first',
      authorization: null,
      limit: '12',
    }),
  );
  expect(host.textContent).toContain('Native board');
  expect(host.textContent).toContain('Native board description');
  expect(nativeCalls.filter((call) => call.path.includes('/boards'))).toHaveLength(1);
  expect(host.textContent).toContain('Native publication');

  // The actual Realm route binds a null-CSRF read-only browser session to the subject returned by preparation.
  await unmount();
  resetTransport();
  browserCsrfToken = null;
  credentialCsrfToken = null;
  const realmClient = newClient();
  realmClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
  setRequest();
  const realmLoaded = await loadRealm(realmClient, 'session');
  expect(realmLoaded.admission.readerOrigin).toEqual({ kind: 'signed-in', subject });
  expect(realmLoaded.page.realm?.credentialMode).toBe('session');
  expect(
    nativeCalls
      .filter((call) => call.path.startsWith('/v1/'))
      .every((call) => call.authorization === `Bearer ${accessToken}`),
  ).toBe(true);
  await mount(realmClient, realmLoaded.page, realmLoaded.admission, 'session', false, { kind: 'realm', id: realmId });
  await click(m.realm_boards_more());
  await click(m.realm_publications_more());
  expect(host.textContent).toContain('Native board');
  expect(host.textContent).toContain('Native publication');
  expect(
    nativeCalls.some((call) => call.path.endsWith('/boards') && call.authorization === `Bearer ${accessToken}`),
  ).toBe(true);
  expect(
    nativeCalls.some((call) => call.path.endsWith('/publications') && call.authorization === `Bearer ${accessToken}`),
  ).toBe(true);
});

test('healthy repeated Space and Realm loaders own one exact default-shared Query commit each', async () => {
  setLocale('en', { reload: false });
  const { realmPageQuery, spaceQuery } = await import('../src/community/space-queries');

  for (const route of ['space', 'realm-page', 'realm-redirect'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    nativeSpaceAddress = route === 'realm-redirect' ? 'space & one' : null;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    setRequest();

    const queryKey =
      route === 'space'
        ? spaceQuery(address, 'en', 'anonymous').queryKey
        : realmPageQuery(realmId, 'en', 'session').queryKey;
    const commits: number[] = [];
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        'action' in event &&
        event.action.type === 'success' &&
        sameQueryKey(event.query.queryKey, queryKey)
      )
        commits.push(event.query.state.dataUpdateCount);
    });

    try {
      expect(client.getDefaultOptions().queries?.structuralSharing).toBeUndefined();
      if (route === 'space') {
        const first = await loadSpace(client, 'anonymous');
        const firstCache = client.getQueryData<SpacePageQueryResult>(queryKey);
        expect(firstCache?.admission.readId).toBe(first.admission.readId);
        expect(client.getQueryCache().find({ queryKey, exact: true })?.options.structuralSharing).toBeUndefined();
        const firstCount = client.getQueryState(queryKey)?.dataUpdateCount;

        const second = await loadSpace(client, 'anonymous');
        const secondCache = client.getQueryData<SpacePageQueryResult>(queryKey);
        expect(second.admission.readId).not.toBe(first.admission.readId);
        expect(second.page.space.title).toBe('Connected Space');
        expect(second.page.realm?.title).toBe('Connected Realm');
        expect(secondCache).not.toBe(firstCache);
        expect(secondCache?.page).toBe(firstCache?.page);
        expect(secondCache?.admission.readId).toBe(second.admission.readId);
        expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe((firstCount ?? 0) + 1);
        expect(spacePageAdmissionIsCurrent(second.admission, client)).toBe(true);
        expect(nativeCalls.filter((call) => call.path === `/v1/spaceAddresses/${address}`)).toHaveLength(2);
        expect(nativeCalls.filter((call) => call.path === `/v1/spaces/${spaceId}`)).toHaveLength(2);
        expect(
          nativeCalls.filter((call) => call.path.startsWith('/v1/')).every((call) => call.authorization === null),
        ).toBe(true);
      } else if (route === 'realm-page') {
        const first = await loadRealm(client, 'session');
        const firstCache = client.getQueryData<RealmPageQueryResult>(queryKey);
        expect(firstCache?.admission.readId).toBe(first.admission.readId);
        expect(client.getQueryCache().find({ queryKey, exact: true })?.options.structuralSharing).toBeUndefined();
        const firstCount = client.getQueryState(queryKey)?.dataUpdateCount;

        const second = await loadRealm(client, 'session');
        const secondCache = client.getQueryData<RealmPageQueryResult>(queryKey);
        expect(second.admission.readId).not.toBe(first.admission.readId);
        expect(second.page.realm?.title).toBe('Connected Realm');
        expect(secondCache).not.toBe(firstCache);
        expect(secondCache?.located).toBe(firstCache?.located);
        expect(secondCache?.admission.readId).toBe(second.admission.readId);
        expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe((firstCount ?? 0) + 1);
        expect(spacePageAdmissionIsCurrent(second.admission, client)).toBe(true);
        expect(nativeCalls.filter((call) => call.path === `/v1/realms/${realmId}`)).toHaveLength(2);
        expect(
          nativeCalls
            .filter((call) => call.path.startsWith('/v1/'))
            .every((call) => call.authorization === `Bearer ${accessToken}`),
        ).toBe(true);
      } else {
        const readRedirect = async () => {
          try {
            await loadRealm(client, 'session');
            return undefined;
          } catch (error) {
            return error;
          }
        };
        const firstRedirect = await readRedirect();
        expect(firstRedirect).toMatchObject({
          options: { href: '/en/spaces/space%20%26%20one', statusCode: 307 },
        });
        const firstCache = client.getQueryData<RealmPageQueryResult>(queryKey);
        expect(firstCache?.located.kind).toBe('redirect');
        expect(client.getQueryCache().find({ queryKey, exact: true })?.options.structuralSharing).toBeUndefined();
        const firstCount = client.getQueryState(queryKey)?.dataUpdateCount;

        const secondRedirect = await readRedirect();
        const secondCache = client.getQueryData<RealmPageQueryResult>(queryKey);
        expect(secondRedirect).toMatchObject({
          options: { href: '/en/spaces/space%20%26%20one', statusCode: 307 },
        });
        expect(secondCache).not.toBe(firstCache);
        expect(secondCache?.located).toBe(firstCache?.located);
        expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe((firstCount ?? 0) + 1);
        expect(spacePageAdmissionIsCurrent(secondCache!.admission, client)).toBe(true);
        expect(nativeCalls.filter((call) => call.path === `/v1/realms/${realmId}`)).toHaveLength(2);
      }
      expect(commits).toEqual([1, 2]);
    } finally {
      stop();
    }
  }
});

test('required Space and Realm native read errors reach their route callers without recovery reads', async () => {
  setLocale('en', { reload: false });
  const { realmPageQuery, spaceQuery } = await import('../src/community/space-queries');
  const { isObsoleteSpacePageRead } = await import('../src/community/space-page-lifetime');

  for (const route of ['space', 'realm'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    setRequest();
    const failedPath = route === 'space' ? `/v1/spaceAddresses/${address}` : `/v1/realms/${realmId}`;
    pageFailure = { path: failedPath, status: 503 };
    const queryKey =
      route === 'space'
        ? spaceQuery(address, 'en', 'anonymous').queryKey
        : realmPageQuery(realmId, 'en', 'session').queryKey;

    let failure: unknown;
    try {
      if (route === 'space') await loadSpace(client, 'anonymous');
      else await loadRealm(client, 'session');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(isObsoleteSpacePageRead(failure)).toBe(false);
    expect(client.getQueryState(queryKey)?.status).toBe('error');
    expect(nativeCalls.filter((call) => call.path === failedPath)).toHaveLength(1);
  }
});

test('mounted Space and Realm recovery retain one healthy default-shared successor read', async () => {
  setLocale('en', { reload: false });

  for (const route of ['space', 'realm'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    setRequest();

    const isSpace = route === 'space';
    const { realmPageQuery, spaceQuery } = await import('../src/community/space-queries');
    const queryKey = isSpace
      ? spaceQuery(address, 'en', 'anonymous').queryKey
      : realmPageQuery(realmId, 'en', 'session').queryKey;
    const connectedRouter = createConnectedRouter(
      isSpace ? spaceRoute : realmRoute,
      isSpace ? '/spaces/$address' : '/realms/$id',
      isSpace ? `/spaces/${address}` : `/realms/${realmId}`,
      client,
      isSpace ? 'anonymous' : 'session',
    );
    await connectedRouter.load();
    expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe(1);
    expect(client.getQueryCache().find({ queryKey, exact: true })?.options.structuralSharing).toBeUndefined();
    const routeReadPath = isSpace ? `/v1/spaceAddresses/${address}` : `/v1/realms/${realmId}`;
    expect(nativeCalls.filter((call) => call.path === routeReadPath)).toHaveLength(1);

    // An equal committed session write retires the original route before its mounted recovery effect.
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    await mountConnectedRouter(connectedRouter, client);
    await act(async () => {
      await tick();
      await tick();
    });

    expect(host.textContent).toContain(isSpace ? 'Connected Space' : 'Connected Realm');
    expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe(2);
    expect(nativeCalls.filter((call) => call.path === routeReadPath)).toHaveLength(2);
    const cache = client.getQueryData<SpacePageQueryResult | RealmPageQueryResult>(queryKey);
    expect(cache && spacePageAdmissionIsCurrent(cache.admission, client)).toBe(true);
    await act(async () => {
      await tick();
    });
    expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe(2);
    await unmount();
  }
});

test('missing and mismatched actual subjects never get filled from the expected QueryClient reader', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  const { spaceQuery } = await import('../src/community/space-queries');
  const { captureSpacePageAdmission } = await import('../src/community/space-page-lifetime');

  const mismatchClient = newClient();
  mismatchClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  nativeSubject = otherSubject;
  setRequest();
  const mismatchAdmission = captureSpacePageAdmission(mismatchClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const mismatch = mismatchClient.fetchQuery(spaceQuery(address, 'en', 'session', mismatchAdmission));
  await expect(mismatch).rejects.toThrow('obsolete visit');
  expect(mismatchClient.getQueryData(spaceQuery(address, 'en', 'session').queryKey)).toBeUndefined();
  expect(nativeCalls.some((call) => call.authorization === `Bearer ${accessToken}`)).toBe(true);

  resetTransport();
  nativeSubject = subject;
  const missingClient = newClient();
  missingClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest({ authorization: 'Bearer opaque-explicit-reader' });
  const missingAdmission = captureSpacePageAdmission(missingClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const missing = missingClient.fetchQuery(spaceQuery(address, 'en', 'session', missingAdmission));
  await expect(missing).rejects.toThrow('obsolete visit');
  expect(nativeCalls.some((call) => call.authorization === 'Bearer opaque-explicit-reader')).toBe(true);
  expect(missingClient.getQueryData(spaceQuery(address, 'en', 'session').queryKey)).toBeUndefined();
});

test('one QueryClient retires ready and pending admissions for committed replacements, errors, removals and observed ABA', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  const { spaceQuery } = await import('../src/community/space-queries');
  const { captureSpacePageAdmission, spacePageAdmissionIsCurrent: isCurrent } =
    await import('../src/community/space-page-lifetime');

  const client = newClient();
  client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const admission = captureSpacePageAdmission(client, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const bound = await client.fetchQuery(spaceQuery(address, 'en', 'session', admission));
  expect(isCurrent(bound.admission, client)).toBe(true);

  const observer = new QueryObserver(client, { ...sessionQuery, enabled: false });
  const stop = observer.subscribe(() => {});
  stop();
  expect(isCurrent(bound.admission, client)).toBe(true);

  const refreshing = deferred<ReturnType<typeof signedInSession>>();
  const pendingFetch = client.fetchQuery({
    ...sessionQuery,
    queryFn: () => refreshing.promise,
    staleTime: 0,
    retry: false,
  });
  await tick();
  expect(isCurrent(bound.admission, client)).toBe(true);
  refreshing.resolve(signedInSession(subject, csrfToken));
  await pendingFetch;
  expect(isCurrent(bound.admission, client)).toBe(false);

  const replacementClient = newClient();
  replacementClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const replacementAdmission = captureSpacePageAdmission(replacementClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const replacementPage = await replacementClient.fetchQuery(
    spaceQuery(address, 'en', 'session', replacementAdmission),
  );
  replacementClient.setQueryData(sessionQuery.queryKey, signedInSession(otherSubject, 'replacement-csrf'));
  expect(isCurrent(replacementPage.admission, replacementClient)).toBe(false);

  const errorClient = newClient();
  errorClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const errorAdmission = captureSpacePageAdmission(errorClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const errorPage = await errorClient.fetchQuery(spaceQuery(address, 'en', 'session', errorAdmission));
  const errorRefresh = errorClient.fetchQuery({
    ...sessionQuery,
    queryFn: async () => {
      throw new Error('session refresh failed');
    },
    staleTime: 0,
    retry: false,
  });
  await expect(errorRefresh).rejects.toThrow('session refresh failed');
  expect(isCurrent(errorPage.admission, errorClient)).toBe(false);

  const removalClient = newClient();
  removalClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const removalAdmission = captureSpacePageAdmission(removalClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const removalPage = await removalClient.fetchQuery(spaceQuery(address, 'en', 'session', removalAdmission));
  removalClient.removeQueries({ queryKey: sessionQuery.queryKey });
  expect(isCurrent(removalPage.admission, removalClient)).toBe(false);

  const abaClient = newClient();
  abaClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const abaAdmission = captureSpacePageAdmission(abaClient, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const abaPage = await abaClient.fetchQuery(spaceQuery(address, 'en', 'session', abaAdmission));
  abaClient.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  abaClient.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  expect(isCurrent(abaPage.admission, abaClient)).toBe(false);
});

test('both independent shelves discard obsolete queued responses and preserve fresh busy, retry, restart and unmount state', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  const client = newClient();
  setRequest({ signedIn: false });
  const loaded = await loadSpace(client);
  await mountProbe(client, loaded.page, loaded.admission);
  expect(host.textContent).toContain('Original board');
  expect(host.textContent).toContain('Original publication');

  holdShelfReads = true;
  let oldBoards!: Promise<void>;
  let oldPublications!: Promise<void>;
  await act(async () => {
    oldBoards = latestProbe!.boards.load();
    oldPublications = latestProbe!.publications.load();
    await tick();
  });
  await tick();
  expect(pendingShelfReads).toHaveLength(2);

  // A new shelf generation restarts both lists while their old native requests are still queued.
  let freshBoards!: Promise<void>;
  let freshPublications!: Promise<void>;
  await act(async () => {
    latestProbe!.boards.update((previous) => ({ ...previous, items: previous.items }));
    latestProbe!.publications.update((previous) => ({ ...previous, items: previous.items }));
    freshBoards = latestProbe!.boards.load(true);
    freshPublications = latestProbe!.publications.load(true);
    await tick();
  });
  await tick();
  expect(pendingShelfReads).toHaveLength(4);

  settleShelf(pendingShelf('/v1/realms/' + realmId + '/boards', 'board-first'), {
    items: [connectedShelfRow('Obsolete board')],
    next: 'obsolete-board-next',
  });
  settleShelf(pendingShelf('/v1/realms/' + realmId + '/publications', 'publication-first'), {
    items: [connectedPublicationRow(oldSubjectId, '0192f3a0-6c1e-7b2a-9d4e-000000000502')],
    next: 'obsolete-publication-next',
  });
  await act(async () => {
    await Promise.all([oldBoards, oldPublications]);
    await tick();
  });
  expect(host.textContent).not.toContain('Obsolete board');
  expect(host.textContent).not.toContain('Obsolete publication');
  expect(host.textContent).toContain('true');

  settleShelf(pendingShelf('/v1/realms/' + realmId + '/boards', ''), {
    items: [connectedShelfRow('Fresh restarted board')],
    next: 'board-next',
  });
  settleShelf(pendingShelf('/v1/realms/' + realmId + '/publications', ''), {
    items: [connectedPublicationRow(newSubjectId, '0192f3a0-6c1e-7b2a-9d4e-000000000503')],
    next: 'publication-next',
  });
  await act(async () => {
    await Promise.all([freshBoards, freshPublications]);
    await tick();
  });
  expect(host.textContent).toContain('Fresh restarted board');
  expect(host.textContent).toContain('Native publication');
  expect(host.textContent).not.toContain('Obsolete');
  expect(host.textContent).not.toContain('true');

  holdShelfReads = false;
  shelfFailure.set(`/v1/realms/${realmId}/boards:board-next`, 409);
  shelfFailure.set(`/v1/realms/${realmId}/publications:publication-next`, 409);
  await act(async () => {
    await Promise.all([latestProbe!.boards.load(), latestProbe!.publications.load()]);
    await tick();
  });
  expect(host.textContent).toContain(m.realm_shelf_restart());
  expect(latestProbe!.boards.next).toBe('board-next');
  expect(latestProbe!.publications.next).toBe('publication-next');

  shelfFailure.clear();
  await act(async () => {
    await Promise.all([latestProbe!.boards.load(true), latestProbe!.publications.load(true)]);
    await tick();
  });
  expect(nativeCalls.some((call) => call.path.endsWith('/boards') && call.cursor === null)).toBe(true);
  expect(nativeCalls.some((call) => call.path.endsWith('/publications') && call.cursor === null)).toBe(true);

  // Final unmount retires both shelf tickets before either queued transport can publish or clear state.
  holdShelfReads = true;
  let unmountedBoards!: Promise<void>;
  let unmountedPublications!: Promise<void>;
  await act(async () => {
    unmountedBoards = latestProbe!.boards.load(true);
    unmountedPublications = latestProbe!.publications.load(true);
    await tick();
  });
  await tick();
  const unmounted = pendingShelfReads.filter((entry) => !entry.settled);
  expect(unmounted.length).toBe(2);
  await unmount();
  for (const entry of unmounted) settleShelf(entry, { items: [boardWire('After unmount')], next: null });
  await Promise.all([unmountedBoards, unmountedPublications]);
  expect(host.textContent).toBe('');

  const equalClient = newClient();
  const signedOut = { state: 'signed-out', subject: null, csrfToken: null } as const;
  equalClient.setQueryData(sessionQuery.queryKey, signedOut);
  setRequest({ signedIn: false });
  const equalLoaded = await loadSpace(equalClient);
  await mountProbe(equalClient, equalLoaded.page, equalLoaded.admission);
  holdShelfReads = true;
  let equalBoards!: Promise<void>;
  let equalPublications!: Promise<void>;
  await act(async () => {
    equalBoards = latestProbe!.boards.load(true);
    equalPublications = latestProbe!.publications.load(true);
    await tick();
  });
  await tick();
  const equalPending = pendingShelfReads.filter((entry) => !entry.settled);
  expect(equalPending).toHaveLength(2);
  equalClient.setQueryData(sessionQuery.queryKey, signedOut);
  await tick();
  for (const entry of equalPending)
    settleShelf(entry, { items: [boardWire('After equal session replacement')], next: null });
  await Promise.all([equalBoards, equalPublications]);
  expect(host.textContent).not.toContain('After equal session replacement');
  await unmount();
});

test('a pending original read is rejected before it enters the QueryClient after credential replacement', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  const { spaceQuery } = await import('../src/community/space-queries');
  const { captureSpacePageAdmission } = await import('../src/community/space-page-lifetime');
  const client = newClient();
  client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
  setRequest();
  const admission = captureSpacePageAdmission(client, {
    target: routeTarget(),
    locale: 'en',
    credentialMode: 'session',
  });
  const pending = deferred<Response>();
  let held = false;
  const actualFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!held && request.url.includes(`/v1/spaceAddresses/${address}`)) {
      held = true;
      nativeCalls.push({
        path: `/v1/spaceAddresses/${address}`,
        cursor: null,
        authorization: request.headers.get('authorization'),
        limit: null,
      });
      return pending.promise;
    }
    return nativeFetch(request);
  }) as typeof fetch;
  let read: Promise<unknown> | undefined;
  try {
    read = client.fetchQuery(spaceQuery(address, 'en', 'session', admission));
    await tick();
    if (!held) {
      await read;
      throw new Error('The deferred original read did not start');
    }
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, 'credential-replaced'));
    pending.resolve(json({ spaceId }));
    await expect(read).rejects.toThrow('obsolete visit');
    expect(client.getQueryData(spaceQuery(address, 'en', 'session').queryKey)).toBeUndefined();
  } finally {
    pending.resolve(json({ spaceId }));
    if (read) await read.catch(() => {});
    globalThis.fetch = actualFetch;
  }
});

test('pending original reads retire on equal success, refresh error, removal and observed batched ABA', async () => {
  setLocale('en', { reload: false });
  const { spaceQuery } = await import('../src/community/space-queries');
  const { captureSpacePageAdmission } = await import('../src/community/space-page-lifetime');

  const replacements: { label: string; apply(client: QueryClient): Promise<void> }[] = [
    {
      label: 'equal success',
      apply: async (client) => {
        client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
      },
    },
    {
      label: 'refresh error',
      apply: async (client) => {
        const refresh = client.fetchQuery({
          ...sessionQuery,
          queryFn: async () => {
            throw new Error('session refresh failed');
          },
          staleTime: 0,
          retry: false,
        });
        await expect(refresh).rejects.toThrow('session refresh failed');
      },
    },
    {
      label: 'removal',
      apply: async (client) => {
        client.removeQueries({ queryKey: sessionQuery.queryKey });
      },
    },
    {
      label: 'observed batched ABA',
      apply: async (client) => {
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
      },
    },
  ];

  for (const replacement of replacements) {
    resetTransport();
    nativeSubject = subject;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
    setRequest();
    const admission = captureSpacePageAdmission(client, {
      target: routeTarget(),
      locale: 'en',
      credentialMode: 'session',
    });
    const pending = deferred<Response>();
    let held = false;
    const actualFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (!held && request.url.includes(`/v1/spaceAddresses/${address}`)) {
        held = true;
        nativeCalls.push({
          path: `/v1/spaceAddresses/${address}`,
          cursor: null,
          authorization: request.headers.get('authorization'),
          limit: null,
        });
        return pending.promise;
      }
      return nativeFetch(request);
    }) as typeof fetch;
    let read: Promise<unknown> | undefined;
    let transportSettled = false;
    try {
      read = client.fetchQuery(spaceQuery(address, 'en', 'session', admission));
      await tick();
      if (!held) {
        await read;
        throw new Error('The deferred original read did not start');
      }
      await replacement.apply(client);
      pending.resolve(json({ spaceId }));
      transportSettled = true;
      await expect(read).rejects.toThrow('obsolete visit');
      expect(client.getQueryData(spaceQuery(address, 'en', 'session').queryKey)).toBeUndefined();
    } finally {
      if (!transportSettled) pending.resolve(json({ spaceId }));
      if (read) await read.catch(() => {});
      globalThis.fetch = actualFetch;
    }
  }
});

test('actual route loaders recover after QueryClient subscribers retire committed results before continuation', async () => {
  setLocale('en', { reload: false });
  const { spaceQuery } = await import('../src/community/space-queries');
  const transitions = ['equal', 'error', 'remove', 'aba'] as const;

  for (const transition of transitions) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = csrfToken;
    credentialCsrfToken = credentialCsrf;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
    setRequest();
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    let retired = false;
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        retired ||
        event.type !== 'updated' ||
        !('action' in event) ||
        event.action.type !== 'success' ||
        !sameQueryKey(event.query.queryKey, queryKey)
      )
        return;
      retired = true;
      if (transition === 'equal') client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
      if (transition === 'aba') {
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        client.setQueryData(sessionQuery.queryKey, signedInSession(subject, csrfToken));
      }
      if (transition === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      if (transition === 'error') {
        const session = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
        if (!session) throw new Error('Missing prepared session query');
        session.setState({
          ...session.state,
          status: 'error',
          error: new Error('session refresh failed'),
          errorUpdateCount: session.state.errorUpdateCount + 1,
        });
      }
    });
    try {
      const loaded = await loadSpace(client, 'anonymous');
      expect(retired).toBe(true);
      expect(loaded.page.space.title).toBe('Connected Space');
      expect(loaded.admission.readerOrigin).toEqual({ kind: 'anonymous' });
      expect(nativeCalls.filter((call) => call.path === `/v1/spaceAddresses/${address}`)).toHaveLength(2);
      expect(
        nativeCalls.filter((call) => call.path.startsWith('/v1/')).every((call) => call.authorization === null),
      ).toBe(true);
    } finally {
      stop();
    }
  }
});

test('Space and Realm loaders recover after a session Query setState notification', async () => {
  setLocale('en', { reload: false });
  const { realmPageQuery, spaceQuery } = await import('../src/community/space-queries');

  for (const route of ['space', 'realm'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    setRequest();
    const queryKey =
      route === 'space'
        ? spaceQuery(address, 'en', 'anonymous').queryKey
        : realmPageQuery(realmId, 'en', 'session').queryKey;
    const path = route === 'space' ? `/v1/spaceAddresses/${address}` : `/v1/realms/${realmId}`;
    let reads = 0;
    let retired = false;
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        retired ||
        event.type !== 'updated' ||
        !('action' in event) ||
        event.action.type !== 'success' ||
        !sameQueryKey(event.query.queryKey, queryKey)
      )
        return;
      reads++;
      if (reads !== 1) return;
      retired = true;
      const session = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      if (!session) throw new Error('Missing prepared session query');
      session.setState({ ...session.state });
    });

    try {
      const loaded = route === 'space' ? await loadSpace(client, 'anonymous') : await loadRealm(client, 'session');
      expect(retired).toBe(true);
      expect(loaded.page.space.title).toBe('Connected Space');
      expect(nativeCalls.filter((call) => call.path === path)).toHaveLength(2);
      expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe(2);
    } finally {
      stop();
    }
  }
});

test('actual Space and Realm loaders retire on an equal manual page success', async () => {
  setLocale('en', { reload: false });
  const { realmPageQuery, spaceQuery } = await import('../src/community/space-queries');

  for (const route of ['space', 'realm'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    setRequest();
    const isSpace = route === 'space';
    const queryKey = isSpace
      ? spaceQuery(address, 'en', 'anonymous').queryKey
      : realmPageQuery(realmId, 'en', 'session').queryKey;
    const path = isSpace ? `/v1/spaceAddresses/${address}` : `/v1/realms/${realmId}`;
    let committed: SpacePageQueryResult | RealmPageQueryResult | undefined;
    let originalQuery: unknown;
    let replaced = false;
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        replaced ||
        event.type !== 'updated' ||
        !('action' in event) ||
        event.action.type !== 'success' ||
        !sameQueryKey(event.query.queryKey, queryKey)
      )
        return;
      replaced = true;
      originalQuery = event.query;
      committed = client.getQueryData<SpacePageQueryResult | RealmPageQueryResult>(queryKey);
      if (!committed) throw new Error('Missing committed page result');
      client.setQueryData(queryKey, committed);
    });

    try {
      if (isSpace) await expect(loadSpace(client, 'anonymous')).rejects.toThrow('obsolete visit');
      else await expect(loadRealm(client, 'session')).rejects.toThrow('obsolete visit');
      expect(replaced).toBe(true);
      expect(client.getQueryData(queryKey)).toBe(committed);
      expect(client.getQueryCache().find({ queryKey, exact: true })).toBe(originalQuery);
      expect(client.getQueryState(queryKey)?.dataUpdateCount).toBe(2);
      expect(nativeCalls.filter((call) => call.path === path)).toHaveLength(1);
    } finally {
      stop();
    }
  }
});

test('a successor cache result survives predecessor completion and bounded recovery', async () => {
  setLocale('en', { reload: false });
  const { spaceQuery } = await import('../src/community/space-queries');
  const { captureSpacePageAdmission } = await import('../src/community/space-page-lifetime');

  for (const replacement of ['result', 'query', 'fetching'] as const) {
    resetTransport();
    nativeSubject = subject;
    const client = newClient();
    setRequest();
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    let installed = false;
    let originalQuery: unknown;
    let successorPromise: Promise<SpacePageQueryResult> | undefined;
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        installed ||
        event.type !== 'updated' ||
        !('action' in event) ||
        event.action.type !== 'success' ||
        !sameQueryKey(event.query.queryKey, queryKey)
      )
        return;
      installed = true;
      originalQuery = event.query;
      if (replacement === 'fetching') {
        client.removeQueries({ queryKey, exact: true });
        const successorAdmission = captureSpacePageAdmission(client, {
          target: routeTarget(),
          locale: 'en',
          credentialMode: 'anonymous',
        });
        successorPromise = client.fetchQuery(spaceQuery(address, 'en', 'anonymous', successorAdmission));
        return;
      }
      const current = client.getQueryData<SpacePageQueryResult>(queryKey);
      if (!current) throw new Error('Missing committed page result');
      if (replacement === 'query') client.removeQueries({ queryKey, exact: true });
      client.setQueryData<SpacePageQueryResult>(queryKey, {
        ...current,
        page: {
          ...current.page,
          space: { ...current.page.space, title: `Healthy ${replacement} successor` },
        },
      });
    });
    try {
      await expect(loadSpace(client, 'anonymous')).rejects.toThrow('obsolete visit');
      const fetchedSuccessor = successorPromise ? await successorPromise : undefined;
      const successor = client.getQueryData<SpacePageQueryResult>(queryKey);
      expect(installed).toBe(true);
      if (replacement === 'fetching') {
        expect(fetchedSuccessor?.page.space.title).toBe('Connected Space');
        expect(successor?.admission.readId).toBe(fetchedSuccessor?.admission.readId);
      } else expect(successor?.page.space.title).toBe(`Healthy ${replacement} successor`);
      expect(nativeCalls.filter((call) => call.path === `/v1/spaceAddresses/${address}`)).toHaveLength(
        replacement === 'fetching' ? 2 : 1,
      );
      if (replacement === 'query' || replacement === 'fetching')
        expect(client.getQueryCache().find({ queryKey, exact: true })).not.toBe(originalQuery);
    } finally {
      stop();
    }
  }
});

test('a recreated Realm Query keeps its captured 307 result and blocks predecessor redirect cleanup', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  browserCsrfToken = null;
  credentialCsrfToken = null;
  nativeSpaceAddress = 'space & one';
  setRequest();
  const client = newClient();
  client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
  const { realmPageQuery } = await import('../src/community/space-queries');
  const queryKey = realmPageQuery(realmId, 'en', 'session').queryKey;
  let installed = false;
  let originalQuery: unknown;
  let successorQuery: unknown;
  let committed: RealmPageQueryResult | undefined;
  const stop = client.getQueryCache().subscribe((event) => {
    if (
      installed ||
      event.type !== 'updated' ||
      !('action' in event) ||
      event.action.type !== 'success' ||
      !sameQueryKey(event.query.queryKey, queryKey)
    )
      return;
    installed = true;
    originalQuery = event.query;
    committed = client.getQueryData<RealmPageQueryResult>(queryKey);
    if (!committed) throw new Error('Missing committed Realm result');
    client.removeQueries({ queryKey, exact: true });
    client.setQueryData<RealmPageQueryResult>(queryKey, committed);
    successorQuery = client.getQueryCache().find({ queryKey, exact: true });
  });

  try {
    let redirect: unknown;
    try {
      await loadRealm(client, 'session');
    } catch (error) {
      redirect = error;
    }
    expect(installed).toBe(true);
    expect(redirect).toMatchObject({ name: 'ObsoleteSpacePageReadError' });
    expect(successorQuery).not.toBe(originalQuery);
    expect(client.getQueryData<RealmPageQueryResult>(queryKey)).toBe(committed);
    expect(client.getQueryData<RealmPageQueryResult>(queryKey)?.located.kind).toBe('redirect');
    expect(nativeCalls.filter((call) => call.path === `/v1/realms/${realmId}`)).toHaveLength(1);
  } finally {
    stop();
    nativeSpaceAddress = null;
  }
});

test('a stale Realm redirect is discarded when session retirement happens during cache notification', async () => {
  setLocale('en', { reload: false });
  resetTransport();
  nativeSubject = subject;
  browserCsrfToken = null;
  credentialCsrfToken = null;
  nativeSpaceAddress = 'canonical-space';
  setRequest();
  const client = newClient();
  client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
  const { realmPageQuery } = await import('../src/community/space-queries');
  const queryKey = realmPageQuery(realmId, 'en', 'session').queryKey;
  let retired = false;
  const stop = client.getQueryCache().subscribe((event) => {
    if (
      !retired &&
      event.type === 'updated' &&
      'action' in event &&
      event.action.type === 'success' &&
      sameQueryKey(event.query.queryKey, queryKey)
    ) {
      retired = true;
      client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
      nativeSpaceAddress = null;
    }
  });
  try {
    const loaded = await loadRealm(client, 'session');
    expect(retired).toBe(true);
    expect(loaded.page.space.title).toBe('Connected Space');
    expect(loaded.page.realm?.title).toBe('Connected Realm');
    expect(nativeCalls.filter((call) => call.path === `/v1/realms/${realmId}`)).toHaveLength(2);
  } finally {
    stop();
    nativeSpaceAddress = null;
  }
});

test('Space pages and Realm 307 results cannot escape after route abort in the success notification', async () => {
  setLocale('en', { reload: false });
  const { spaceQuery, realmPageQuery } = await import('../src/community/space-queries');
  for (const route of ['space', 'realm'] as const) {
    resetTransport();
    nativeSubject = subject;
    browserCsrfToken = null;
    credentialCsrfToken = null;
    nativeSpaceAddress = route === 'realm' ? 'late-canonical-space' : null;
    setRequest();
    const client = newClient();
    client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
    const queryKey =
      route === 'space'
        ? spaceQuery(address, 'en', 'anonymous').queryKey
        : realmPageQuery(realmId, 'en', 'session').queryKey;
    const abortController = new AbortController();
    let aborted = false;
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        !aborted &&
        event.type === 'updated' &&
        'action' in event &&
        event.action.type === 'success' &&
        sameQueryKey(event.query.queryKey, queryKey)
      ) {
        aborted = true;
        abortController.abort();
      }
    });
    try {
      if (route === 'space')
        await expect(loadSpace(client, 'anonymous', abortController)).rejects.toThrow('obsolete visit');
      else await expect(loadRealm(client, 'session', abortController)).rejects.toThrow('obsolete visit');
      expect(aborted).toBe(true);
      expect(abortController.signal.aborted).toBe(true);
      if (route === 'realm')
        expect(nativeCalls.filter((call) => call.path === `/v1/realms/${realmId}`)).toHaveLength(1);
    } finally {
      stop();
      nativeSpaceAddress = null;
    }
  }
});

test('a healthy Realm 307 keeps its canonical locale and encoded Space address', async () => {
  setLocale('ja', { reload: false });
  resetTransport();
  nativeSubject = subject;
  nativeSpaceAddress = 'space & one';
  setRequest();
  const client = newClient();
  client.setQueryData(sessionQuery.queryKey, signedInSession(subject, null));
  let redirectResult: unknown;
  try {
    await loadRealm(client, 'session');
  } catch (error) {
    redirectResult = error;
  }
  expect(redirectResult).toMatchObject({
    options: { href: '/ja/spaces/space%20%26%20one', statusCode: 307 },
  });
});
