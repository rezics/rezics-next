import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type { Root } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import type { SpacePageQueryResult } from '../src/community/space-queries';
import type { RealmBoard, RealmHome, SpacePageData, ShelfPage, PublishedSubject } from '../src/community/space';
import type { SpacePageAdmission, SpacePageTarget } from '../src/community/space-page-lifetime';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/atlas-member' });
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const address = 'atlas-member';
const spaceId = id(1);
const realmId = id(2);
const reader = id(3);
const boardId = id(4);
const publishedId = id(5);
const title = 'Original space page';
const viewer = (csrfToken: string | null = 'csrf-one') => ({ state: 'signed-in' as const, subject: reader, csrfToken });
const signedOut = () => ({ state: 'signed-out' as const, subject: null, csrfToken: null });

const board = (idValue = boardId, name = 'Original board'): RealmBoard => ({
  id: idValue,
  title: name,
  description: null,
  purpose: 'discussion',
  visibility: 'published',
});
const publication = (idValue = publishedId, name = 'Original publication'): PublishedSubject => ({
  id: idValue,
  publicationId: id(6),
  labels: { en: name },
  label: name,
  types: ['schema:Book'],
  typeName: 'Book',
  cover: null,
});
function realmHome(credentialMode: 'anonymous' | 'session' = 'anonymous'): RealmHome {
  return {
    id: realmId,
    title: 'Lifetime Realm',
    summary: 'Lifetime test Realm',
    visibility: 'public',
    boards: [board()],
    unavailableBoards: 0,
    published: [publication()],
    unavailablePublished: 0,
    boardNext: 'board-cursor-one',
    publicationNext: 'publication-cursor-one',
    credentialMode,
    viewer: null,
  };
}
function pageFor(routeAddress = address, withRealm = true, mode: 'anonymous' | 'session' = 'anonymous'): SpacePageData {
  return {
    space: { id: spaceId, title: routeAddress === address ? title : `Space ${routeAddress}`, summary: '' },
    realm: withRealm ? realmHome(mode) : null,
  };
}

type ShelfInput = { realmId: string; cursor?: string; credentialMode: 'anonymous' | 'session' };
type PageInput = { address: string; credentialMode: 'anonymous' | 'session' };
type RealmInput = { realmId: string; credentialMode: 'anonymous' | 'session' };

const calls = {
  pages: [] as PageInput[],
  realms: [] as RealmInput[],
  boards: [] as ShelfInput[],
  publications: [] as ShelfInput[],
};
let pageReader: (input: PageInput) => Promise<SpacePageData> = async (input) => pageFor(input.address, false);
let realmReader: (
  input: RealmInput,
) => Promise<{ kind: 'page'; page: SpacePageData } | { kind: 'redirect'; address: string }> = async () => ({
  kind: 'page',
  page: pageFor(address),
});
let boardReader: (input: ShelfInput) => Promise<ShelfPage<RealmBoard>> = async () => ({
  kind: 'page',
  items: [],
  next: null,
  unavailable: 0,
});
let publicationReader: (input: ShelfInput) => Promise<ShelfPage<PublishedSubject>> = async () => ({
  kind: 'page',
  items: [],
  next: null,
  unavailable: 0,
});

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  readSpacePage: ({ data }: { data: PageInput }) => {
    calls.pages.push(structuredClone(data));
    return pageReader(data).then((page) => ({
      ...page,
      readerOrigin:
        data.credentialMode === 'anonymous'
          ? { kind: 'anonymous' as const }
          : { kind: 'signed-in' as const, subject: reader },
    }));
  },
  locateRealmPage: ({ data }: { data: RealmInput }) => {
    calls.realms.push(structuredClone(data));
    return realmReader(data).then((located) => ({
      ...located,
      readerOrigin:
        data.credentialMode === 'anonymous'
          ? { kind: 'anonymous' as const }
          : { kind: 'signed-in' as const, subject: reader },
    }));
  },
  readRealmBoards: ({ data }: { data: ShelfInput }) => {
    calls.boards.push(structuredClone(data));
    return boardReader(data).then((page) => ({
      ...page,
      readerOrigin:
        data.credentialMode === 'anonymous'
          ? { kind: 'anonymous' as const }
          : { kind: 'signed-in' as const, subject: reader },
    }));
  },
  readRealmPublications: ({ data }: { data: ShelfInput }) => {
    calls.publications.push(structuredClone(data));
    return publicationReader(data).then((page) => ({
      ...page,
      readerOrigin:
        data.credentialMode === 'anonymous'
          ? { kind: 'anonymous' as const }
          : { kind: 'signed-in' as const, subject: reader },
    }));
  },
  changeRealmPublication: async () => ({ kind: 'unavailable' }),
  readSpaceSetup: async () => ({ kind: 'failure', reason: 'unavailable', status: 503 }),
}));
mock.module('../src/accounts/resource-access/link', () => ({ ResourceAccessLink: () => null }));
mock.module('../src/library/follow-target-control', () => ({ FollowTargetControl: () => null }));
mock.module('../src/community/realm-membership', () => ({ RealmMembership: () => null }));
mock.module('../src/community/realm-bans-panel', () => ({ RealmBansPanel: () => null }));
mock.module('../src/community/realm-presentation-panel', () => ({ RealmAppearancePanel: () => null }));
mock.module('../src/community/realm-claim-panel', () => ({ RealmClaimPanel: () => null }));
mock.module('../src/community/container-lifecycle-controls', () => ({ ContainerLifecyclePanel: () => null }));
mock.module('../src/community/realm-home-header', () => ({ RealmHomeHeader: () => null }));

const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { spaceQuery, useShelfList } = await import('../src/community/space-queries');
const { ShelfContinuation } = await import('../src/community/publication-controls-view');
const { captureSpacePageAdmission, SpacePageLifetimeHost, useSpacePageLifetime } =
  await import('../src/community/space-page-lifetime');
const { SpacePage } = await import('../src/community/space-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { Route: spaceRoute } = await import('../src/routes/spaces/$address');
const { Route: realmRoute } = await import('../src/routes/realms/$id');

type RouteLoader = (input: {
  params: { address: string };
  context: { queryClient: QueryClient };
  abortController: AbortController;
}) => Promise<{ page: SpacePageData; admission: SpacePageAdmission }>;
const actualSpaceLoader = (spaceRoute.options as unknown as { loader: RouteLoader }).loader;

function fileRouteTree(route: unknown, path: string) {
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient; credentialMode: 'anonymous' }>()({
    component: Outlet,
  });
  const registered = (route as { update: (options: never) => unknown }).update({
    id: path,
    path,
    getParentRoute: () => rootRoute,
  } as never);
  return rootRoute.addChildren([registered as never]);
}

async function mountFileRoute(tree: ReturnType<typeof fileRouteTree>, entry: string, queryClient: QueryClient) {
  await close(false);
  calls.pages.length = 0;
  calls.realms.length = 0;
  calls.boards.length = 0;
  calls.publications.length = 0;
  client = queryClient;
  const nextRouter = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [entry] }),
    context: { queryClient, credentialMode: 'anonymous' },
  });
  router = nextRouter;
  await nextRouter.load();
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={nextRouter} />
      </QueryClientProvider>,
    );
    await tick();
  });
}

const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: Root | undefined;
let client: QueryClient | undefined;
let router: ReturnType<typeof createRouter> | undefined;
let view: ReactNode = null;
let strictMode = false;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function pageTarget(routeAddress = address): SpacePageTarget {
  return { kind: 'space', address: routeAddress };
}

function PageFrame({
  page,
  admission,
  target = pageTarget(),
  locale = 'en',
  credentialMode = 'anonymous',
}: {
  page: SpacePageData;
  admission: SpacePageAdmission;
  target?: SpacePageTarget;
  locale?: string;
  credentialMode?: 'anonymous' | 'session';
}) {
  return (
    <SpacePageLifetimeHost
      page={page}
      admission={admission}
      target={target}
      locale={locale}
      credentialMode={credentialMode}
    >
      <SpacePage page={page} />
    </SpacePageLifetimeHost>
  );
}

let latestShelfProbe: ReturnType<typeof useShelfList<RealmBoard>> | undefined;

function ShelfProbe({
  initial,
  read,
}: {
  initial: { items: RealmBoard[]; next: string | null; unavailable: number; credentialMode: 'anonymous' | 'session' };
  read: (input: { cursor?: string; credentialMode: 'anonymous' | 'session' }) => Promise<ShelfPage<RealmBoard>>;
}) {
  const lifetime = useSpacePageLifetime();
  const shelf = useShelfList(initial, read, lifetime);
  latestShelfProbe = shelf;
  return (
    <>
      <output aria-label="Shelf probe">{shelf.items.map((item) => item.title).join(',')}</output>
      <ShelfContinuation {...shelf} label={m.realm_boards_more()} />
    </>
  );
}

async function loadSpaceRoute(
  queryClient: QueryClient,
  routeAddress = address,
): Promise<{ page: SpacePageData; admission: SpacePageAdmission }> {
  return actualSpaceLoader({
    params: { address: routeAddress },
    context: { queryClient },
    abortController: new AbortController(),
  });
}

function sameQueryKey(actual: readonly unknown[], expected: readonly unknown[]) {
  return actual.length === expected.length && actual.every((part, index) => part === expected[index]);
}

function retireObservedSession(client: QueryClient, transition: 'equal' | 'error' | 'remove' | 'aba') {
  if (transition === 'equal') client.setQueryData(sessionQuery.queryKey, viewer());
  if (transition === 'aba') {
    client.setQueryData(sessionQuery.queryKey, signedOut());
    client.setQueryData(sessionQuery.queryKey, viewer());
  }
  if (transition === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  if (transition === 'error') {
    const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    if (!query) throw new Error('Missing prepared session query');
    query.setState({
      ...query.state,
      status: 'error',
      error: new Error('session refresh failed'),
      errorUpdateCount: query.state.errorUpdateCount + 1,
    });
  }
}

async function loadSessionSpace(queryClient: QueryClient, routeAddress = address, locale = 'en') {
  const admission = captureSpacePageAdmission(queryClient, {
    target: pageTarget(routeAddress),
    locale,
    credentialMode: 'session',
  });
  const result = await queryClient.fetchQuery(spaceQuery(routeAddress, locale, 'session', admission));
  return { page: result.page, admission: result.admission };
}

function makeRouter(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: () => view });
  const nextRouter = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context: { queryClient, credentialMode: 'anonymous' },
  });
  router = nextRouter;
  return nextRouter;
}

async function mount(
  node: ReactNode,
  options: {
    strict?: boolean;
    session?: ReturnType<typeof viewer> | ReturnType<typeof signedOut> | null;
    queryClient?: QueryClient;
  } = {},
) {
  await close(false);
  calls.pages.length = 0;
  calls.realms.length = 0;
  calls.boards.length = 0;
  calls.publications.length = 0;
  pageReader = async (input) => pageFor(input.address, false);
  realmReader = async () => ({ kind: 'page', page: pageFor(address) });
  boardReader = async () => ({ kind: 'page', items: [], next: null, unavailable: 0 });
  publicationReader = async () => ({ kind: 'page', items: [], next: null, unavailable: 0 });
  const nextClient =
    options.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client = nextClient;
  if (options.session && !options.queryClient) nextClient.setQueryData(sessionQuery.queryKey, options.session);
  view = node;
  strictMode = options.strict ?? false;
  const nextRouter = makeRouter(nextClient);
  await nextRouter.load();
  root = createRoot(host);
  const contents = strictMode ? (
    <StrictMode>
      <RouterProvider router={nextRouter} />
    </StrictMode>
  ) : (
    <RouterProvider router={nextRouter} />
  );
  await act(async () => {
    root!.render(<QueryClientProvider client={nextClient}>{contents}</QueryClientProvider>);
    await tick();
  });
}

async function repaint(node: ReactNode) {
  view = node;
  const contents = strictMode ? (
    <StrictMode>
      <RouterProvider router={router!} />
    </StrictMode>
  ) : (
    <RouterProvider router={router!} />
  );
  await act(async () => {
    root!.render(<QueryClientProvider client={client!}>{contents}</QueryClientProvider>);
    await tick();
  });
}

async function close(clearClient = true) {
  if (root) {
    await act(async () => {
      root!.unmount();
      await tick();
    });
    root = undefined;
  }
  if (clearClient) client?.clear();
  client = undefined;
  router = undefined;
  strictMode = false;
  host.textContent = '';
  latestShelfProbe = undefined;
}

function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!button) throw new Error(`No button named ${label}`);
  button.click();
}

async function settle() {
  await act(async () => {
    await tick();
  });
}

afterEach(async () => {
  await close();
  setLocale('en', { reload: false });
  pageReader = async (input) => pageFor(input.address, false);
  realmReader = async () => ({ kind: 'page', page: pageFor(address) });
  boardReader = async () => ({ kind: 'page', items: [], next: null, unavailable: 0 });
  publicationReader = async () => ({ kind: 'page', items: [], next: null, unavailable: 0 });
  calls.pages.length = 0;
  calls.realms.length = 0;
  calls.boards.length = 0;
  calls.publications.length = 0;
});

afterAll(async () => {
  mock.restore();
  host.remove();
  window.happyDOM.abort();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('Complete Space and Realm route/query/page/shelf caller lifetime', () => {
  test('the actual Space loader binds its anonymous read and the public page hydrates through initial session preparation', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    pageReader = async (input) => pageFor(input.address, false);
    const loaded = await loadSpaceRoute(nextClient);
    expect(loaded.admission).toMatchObject({
      credentialMode: 'anonymous',
      locale: 'en',
      target: { kind: 'space', address },
      sessionState: 'unknown',
      sessionDataUpdateCount: 0,
    });
    expect(calls.pages).toEqual([{ address, credentialMode: 'anonymous' }]);

    view = <PageFrame page={loaded.page} admission={loaded.admission} />;
    const nextRouter = makeRouter(nextClient);
    await nextRouter.load();
    const initial = (
      <QueryClientProvider client={nextClient}>
        <RouterProvider router={nextRouter} />
      </QueryClientProvider>
    );
    const serverHtml = renderToString(initial);
    expect(serverHtml).toContain(title);

    // The browser prepares its ordinary anonymous session after the loader snapshot exists.
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    root = createRoot(host);
    await act(async () => {
      root!.render(initial);
      await tick();
    });
    expect(host.textContent).toContain(title);
    expect(calls.pages).toHaveLength(1);
  });

  test('the actual Realm loader binds its target and locale to the same page and shelf composition', async () => {
    setLocale('ja', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    realmReader = async () => ({ kind: 'page', page: pageFor(address, true) });
    await mountFileRoute(fileRouteTree(realmRoute, '/realms/$id'), `/realms/${realmId}`, nextClient);
    expect(calls.realms).toEqual([{ realmId, credentialMode: 'anonymous' }]);
    expect(host.textContent).toContain('Lifetime Realm');
    expect(host.textContent).toContain('Original board');
    expect(host.textContent).toContain('Original publication');
  });

  test('mounted route recovery refreshes one retired public visit without looping', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    let reads = 0;
    pageReader = async (input) => {
      reads++;
      return {
        ...pageFor(input.address, false),
        space: { id: spaceId, title: `Mounted public result ${reads}`, summary: '' },
      };
    };
    await mountFileRoute(fileRouteTree(spaceRoute, '/spaces/$address'), `/spaces/${address}`, nextClient);
    expect(host.textContent).toContain('Mounted public result 1');
    await act(async () => {
      nextClient.setQueryData(sessionQuery.queryKey, signedOut());
      await tick();
    });
    await settle();
    expect(host.textContent).toContain('Mounted public result 2');
    expect(reads).toBe(2);
    expect(calls.pages).toHaveLength(2);
  });

  test('the actual Space route composes its signed-in query and hides an obsolete ready result while the replacement is pending', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, viewer());
    const replacement = deferred<SpacePageData>();
    let privateReads = 0;
    pageReader = async (input) => {
      if (input.credentialMode === 'anonymous')
        return { ...pageFor(input.address, false), space: { id: spaceId, title: 'Public route page', summary: '' } };
      privateReads++;
      if (privateReads === 1)
        return {
          ...pageFor(input.address, false, 'session'),
          space: { id: spaceId, title: 'Original private route page', summary: '' },
        };
      return replacement.promise;
    };

    await mountFileRoute(fileRouteTree(spaceRoute, '/spaces/$address'), `/spaces/${address}`, nextClient);
    expect(host.textContent).toContain('Original private route page');
    expect(calls.pages).toEqual([
      { address, credentialMode: 'anonymous' },
      { address, credentialMode: 'session' },
    ]);

    await act(async () => {
      nextClient.setQueryData(sessionQuery.queryKey, viewer('csrf-replacement'));
      await tick();
    });
    expect(host.textContent).not.toContain('Original private route page');
    expect(calls.pages).toHaveLength(3);
    replacement.resolve({
      ...pageFor(address, false, 'session'),
      space: { id: spaceId, title: 'Replacement private route page', summary: '' },
    });
    await settle();
    expect(host.textContent).toContain('Replacement private route page');
  });

  test('a same-key cached route success is refreshed before the loader can reuse it for a later visit', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    pageReader = async (input) => pageFor(input.address, false);
    const first = await loadSpaceRoute(nextClient);
    expect(first.page.space.title).toBe(title);
    pageReader = async (input) => ({
      ...pageFor(input.address, false),
      space: { id: spaceId, title: 'Fresh route read', summary: '' },
    });
    const second = await loadSpaceRoute(nextClient);
    expect(second.admission.readId).not.toBe(first.admission.readId);
    expect(second.page.space.title).toBe('Fresh route read');
    expect(calls.pages).toHaveLength(2);
  });

  test('the actual loader recovers once when its committed Query success is retired before continuation', async () => {
    setLocale('en', { reload: false });
    for (const transition of ['equal', 'error', 'remove', 'aba'] as const) {
      calls.pages.length = 0;
      const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      client = nextClient;
      nextClient.setQueryData(sessionQuery.queryKey, viewer());
      let reads = 0;
      pageReader = async (input) => {
        reads++;
        return {
          ...pageFor(input.address, false),
          space: { id: spaceId, title: `${transition} read ${reads}`, summary: '' },
        };
      };
      const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
      let retired = false;
      const stop = nextClient.getQueryCache().subscribe((event) => {
        if (
          !retired &&
          event.type === 'updated' &&
          'action' in event &&
          event.action.type === 'success' &&
          sameQueryKey(event.query.queryKey, queryKey)
        ) {
          retired = true;
          retireObservedSession(nextClient, transition);
        }
      });
      try {
        const recovered = await loadSpaceRoute(nextClient);
        expect(retired).toBe(true);
        expect(recovered.page.space.title).toBe(`${transition} read 2`);
        expect(reads).toBe(2);
        expect(calls.pages).toHaveLength(2);
      } finally {
        stop();
      }
    }
  });

  test('a session Query setState notification retires the actual loader read', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, viewer());
    calls.pages.length = 0;
    let reads = 0;
    pageReader = async (input) => {
      reads++;
      return {
        ...pageFor(input.address, false),
        space: { id: spaceId, title: `setState read ${reads}`, summary: '' },
      };
    };
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    let retired = false;
    const stop = nextClient.getQueryCache().subscribe((event) => {
      if (
        retired ||
        event.type !== 'updated' ||
        !('action' in event) ||
        event.action.type !== 'success' ||
        !sameQueryKey(event.query.queryKey, queryKey)
      )
        return;
      retired = true;
      const session = nextClient.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      if (!session) throw new Error('Missing prepared session query');
      session.setState({ ...session.state });
    });
    try {
      const recovered = await loadSpaceRoute(nextClient);
      expect(retired).toBe(true);
      expect(recovered.page.space.title).toBe('setState read 2');
      expect(reads).toBe(2);
    } finally {
      stop();
    }
  });

  test('the actual loader stops after one fresh recovery when each committed result is retired', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, viewer());
    let reads = 0;
    pageReader = async (input) => {
      reads++;
      return {
        ...pageFor(input.address, false),
        space: { id: spaceId, title: `Retired attempt ${reads}`, summary: '' },
      };
    };
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    const stop = nextClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        'action' in event &&
        event.action.type === 'success' &&
        sameQueryKey(event.query.queryKey, queryKey)
      )
        nextClient.setQueryData(sessionQuery.queryKey, viewer());
    });
    try {
      await expect(loadSpaceRoute(nextClient)).rejects.toThrow('obsolete visit');
      expect(reads).toBe(2);
      expect(calls.pages).toHaveLength(2);
    } finally {
      stop();
    }
  });

  test('removing the exact original Query allows one fresh read when no successor owns its cache entry', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    let reads = 0;
    pageReader = async (input) => {
      reads++;
      return {
        ...pageFor(input.address, false),
        space: { id: spaceId, title: `Fresh after removal ${reads}`, summary: '' },
      };
    };
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    let removed = false;
    const stop = nextClient.getQueryCache().subscribe((event) => {
      if (
        !removed &&
        event.type === 'updated' &&
        'action' in event &&
        event.action.type === 'success' &&
        sameQueryKey(event.query.queryKey, queryKey)
      ) {
        removed = true;
        nextClient.removeQueries({ queryKey, exact: true });
      }
    });
    try {
      const recovered = await loadSpaceRoute(nextClient);
      expect(removed).toBe(true);
      expect(recovered.page.space.title).toBe('Fresh after removal 2');
      expect(reads).toBe(2);
    } finally {
      stop();
    }
  });

  test('a replaced result or recreated healthy Query stays owned by its successor', async () => {
    setLocale('en', { reload: false });
    for (const replacement of ['result', 'query'] as const) {
      calls.pages.length = 0;
      const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      client = nextClient;
      let reads = 0;
      pageReader = async (input) => {
        reads++;
        return {
          ...pageFor(input.address, false),
          space: { id: spaceId, title: `Predecessor ${reads}`, summary: '' },
        };
      };
      const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
      let replaced = false;
      let originalQuery: unknown;
      const stop = nextClient.getQueryCache().subscribe((event) => {
        if (
          !replaced &&
          event.type === 'updated' &&
          'action' in event &&
          event.action.type === 'success' &&
          sameQueryKey(event.query.queryKey, queryKey)
        ) {
          replaced = true;
          originalQuery = event.query;
          const current = nextClient.getQueryData<SpacePageQueryResult>(queryKey);
          if (!current) throw new Error('Missing committed page result');
          if (replacement === 'query') nextClient.removeQueries({ queryKey, exact: true });
          nextClient.setQueryData<SpacePageQueryResult>(queryKey, {
            ...current,
            page: {
              ...current.page,
              space: { ...current.page.space, title: `Healthy ${replacement} successor` },
            },
          });
        }
      });
      try {
        await expect(loadSpaceRoute(nextClient)).rejects.toThrow('obsolete visit');
        const successor = nextClient.getQueryData<SpacePageQueryResult>(queryKey);
        expect(replaced).toBe(true);
        expect(successor?.page.space.title).toBe(`Healthy ${replacement} successor`);
        expect(reads).toBe(1);
        expect(calls.pages).toHaveLength(1);
        if (replacement === 'query')
          expect(nextClient.getQueryCache().find({ queryKey, exact: true })).not.toBe(originalQuery);
      } finally {
        stop();
      }
    }
  });

  test('an equal manual page success retires the loader and keeps the committed successor data', async () => {
    setLocale('en', { reload: false });
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    let reads = 0;
    pageReader = async (input) => {
      reads++;
      return {
        ...pageFor(input.address, false),
        space: { id: spaceId, title: `Predecessor ${reads}`, summary: '' },
      };
    };
    const queryKey = spaceQuery(address, 'en', 'anonymous').queryKey;
    let originalQuery: unknown;
    let replaced = false;
    const stop = nextClient.getQueryCache().subscribe((event) => {
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
      const committed = nextClient.getQueryData<SpacePageQueryResult>(queryKey);
      if (!committed) throw new Error('Missing committed page result');
      nextClient.setQueryData<SpacePageQueryResult>(queryKey, committed);
    });
    try {
      await expect(loadSpaceRoute(nextClient)).rejects.toThrow('obsolete visit');
      const successor = nextClient.getQueryData<SpacePageQueryResult>(queryKey);
      const successorQuery = nextClient.getQueryCache().find({ queryKey, exact: true });
      expect(replaced).toBe(true);
      expect(successor?.page.space.title).toBe('Predecessor 1');
      expect(successorQuery).toBe(originalQuery);
      expect(successorQuery?.state.dataUpdateCount).toBe(2);
      expect(reads).toBe(1);
    } finally {
      stop();
    }
  });

  test('a same-account credential replacement rejects an in-flight private page result before QueryClient caches success', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, viewer());
    const read = deferred<SpacePageData>();
    pageReader = async () => read.promise;
    const admission = captureSpacePageAdmission(nextClient, {
      target: pageTarget(),
      locale: 'en',
      credentialMode: 'session',
    });
    const query = nextClient.fetchQuery(spaceQuery(address, 'en', 'session', admission));
    await tick();
    expect(calls.pages).toHaveLength(1);
    nextClient.setQueryData(sessionQuery.queryKey, viewer('csrf-two'));
    // Resolve the deferred server response before awaiting its obsolete query completion.
    read.resolve(pageFor(address, false, 'session'));
    await expect(query).rejects.toThrow('obsolete visit');
    expect(nextClient.getQueryData(spaceQuery(address, 'en', 'session').queryKey)).toBeUndefined();
  });

  test('current signed-in page results render under their exact session observation and ordinary rerenders preserve them', async () => {
    const loaded = await (async () => {
      const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      client = nextClient;
      nextClient.setQueryData(sessionQuery.queryKey, viewer());
      pageReader = async (input) => pageFor(input.address, false, input.credentialMode);
      return { client: nextClient, result: await loadSessionSpace(nextClient) };
    })();
    await mount(<PageFrame page={loaded.result.page} admission={loaded.result.admission} />, {
      queryClient: loaded.client,
    });
    expect(host.textContent).toContain(title);
    const before = calls.pages.length;
    await repaint(<PageFrame page={loaded.result.page} admission={loaded.result.admission} />);
    expect(host.textContent).toContain(title);
    expect(calls.pages).toHaveLength(before);
  });

  test('hydration with a replacement session tuple has no fallback authority for private loader rows', async () => {
    const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    serverClient.setQueryData(sessionQuery.queryKey, viewer());
    pageReader = async (input) => pageFor(input.address, false, input.credentialMode);
    const loaded = await loadSessionSpace(serverClient);
    const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    browserClient.setQueryData(sessionQuery.queryKey, viewer('csrf-replaced'), {
      updatedAt: loaded.admission.sessionDataUpdatedAt,
    });
    await mount(
      <PageFrame page={loaded.page} admission={structuredClone(loaded.admission)} credentialMode="session" />,
      {
        queryClient: browserClient,
      },
    );
    expect(host.textContent).not.toContain(title);
  });

  test('serialized public admission bridges only an exact hydrated session tuple and update count', async () => {
    const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    serverClient.setQueryData(sessionQuery.queryKey, signedOut());
    pageReader = async (input) => pageFor(input.address, false);
    const loaded = await loadSpaceRoute(serverClient);
    const admission = structuredClone(loaded.admission);
    const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    browserClient.setQueryData(sessionQuery.queryKey, signedOut(), {
      updatedAt: admission.sessionDataUpdatedAt,
    });
    await mount(<PageFrame page={loaded.page} admission={admission} />, { queryClient: browserClient });
    expect(host.textContent).toContain(title);
    await act(async () => {
      browserClient.setQueryData(sessionQuery.queryKey, signedOut());
      await tick();
    });
    expect(host.textContent).not.toContain(title);
  });

  test('same-account token/readiness changes, signed-out changes and batched away/back retire rendered private rows', async () => {
    for (const transition of ['token', 'readiness', 'sign-out', 'away-back'] as const) {
      const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      client = nextClient;
      nextClient.setQueryData(sessionQuery.queryKey, viewer());
      pageReader = async (input) => pageFor(input.address, false, input.credentialMode);
      const loaded = await loadSessionSpace(nextClient);
      await mount(<PageFrame page={loaded.page} admission={loaded.admission} credentialMode="session" />, {
        queryClient: nextClient,
      });
      expect(host.textContent).toContain(title);
      await act(async () => {
        if (transition === 'token') nextClient.setQueryData(sessionQuery.queryKey, viewer('csrf-two'));
        if (transition === 'readiness') {
          nextClient.setQueryData(sessionQuery.queryKey, {
            state: 'unavailable' as const,
            subject: reader,
            csrfToken: null,
          });
          nextClient.setQueryData(sessionQuery.queryKey, viewer('csrf-one'));
        }
        if (transition === 'sign-out') nextClient.setQueryData(sessionQuery.queryKey, signedOut());
        if (transition === 'away-back') {
          nextClient.setQueryData(sessionQuery.queryKey, viewer('csrf-away'));
          nextClient.setQueryData(sessionQuery.queryKey, viewer());
        }
        await tick();
      });
      expect(host.textContent).not.toContain(title);
      await close();
    }
  });

  test('two shelf reads retire independently before and after their deferred responses settle', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, viewer());
    pageReader = async (input) => pageFor(input.address, true, input.credentialMode);
    const loaded = await loadSessionSpace(nextClient);
    const boardResponse = deferred<ShelfPage<RealmBoard>>();
    const publicationResponse = deferred<ShelfPage<PublishedSubject>>();
    boardReader = async () => boardResponse.promise;
    publicationReader = async () => publicationResponse.promise;
    await mount(<PageFrame page={loaded.page} admission={loaded.admission} credentialMode="session" />, {
      queryClient: nextClient,
      strict: true,
    });
    expect(host.textContent).toContain('Original board');
    expect(host.textContent).toContain('Original publication');
    click(m.realm_boards_more());
    click(m.realm_publications_more());
    expect(calls.boards).toEqual([{ realmId, cursor: 'board-cursor-one', credentialMode: 'session' }]);
    expect(calls.publications).toEqual([{ realmId, cursor: 'publication-cursor-one', credentialMode: 'session' }]);

    await act(async () => {
      client!.setQueryData(sessionQuery.queryKey, viewer('csrf-two'));
      await tick();
    });
    boardResponse.resolve({ kind: 'page', items: [board(id(40), 'Obsolete board')], next: null, unavailable: 0 });
    publicationResponse.resolve({
      kind: 'page',
      items: [publication(id(41), 'Obsolete publication')],
      next: null,
      unavailable: 0,
    });
    await settle();
    expect(host.textContent).not.toContain('Obsolete board');
    expect(host.textContent).not.toContain('Obsolete publication');
    expect(calls.boards).toHaveLength(1);
    expect(calls.publications).toHaveLength(1);
  });

  test('current explicit next and retry preserve independent cursors, bounded reads and merge behavior', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    pageReader = async (input) => pageFor(input.address, true, input.credentialMode);
    const route = await loadSpaceRoute(nextClient);
    await mount(<PageFrame page={route.page} admission={route.admission} />, { queryClient: nextClient });
    let boardCall = 0;
    boardReader = async () => {
      boardCall++;
      return boardCall === 1
        ? { kind: 'unavailable' }
        : { kind: 'page', items: [board(id(50), 'Restart board')], next: 'board-cursor-two', unavailable: 1 };
    };
    publicationReader = async () => ({
      kind: 'page',
      items: [publication(id(51), 'Next publication')],
      next: null,
      unavailable: 0,
    });
    click(m.realm_boards_more());
    click(m.realm_publications_more());
    await settle();
    expect(host.textContent).toContain(m.realm_shelf_unavailable());
    expect(host.textContent).toContain('Next publication');
    click(m.realm_shelf_retry());
    await settle();
    expect(calls.boards).toEqual([
      { realmId, cursor: 'board-cursor-one', credentialMode: 'anonymous' },
      { realmId, cursor: 'board-cursor-one', credentialMode: 'anonymous' },
    ]);
    expect(host.textContent).toContain('Original board');
    expect(host.textContent).toContain('Restart board');
    expect(calls.publications).toEqual([{ realmId, cursor: 'publication-cursor-one', credentialMode: 'anonymous' }]);
  });

  test('failed fresh reads retain their window and retry the first page even after exhaustion', async () => {
    for (const next of [null, 'retained-cursor']) {
      const initial = { items: [board()], next, unavailable: 2, credentialMode: 'anonymous' as const };
      const fresh = deferred<ShelfPage<RealmBoard>>();
      const replacement = { ...initial, items: [board(id(52), 'Fresh board')], next: null, unavailable: 1 };
      const requests: { cursor?: string; credentialMode: 'anonymous' | 'session' }[] = [];
      await mount(
        <ShelfProbe
          initial={initial}
          read={async (input) => {
            requests.push(input);
            if (requests.length === 1) throw new Error('Transient transport failure');
            return requests.length === 2 ? fresh.promise : { kind: 'denied' };
          }}
        />,
      );
      await act(() => latestShelfProbe!.load(true));
      expect(latestShelfProbe).toMatchObject({ ...initial, failure: 'unavailable' });
      await act(() => click(m.realm_shelf_retry()));
      expect(latestShelfProbe).toMatchObject({ ...initial, busy: true });
      expect(host.querySelector('button')?.disabled).toBe(true);
      await act(() => fresh.resolve({ ...replacement, kind: 'page' }));
      expect(requests).toEqual([{ credentialMode: 'anonymous' }, { credentialMode: 'anonymous' }]);
      expect(latestShelfProbe).toMatchObject({ ...replacement, failure: null });
      expect(host.querySelector('button')).toBeNull();
      await act(() => latestShelfProbe!.load(true));
      expect(latestShelfProbe).toMatchObject({ items: [], unavailable: 0, failure: 'denied' });
    }
  });

  test('saved update and continuation callbacks cannot change a new target, locale or remounted visit', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    const admission = captureSpacePageAdmission(nextClient, {
      target: pageTarget(),
      locale: 'en',
      credentialMode: 'anonymous',
    });
    const routePage = pageFor(address, false);
    const bound = await nextClient.fetchQuery(spaceQuery(address, 'en', 'anonymous', admission));
    const pageAdmission = bound.admission;
    const initial = { items: [board()], next: 'old-cursor', unavailable: 0, credentialMode: 'anonymous' as const };
    const read = async (input: { cursor?: string; credentialMode: 'anonymous' | 'session' }) => {
      calls.boards.push({ realmId, ...input });
      return { kind: 'page' as const, items: [], next: null, unavailable: 0 };
    };
    await mount(
      <SpacePageLifetimeHost
        page={routePage}
        admission={pageAdmission}
        target={pageTarget()}
        locale="en"
        credentialMode="anonymous"
      >
        <ShelfProbe initial={initial} read={read} />
      </SpacePageLifetimeHost>,
      { queryClient: nextClient },
    );
    const saved = latestShelfProbe!;
    await act(async () => {
      saved.update((previous) => ({ ...previous, items: [board(id(61), 'Current update')] }));
      await tick();
    });
    expect(host.textContent).toContain('Current update');
    await repaint(
      <SpacePageLifetimeHost
        page={routePage}
        admission={pageAdmission}
        target={pageTarget('another-space')}
        locale="en"
        credentialMode="anonymous"
      >
        <ShelfProbe initial={initial} read={read} />
      </SpacePageLifetimeHost>,
    );
    await act(async () => {
      await saved.load();
      saved.update((previous) => ({ ...previous, items: [board(id(60), 'Stale update')] }));
      await tick();
    });
    expect(calls.boards).toHaveLength(0);
    expect(host.textContent).not.toContain('Stale update');

    // The same admission cannot be rebound after a real unmount/remount; a new route read is required.
    await close(false);
    await mount(
      <SpacePageLifetimeHost
        page={routePage}
        admission={pageAdmission}
        target={pageTarget()}
        locale="en"
        credentialMode="anonymous"
      >
        <ShelfProbe initial={initial} read={read} />
      </SpacePageLifetimeHost>,
      { queryClient: nextClient },
    );
    expect(host.textContent).not.toContain('Original board');
    expect(host.textContent).not.toContain(title);
    await act(async () => {
      await saved.load(true);
      await tick();
    });
    expect(calls.boards).toHaveLength(0);

    const localeClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    localeClient.setQueryData(sessionQuery.queryKey, signedOut());
    const localeAdmission = captureSpacePageAdmission(localeClient, {
      target: pageTarget(),
      locale: 'en',
      credentialMode: 'anonymous',
    });
    const localeRead = await localeClient.fetchQuery(spaceQuery(address, 'en', 'anonymous', localeAdmission));
    const localePage = localeRead.page;
    const boundLocaleAdmission = localeRead.admission;
    await mount(
      <SpacePageLifetimeHost
        page={localePage}
        admission={boundLocaleAdmission}
        target={pageTarget()}
        locale="en"
        credentialMode="anonymous"
      >
        <ShelfProbe initial={initial} read={read} />
      </SpacePageLifetimeHost>,
      { queryClient: localeClient },
    );
    const localeSaved = latestShelfProbe!;
    await repaint(
      <SpacePageLifetimeHost
        page={localePage}
        admission={boundLocaleAdmission}
        target={pageTarget()}
        locale="fr"
        credentialMode="anonymous"
      >
        <ShelfProbe initial={initial} read={read} />
      </SpacePageLifetimeHost>,
    );
    expect(host.textContent).not.toContain(title);
    await act(async () => {
      await localeSaved.load();
      localeSaved.update((previous) => ({ ...previous, items: [board(id(62), 'Stale locale update')] }));
      await tick();
    });
    expect(calls.boards).toHaveLength(0);
    expect(host.textContent).not.toContain('Stale locale update');
  });

  test('StrictMode effect reconnection keeps one healthy visit able to continue both shelves', async () => {
    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client = nextClient;
    nextClient.setQueryData(sessionQuery.queryKey, signedOut());
    pageReader = async (input) => pageFor(input.address, true, input.credentialMode);
    const loaded = await loadSpaceRoute(nextClient);
    boardReader = async () => ({ kind: 'page', items: [board(id(70), 'Current board')], next: null, unavailable: 0 });
    publicationReader = async () => ({
      kind: 'page',
      items: [publication(id(71), 'Current publication')],
      next: null,
      unavailable: 0,
    });
    await mount(<PageFrame page={loaded.page} admission={loaded.admission} />, {
      queryClient: nextClient,
      strict: true,
    });
    click(m.realm_boards_more());
    click(m.realm_publications_more());
    await settle();
    expect(host.textContent).toContain('Current board');
    expect(host.textContent).toContain('Current publication');
    expect(calls.boards).toHaveLength(1);
    expect(calls.publications).toHaveLength(1);
  });
});

test('the mounted Realm return reads only its selected native window and keeps publication continuation independent', async () => {
  setLocale('en', { reload: false });
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  nextClient.setQueryData(sessionQuery.queryKey, signedOut());
  const selectedId = id(71);
  realmReader = async () => ({ kind: 'page', page: pageFor(address) });
  boardReader = async () => ({
    kind: 'page',
    items: [board(selectedId, 'Selected board window')],
    next: 'next-board',
    unavailable: 0,
  });
  publicationReader = async () => ({
    kind: 'page',
    items: [publication(id(72), 'Independent publication window')],
    next: null,
    unavailable: 0,
  });
  await mountFileRoute(
    fileRouteTree(realmRoute, '/realms/$id'),
    `/realms/${realmId}?node=boards&cursor=original%2Fwindow#realm-board-${selectedId}`,
    nextClient,
  );
  await settle();
  expect(calls.boards).toEqual([{ realmId, cursor: 'original/window', credentialMode: 'anonymous' }]);
  expect(calls.publications).toEqual([]);
  expect(host.textContent).toContain('Selected board window');
  expect(host.textContent).not.toContain('Original board');
  const link = host.querySelector<HTMLAnchorElement>(`#realm-board-${selectedId} a`)!;
  expect(new URL(link.href).searchParams.get('returnTo')).toBe(
    `/en/realms/${realmId}?node=boards&cursor=original%2Fwindow#realm-board-${selectedId}`,
  );
  await act(async () => click(m.realm_publications_more()));
  await settle();
  expect(calls.publications).toEqual([{ realmId, cursor: 'publication-cursor-one', credentialMode: 'anonymous' }]);
  expect(calls.boards).toHaveLength(1);
  expect(host.textContent).toContain('Selected board window');
  expect(host.textContent).toContain('Independent publication window');
  expect(
    new URL(host.querySelector<HTMLAnchorElement>(`#realm-publication-${id(72)} a`)!.href).searchParams.get('via'),
  ).toBe(`/en/realms/${realmId}?node=publications&cursor=publication-cursor-one#realm-publication-${id(72)}`);
});

test('replacement and removed carriers retire pending shelf return and detached links', async () => {
  const original = pageFor(address);
  await mount(<SpacePage page={original} />, { session: signedOut() });
  const pending = deferred<ShelfPage<RealmBoard>>();
  boardReader = async () => pending.promise;
  const detached = host.querySelector<HTMLAnchorElement>(`#realm-board-${boardId} a`)!;
  await act(async () => click(m.realm_boards_more()));
  await repaint(<SpacePage page={pageFor(address, false)} />);
  const activation = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  detached.dispatchEvent(activation as unknown as MouseEvent);
  expect(activation.defaultPrevented).toBe(true);
  await act(async () =>
    pending.resolve({ kind: 'page', items: [board(id(73), 'Retired return')], next: null, unavailable: 0 }),
  );
  expect(host.textContent).not.toContain('Retired return');
  expect(host.querySelector('#realm-boards-heading')).toBeNull();
  await repaint(<SpacePage page={pageFor(address)} />);
  expect(host.textContent).toContain('Original board');
  expect(host.textContent).not.toContain('Retired return');
});
