import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import threadRecording from '../src/kernel/recorded/thread.json';
import postsRecording from '../src/kernel/recorded/thread-posts.json';
import accountsRecording from '../src/kernel/recorded/accounts.json';
import boardRecording from '../src/kernel/recorded/board.json';
import realmRecording from '../src/kernel/recorded/board-realm-realm.json';

// Authored composed loader/cache/reader regressions. The full acceptance command is intentionally UNRUN here.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/thread/private-page-title' });
const canonicalLink = window.document.createElement('link');
canonicalLink.rel = 'canonical';
canonicalLink.href = 'https://site.test/en/threads/example/thread';
window.document.head.append(canonicalLink);
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
  createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
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
const viewerId = id(1);
const signedIn = (csrfToken: string | null = 'original-csrf') => ({
  state: 'signed-in' as const,
  subject: viewerId,
  csrfToken,
});
const signedOut = { state: 'signed-out' as const, subject: null, csrfToken: null };
const slug = 'private-page-title';
const mediaId = id(40);
const privateAuthor = {
  ...accountsRecording.accounts[0]!,
  id: viewerId,
  displayName: 'Private page author',
  handle: 'private_page_author',
};
const publicAuthor = { ...privateAuthor, id: id(2), displayName: 'Public page author' };

function pageFor(
  threadId: string,
  {
    privateRead = false,
    body = 'Private page body disclosure',
    title = 'Private page title',
  }: { privateRead?: boolean; body?: string; title?: string } = {},
): ThreadReadingPage {
  const recordedPost = structuredClone(postsRecording.posts[0]!);
  const baseBody = fromPlainText(body, 'blocks');
  const document = {
    ...baseBody,
    doc: {
      ...baseBody.doc,
      content: [
        ...(baseBody.doc.content ?? []),
        { type: 'image', attrs: { id: 'private-image-node', src: mediaId, alt: 'Private media disclosure' } },
      ],
    },
  } as typeof baseBody;
  const authorId = privateRead ? viewerId : publicAuthor.id;
  const firstPost = {
    ...recordedPost,
    id: id(41),
    threadId,
    authorId,
    body: document,
    mediaIds: [mediaId],
    revisionId: id(42),
    sha256: 'a'.repeat(64),
    availability: 'available' as const,
  };
  const thread = {
    ...structuredClone(threadRecording.thread),
    id: threadId,
    authorId,
    title,
    subjectIds: [id(43)],
    firstPost,
    reactions: { like: 2 },
  };
  return {
    thread: thread as ThreadReadingPage['thread'],
    board: { ...boardRecording.board, title: 'Private board placement' } as ThreadReadingPage['board'],
    realm: {
      id: realmRecording.realm.realmId,
      title: 'Private realm placement',
      summary: 'Private realm summary',
    },
    posts: { posts: [firstPost], next: null, rankRefreshedAt: null, status: 200 },
    mentions: {},
    documentMedia: {
      kind: 'ready',
      images: [
        {
          id: mediaId,
          containerId: threadId,
          digest: 'b'.repeat(64),
          width: 640,
          height: 480,
          variants: [{ format: 'webp', width: 640, height: 480 }],
          placeholder: null,
          focalPoint: null,
          credit: null,
        },
      ],
      documents: [
        {
          postId: firstPost.id,
          threadId,
          revisionId: firstPost.revisionId,
          sha256: firstPost.sha256,
          mediaIds: [mediaId],
        },
      ],
    },
    ...(privateRead ? { viewerId } : {}),
    verification: { sitekey: '', scriptUrl: '' },
    authors: { [authorId]: privateRead ? privateAuthor : publicAuthor },
    subjects: [
      {
        id: id(43),
        types: ['work'],
        label: 'Private subject label',
        labels: { en: 'Private subject label' },
        cover: null,
      },
    ],
    provenanceSubjects: [
      {
        id: id(44),
        types: ['work'],
        label: 'Private provenance label',
        labels: { en: 'Private provenance label' },
        cover: null,
      },
    ],
    now: firstPost.createdAt,
  } as ThreadReadingPage;
}

type ReadData = { id: string; cursor?: string; expectedSlug?: string; credentialMode: 'anonymous' | 'session' };
const pageReads: {
  data: ReadData;
  work: ReturnType<typeof deferred<ThreadReadingPage | { redirect: { id: string; title: string | null } }>>;
}[] = [];
const slugReads: { data: ReadData; work: ReturnType<typeof deferred<{ id: string; title: string | null }>> }[] = [];
const readModule = await import('../src/threads/reads');
const personalReads: {
  data: { id: string; postIds: string[]; readReactions: boolean };
  signal?: AbortSignal;
  work: ReturnType<typeof deferred<Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>>>;
}[] = [];

const pageReader = spyOn(readModule, 'readThreadPage').mockImplementation(({ data }) => {
  const work = deferred<ThreadReadingPage | { redirect: { id: string; title: string | null } }>();
  pageReads.push({ data: { ...data } as ReadData, work });
  return work.promise as never;
});
const slugReader = spyOn(readModule, 'readThreadSlug').mockImplementation(({ data }) => {
  const work = deferred<{ id: string; title: string | null }>();
  slugReads.push({ data: { ...data } as ReadData, work });
  return work.promise as never;
});
const personalReader = spyOn(readModule, 'readThreadPersonal').mockImplementation(({ data, signal }) => {
  const work = deferred<Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>>();
  personalReads.push({
    data: { id: data.id, postIds: [...data.postIds], readReactions: data.readReactions },
    signal,
    work,
  });
  return work.promise;
});

const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { sessionQuery } = await import('../src/session/query');
const { Route } = await import('../src/routes/threads/$id_.$slug');
const { Route: SlugRoute } = await import('../src/routes/threads/$id');
const { threadPageQuery } = await import('../src/threads/thread-queries');
const { rememberThreadSlug, rememberedThreadSlug } = await import('../src/threads/thread-href');
const { m } = await import('../src/paraglide/messages.js');
const actions = await import('../src/threads/actions');

type Mode = 'anonymous' | 'session';
type Session = ReturnType<typeof signedIn> | typeof signedOut;

async function mountRoute({
  threadId,
  cursor,
  mode = 'anonymous',
  session = signedOut,
  strict = true,
  slugName = slug,
  rememberedTitle,
  seedPage,
}: {
  threadId: string;
  cursor?: string;
  mode?: Mode;
  session?: Session;
  strict?: boolean;
  slugName?: string;
  rememberedTitle?: string | null;
  seedPage?: ThreadReadingPage;
}) {
  pageReads.length = 0;
  personalReads.length = 0;
  setLocale('en', { reload: false });
  if (rememberedTitle !== undefined) rememberThreadSlug(threadId, rememberedTitle);
  notifyManager.setScheduler((callback) => callback());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  const knownSlug = rememberedThreadSlug(threadId);
  const expectedSlug = knownSlug === slugName ? undefined : slugName;
  if (seedPage) client.setQueryData(threadPageQuery(threadId, cursor, mode, expectedSlug).queryKey, seedPage);
  const parent = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: Mode;
  }>()({ component: Outlet });
  Route.update({
    id: '/threads/$id_/$slug',
    path: '/threads/$id/$slug',
    getParentRoute: () => parent,
  } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: client, credentialMode: mode },
    history: createMemoryHistory({
      initialEntries: [
        `/threads/${threadId}/${slugName}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      ],
    }),
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let root = createRoot(host);
  let operation: Promise<unknown> = router.load();
  const tree = (provider = client) => (
    <QueryClientProvider client={provider}>
      {strict ? (
        <StrictMode>
          <RouterProvider router={router} />
        </StrictMode>
      ) : (
        <RouterProvider router={router} />
      )}
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(tree());
    await Promise.resolve();
  });
  const settlePage = async (
    index: number,
    result: ThreadReadingPage | { redirect: { id: string; title: string | null } },
  ) => {
    await act(async () => {
      pageReads[index]!.work.resolve(result);
      await operation.catch(() => undefined);
      await Promise.resolve();
    });
  };
  const settlePersonal = async (
    index: number,
    result: Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>,
  ) => {
    await act(async () => {
      personalReads[index]!.work.resolve(result);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    router.dispose();
    client.clear();
    host.remove();
  };
  return {
    client,
    host,
    router,
    tree,
    settlePage,
    settlePersonal,
    setOperation(value: Promise<unknown>) {
      operation = value;
    },
    async rerender(provider = client, before?: () => void) {
      await act(async () => {
        before?.();
        root.render(tree(provider));
      });
    },
    async remount() {
      await act(async () => root.unmount());
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      root = createRoot(host);
      await act(async () => root.render(tree()));
    },
    dispose,
  };
}

function personalFor(threadId: string, postId: string, currentViewer = viewerId) {
  return {
    viewerId: currentViewer,
    reactions: {
      [threadId]: { state: 'ready', value: 'like' },
      [postId]: { state: 'ready', value: 'love' },
    },
    reviewVotes: {},
  } as Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>;
}

function erasedPageFor(threadId: string, body = 'Erased page body') {
  const page = pageFor(threadId, { privateRead: true, body });
  page.posts.posts = [
    {
      ...page.posts.posts[0]!,
      body: null,
      sha256: null,
      availability: 'erased' as const,
      restorableUntil: '2026-11-10T00:00:00.000Z',
    } as ThreadReadingPage['posts']['posts'][number],
  ];
  return page;
}

function expectPrivatePageHidden(host: HTMLElement) {
  for (const text of [
    'Private page body disclosure',
    'Private page title',
    'Private page author',
    'Private media disclosure',
    mediaId,
    id(42),
    viewerId,
    'Private board placement',
    'Private realm placement',
    'Private realm summary',
    'Private subject label',
    'Private provenance label',
  ])
    expect(host.innerHTML).not.toContain(text);
  expect(host.querySelector('[data-slot="document-image"]')).toBeNull();
}

function threadRefreshButton(host: HTMLElement) {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === m.thread_post_refresh(),
  );
}

async function pauseUnavailableRefresh(
  page: Awaited<ReturnType<typeof mountRoute>>,
  threadId: string,
  seed: ThreadReadingPage,
  withBackgroundRead = false,
) {
  const queryKey = threadPageQuery(threadId, undefined, 'session').queryKey;
  await act(async () => page.client.removeQueries({ queryKey: ['thread-page', threadId] }));
  await act(async () => {
    page.client.setQueryData(queryKey, seed);
  });
  let backgroundRead: Promise<unknown> | undefined;
  if (withBackgroundRead) {
    await act(async () => {
      backgroundRead = page.client
        .fetchQuery({ ...threadPageQuery(threadId, undefined, 'session'), staleTime: 0, retry: false })
        .catch(() => undefined);
      await Promise.resolve();
    });
  }

  const entered = deferred<void>();
  const resume = deferred<void>();
  const originalCancel = page.client.cancelQueries.bind(page.client);
  const cancel = spyOn(page.client, 'cancelQueries').mockImplementation(async (...args) => {
    await originalCancel(...args);
    entered.resolve(undefined);
    await resume.promise;
  });
  await act(async () => {
    const refresh = threadRefreshButton(page.host);
    expect(refresh).toBeDefined();
    refresh!.click();
    await entered.promise;
  });
  return { queryKey, entered, resume, cancel, backgroundRead };
}

afterAll(async () => {
  pageReader.mockRestore();
  slugReader.mockRestore();
  personalReader.mockRestore();
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('the actual route keeps the healthy anonymous page through SSR and a different hydrated QueryClient', async () => {
  const threadId = id(100);
  setLocale('en', { reload: false });
  const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  serverClient.setQueryData(sessionQuery.queryKey, signedOut);
  const parent = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: Mode;
  }>()({ component: Outlet });
  Route.update({
    id: '/threads/$id_/$slug',
    path: '/threads/$id/$slug',
    getParentRoute: () => parent,
  } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: serverClient, credentialMode: 'anonymous' },
    history: createMemoryHistory({ initialEntries: [`/threads/${threadId}/${slug}`] }),
  });
  const operation = router.load();
  expect(pageReads).toHaveLength(1);
  expect(pageReads[0]!.data).toEqual({ id: threadId, expectedSlug: slug, credentialMode: 'anonymous' });
  pageReads[0]!.work.resolve(pageFor(threadId, { privateRead: false, body: 'Public anonymous page body' }));
  await operation;

  const canonical = window.document.createElement('link');
  canonical.rel = 'canonical';
  canonical.href = `https://site.test/en/threads/${threadId}/${slug}`;
  window.document.head.append(canonical);
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={serverClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  window.document.body.append(host);
  const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  browserClient.setQueryData(sessionQuery.queryKey, signedOut);
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(
      host,
      <QueryClientProvider client={browserClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  expect(host.textContent).toContain('Public anonymous page body');
  expect(pageReads).toHaveLength(1);
  await act(async () => root!.unmount());
  router.dispose();
  serverClient.clear();
  browserClient.clear();
  canonical.remove();
  host.remove();
});

test('a private server result is redacted on both sides of hydration when browser cache authority is independent', async () => {
  const threadId = id(102);
  pageReads.length = 0;
  personalReads.length = 0;
  setLocale('en', { reload: false });
  const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  serverClient.setQueryData(sessionQuery.queryKey, signedIn());
  const parent = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: Mode;
  }>()({ component: Outlet });
  Route.update({
    id: '/threads/$id_/$slug',
    path: '/threads/$id/$slug',
    getParentRoute: () => parent,
  } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: serverClient, credentialMode: 'session' },
    history: createMemoryHistory({ initialEntries: [`/threads/${threadId}/${slug}`] }),
  });
  const operation = router.load();
  expect(pageReads).toHaveLength(1);
  await act(async () => {
    pageReads[0]!.work.resolve(pageFor(threadId, { privateRead: true }));
    await operation;
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.innerHTML = renderToStaticMarkup(
    <QueryClientProvider client={serverClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  window.document.body.append(host);
  expectPrivatePageHidden(host);
  expect(host.textContent).toContain(m.thread_post_unavailable());

  const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  browserClient.setQueryData(sessionQuery.queryKey, signedIn());
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(
      host,
      <QueryClientProvider client={browserClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  expectPrivatePageHidden(host);
  expect(pageReads).toHaveLength(1);
  await act(async () => root!.unmount());
  router.dispose();
  serverClient.clear();
  browserClient.clear();
  host.remove();
});

test('an original pending private route read cannot publish after same-account credential replacement', async () => {
  const threadId = id(101);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  try {
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0]!.data).toEqual({ id: threadId, expectedSlug: slug, credentialMode: 'session' });
    await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(
      page.client
        .getQueryCache()
        .find({ queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey, exact: true }),
    ).toBeUndefined();
    expectPrivatePageHidden(page.host);
  } finally {
    await page.dispose();
  }
});

test('a ready private page and pending personal result retire on readiness loss, sign-out and batched away/back', async () => {
  const replacements: Session[] = [signedIn(null), signedOut, signedIn()];
  for (let index = 0; index < replacements.length; index++) {
    const threadId = id(110 + index);
    const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
    try {
      await page.settlePage(0, pageFor(threadId, { privateRead: true }));
      expect(page.host.textContent).toContain('Private page body disclosure');
      expect(personalReads).toHaveLength(1);
      if (index === 2) {
        await act(async () => {
          page.client.setQueryData(sessionQuery.queryKey, signedOut);
          page.client.setQueryData(sessionQuery.queryKey, signedIn());
        });
      } else {
        await act(async () => page.client.setQueryData(sessionQuery.queryKey, replacements[index]!));
      }
      expectPrivatePageHidden(page.host);
      await page.settlePersonal(0, personalFor(threadId, id(41)));
      expect(
        page.client.getQueryCache().find({ queryKey: ['thread-personal', threadId, null, false, id(41)], exact: true }),
      ).toBeUndefined();
      expectPrivatePageHidden(page.host);
    } finally {
      await page.dispose();
    }
  }
});

test('signed-in page and bounded personal data compose, including a null-CSRF read-only page', async () => {
  const threadId = id(120);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(page.host.textContent).toContain('Private page body disclosure');
    expect(personalReads).toHaveLength(1);
    expect(personalReads[0]!.data).toEqual({ id: threadId, postIds: [], readReactions: false });
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    expect(page.host.querySelector('input[name="idempotency_key"]')).not.toBeNull();
    expect(page.host.querySelector('[data-slot="document-body"]')).not.toBeNull();
  } finally {
    await page.dispose();
  }

  const readOnlyId = id(121);
  const readOnly = await mountRoute({ threadId: readOnlyId, mode: 'session', session: signedIn(null) });
  try {
    await readOnly.settlePage(0, pageFor(readOnlyId, { privateRead: false, body: 'Read-only null-CSRF page' }));
    expect(readOnly.host.textContent).toContain('Read-only null-CSRF page');
    expect(readOnly.host.textContent).not.toContain(m.thread_post_unavailable());
    expect(personalReads).toHaveLength(1);
    await readOnly.settlePersonal(0, personalFor(readOnlyId, id(41), null as never));
    expect(readOnly.host.textContent).toContain('Read-only null-CSRF page');
    expect(readOnly.host.querySelector('input[name="idempotency_key"]')).toBeNull();
  } finally {
    await readOnly.dispose();
  }
});

test('the original anonymous page remains usable when the browser prepares a session for personal reads', async () => {
  const threadId = id(125);
  const page = await mountRoute({ threadId, mode: 'anonymous', session: signedOut });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: false, body: 'Public page before session preparation' }));
    expect(page.host.textContent).toContain('Public page before session preparation');
    await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn()));
    expect(page.host.textContent).toContain('Public page before session preparation');
    expect(personalReads).toHaveLength(1);
    expect(pageReads).toHaveLength(1);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    expect(page.host.querySelector('input[name="idempotency_key"]')).not.toBeNull();
    expect(page.host.textContent).toContain('Public page before session preparation');
  } finally {
    await page.dispose();
  }
});

test('private route data does not cross a QueryClient replacement or an unmount/remount', async () => {
  const threadId = id(126);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const replacementClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacementClient.setQueryData(sessionQuery.queryKey, signedIn());
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(personalReads).toHaveLength(1);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Private page body disclosure');
    await page.rerender(replacementClient);
    expectPrivatePageHidden(page.host);
    expect(
      page.client
        .getQueryCache()
        .find({ queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey, exact: true }),
    ).toBeUndefined();
    await page.remount();
    expectPrivatePageHidden(page.host);
    expect(pageReads).toHaveLength(1);
  } finally {
    replacementClient.clear();
    await page.dispose();
  }
});

test('removing and restoring an equal private cache value does not revive its retired admission', async () => {
  const threadId = id(127);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const queryKey = threadPageQuery(threadId, undefined, 'session', slug).queryKey;
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const original = page.client.getQueryData(queryKey);
    expect(original).toBeDefined();
    await act(async () => {
      page.client.removeQueries({ queryKey, exact: true });
      page.client.setQueryData(queryKey, original);
    });
    expectPrivatePageHidden(page.host);
    expect(page.client.getQueryData(queryKey)).toBe(original);
    expect(pageReads).toHaveLength(1);
  } finally {
    await page.dispose();
  }
});

test('a removed personal result with equal values requires a new admitted bounded personal read', async () => {
  const threadId = id(128);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const queryKey = ['thread-personal', threadId, null, false, id(41)] as const;
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const original = page.client.getQueryData(queryKey);
    expect(original).toBeDefined();
    await act(async () => {
      page.client.removeQueries({ queryKey, exact: true });
      page.client.setQueryData(queryKey, original);
    });
    expect(personalReads).toHaveLength(2);
    expect(page.client.getQueryData(queryKey)).toBeUndefined();
    await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.querySelector('input[name="idempotency_key"]')).not.toBeNull();
  } finally {
    await page.dispose();
  }
});

test('cache retirement hides obsolete page disclosure but keeps the dirty reply and its exact uncertain command mounted', async () => {
  const threadId = id(130);
  const commands: { body: unknown; idempotencyKey: string; parentId?: string }[] = [];
  const reply = spyOn(actions, 'replyToThread').mockImplementation(async ({ data }) => {
    commands.push({ body: structuredClone(data.body), idempotencyKey: data.idempotencyKey, parentId: data.parentId });
    return { ok: false as const, reason: 'unavailable' as const } as never;
  });
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(personalReads).toHaveLength(1);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const editor = page.host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
    expect(editor).toBeDefined();
    await act(async () => {
      const replyToPost = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.trim() === m.thread_reply_to_post(),
      );
      expect(replyToPost).toBeDefined();
      await userSession.click(replyToPost!);
      await Promise.resolve();
      expect(window.document.activeElement).toBe(editor);
      await userSession.keyboard('A retained reply draft');
      await userSession.tab();
    });
    const send = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_write_send(),
    );
    expect(send).toBeDefined();
    await act(async () => userSession.click(send!));
    expect(commands).toHaveLength(1);
    expect(commands[0]!.parentId).toBe(id(41));
    const retry = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_write_retry(),
    );
    expect(retry).toBeDefined();
    await act(async () => userSession.click(retry!));
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    const exactKey = commands[0]!.idempotencyKey;
    const replyRegion = page.host.querySelector<HTMLElement>(`section[aria-label="${m.thread_reply_label()}"]`);
    expect(replyRegion).toBeDefined();
    const input = replyRegion!.querySelector<HTMLInputElement>('input[name="idempotency_key"]');
    expect(input?.value).toBe(exactKey);

    await act(async () =>
      page.client.removeQueries({
        queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey,
        exact: true,
      }),
    );
    expectPrivatePageHidden(page.host);
    expect(page.host.querySelector(`section[aria-label="${m.thread_reply_label()}"]`)).toBe(replyRegion);
    expect(replyRegion!.hidden).toBe(true);
    expect(replyRegion!.querySelector('.ProseMirror')?.textContent).toContain('A retained reply draft');
    expect(replyRegion!.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value).toBe(exactKey);
    expect(page.client.getQueryData(['thread-personal', threadId, null, false, id(41)])).toBeUndefined();

    const editorAfterRetirement = replyRegion!.querySelector('.ProseMirror');
    const refresh = threadRefreshButton(page.host);
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh!.click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);
    await act(async () => {
      pageReads[1]!.work.reject(new Error('refresh unavailable'));
      await pageReads[1]!.work.promise.catch(() => undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expectPrivatePageHidden(page.host);
    expect(page.host.querySelector(`section[aria-label="${m.thread_reply_label()}"]`)).toBe(replyRegion);
    expect(replyRegion!.querySelector('.ProseMirror')).toBe(editorAfterRetirement);
    expect(replyRegion!.querySelector('.ProseMirror')?.textContent).toContain('A retained reply draft');
    expect(replyRegion!.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value).toBe(exactKey);
    expect(
      [...page.host.querySelectorAll<HTMLButtonElement>('button')].some(
        (button) => button.textContent?.trim() === m.thread_write_retry(),
      ),
    ).toBe(true);

    const refreshAfterFailure = threadRefreshButton(page.host);
    expect(refreshAfterFailure).toBeDefined();
    refreshAfterFailure!.focus();
    const focusedBeforeDeparture = window.document.activeElement;
    const pathBeforeDeparture = page.router.state.location.pathname;
    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = page.router.navigate({
        to: '/threads/$id_/$slug',
        params: { id: id(1300), slug: 'another-private-page' },
      } as never);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(page.host.textContent).toContain(m.thread_authoring_leave_pending());
    const stay = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_authoring_stay(),
    );
    expect(stay).toBeDefined();
    await act(async () => {
      await userSession.click(stay!);
      await navigation;
    });
    expect(page.router.state.location.pathname).toBe(pathBeforeDeparture);
    expect(window.document.activeElement).toBe(focusedBeforeDeparture);
    expect(page.host.querySelector(`section[aria-label="${m.thread_reply_label()}"]`)).toBe(replyRegion);
    expect(replyRegion!.querySelector('.ProseMirror')).toBe(editorAfterRetirement);
    expect(replyRegion!.querySelector('.ProseMirror')?.textContent).toContain('A retained reply draft');
    expect(replyRegion!.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value).toBe(exactKey);
  } finally {
    reply.mockRestore();
    await page.dispose();
  }
});

test('a current explicit recovery starts a new bounded read with the original cursor and current credentials', async () => {
  const threadId = id(140);
  const cursor = 'original-cursor';
  const page = await mountRoute({ threadId, cursor, mode: 'session', session: signedIn() });
  try {
    expect(pageReads[0]!.data).toEqual({ id: threadId, cursor, expectedSlug: slug, credentialMode: 'session' });
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(page.host.textContent).toContain('Private page body disclosure');
    expect(personalReads).toHaveLength(1);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    await act(async () =>
      page.client.removeQueries({ queryKey: threadPageQuery(threadId, cursor, 'session', slug).queryKey, exact: true }),
    );
    expectPrivatePageHidden(page.host);
    const refresh = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_refresh(),
    );
    expect(refresh).toBeDefined();
    await act(async () => refresh!.click());
    expect(pageReads).toHaveLength(2);
    expect(pageReads[1]!.data).toEqual({ id: threadId, cursor, credentialMode: 'session' });
    await page.rerender();
    await page.settlePage(1, pageFor(threadId, { privateRead: true, body: 'Fresh current page body' }));
    expect(personalReads).toHaveLength(2);
    await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Fresh current page body');
    expect(page.host.textContent).not.toContain(m.thread_post_unavailable());
  } finally {
    await page.dispose();
  }
});

test('a provider replacement during cancellation prevents a queued refresh read after an away-and-back transition', async () => {
  const threadId = id(142);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const replacement = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacement.setQueryData(sessionQuery.queryKey, signedIn());
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const queryKey = threadPageQuery(threadId, undefined, 'session', slug).queryKey;
    await act(async () => page.client.removeQueries({ queryKey: ['thread-page', threadId] }));
    const originalPath = page.router.state.location.pathname;
    const rememberedBefore = rememberedThreadSlug(threadId);
    const refresh = threadRefreshButton(page.host);
    expect(refresh).toBeDefined();

    await page.rerender(replacement, () => refresh!.click());
    await page.rerender(page.client);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(pageReads).toHaveLength(1);
    expect(page.client.getQueryData(queryKey)).toBeUndefined();
    expect(replacement.getQueryData(queryKey)).toBeUndefined();
    expect(page.router.state.location.pathname).toBe(originalPath);
    expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
  } finally {
    replacement.clear();
    await page.dispose();
  }
});

test('a provider away-and-back while the refresh response is pending cannot publish or remember the old result', async () => {
  const threadId = id(143);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const replacement = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  replacement.setQueryData(sessionQuery.queryKey, signedIn());
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const queryKey = threadPageQuery(threadId, undefined, 'session').queryKey;
    await act(async () => page.client.removeQueries({ queryKey: ['thread-page', threadId] }));
    const originalPath = page.router.state.location.pathname;
    const rememberedBefore = rememberedThreadSlug(threadId);
    const refresh = threadRefreshButton(page.host);
    expect(refresh).toBeDefined();
    await act(async () => {
      refresh!.click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);

    await page.rerender(replacement);
    await page.rerender(page.client);
    await act(async () => {
      pageReads[1]!.work.resolve(
        pageFor(threadId, { privateRead: true, title: 'Obsolete provider title', body: 'Obsolete provider body' }),
      );
      await pageReads[1]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(page.client.getQueryData(queryKey)).toBeUndefined();
    expect(replacement.getQueryData(queryKey)).toBeUndefined();
    expect(page.router.state.location.pathname).toBe(originalPath);
    expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
    expect(page.host.textContent).not.toContain('Obsolete provider body');
  } finally {
    replacement.clear();
    await page.dispose();
  }
});

test('session, query, route, locale and mounted connection retirement reject pending refresh results', async () => {
  for (const [index, retirement] of ['session', 'query', 'route', 'locale', 'connection'].entries()) {
    const threadId = id(180 + index);
    const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
    try {
      await page.settlePage(0, pageFor(threadId, { privateRead: true }));
      await page.settlePersonal(0, personalFor(threadId, id(41)));
      const queryKey = threadPageQuery(threadId, undefined, 'session').queryKey;
      await act(async () => page.client.removeQueries({ queryKey: ['thread-page', threadId] }));
      const originalPath = page.router.state.location.pathname;
      const rememberedBefore = rememberedThreadSlug(threadId);
      const refresh = threadRefreshButton(page.host);
      expect(refresh).toBeDefined();
      await act(async () => {
        refresh!.click();
        await Promise.resolve();
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(pageReads).toHaveLength(2);

      if (retirement === 'session') {
        await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
      } else if (retirement === 'query') {
        await act(async () => page.client.removeQueries({ queryKey, exact: true }));
      } else if (retirement === 'route') {
        const away = page.router.navigate({ href: `/threads/${threadId}/${slug}?cursor=away` });
        page.setOperation(away);
        await Promise.resolve();
        expect(pageReads).toHaveLength(3);
        await page.settlePage(2, pageFor(threadId, { privateRead: true, body: 'Away route body' }));
        const back = page.router.navigate({ href: `/threads/${threadId}/${slug}` });
        page.setOperation(back);
        await Promise.resolve();
        expect(pageReads).toHaveLength(4);
        await page.settlePage(3, pageFor(threadId, { privateRead: true, body: 'Returned route body' }));
      } else if (retirement === 'locale') {
        setLocale('zh-TW', { reload: false });
        await page.rerender();
        setLocale('en', { reload: false });
        await page.rerender();
      } else {
        await page.remount();
      }

      await act(async () => {
        pageReads[1]!.work.resolve(
          pageFor(threadId, { privateRead: true, title: 'Retired refresh title', body: 'Retired refresh body' }),
        );
        await pageReads[1]!.work.promise;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      if (retirement === 'route') {
        expect(page.client.getQueryData(queryKey)).toEqual(
          expect.objectContaining({ thread: expect.objectContaining({ title: 'Private page title' }) }),
        );
        expect(page.host.textContent).toContain('Returned route body');
      } else {
        expect(page.client.getQueryData(queryKey)).toBeUndefined();
      }
      expect(page.router.state.location.pathname).toBe(originalPath);
      expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
      expect(page.host.textContent).not.toContain('Retired refresh body');
    } finally {
      setLocale('en', { reload: false });
      for (const read of pageReads) read.work.resolve(pageFor(threadId, { privateRead: true }));
      for (const read of personalReads) read.work.resolve(personalFor(threadId, id(41)));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await page.dispose();
    }
  }
});

test('a superseding refresh owns the result and the earlier response cannot publish', async () => {
  const threadId = id(186);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    await act(async () => page.client.removeQueries({ queryKey: ['thread-page', threadId] }));
    const queryKey = threadPageQuery(threadId, undefined, 'session').queryKey;
    const refresh = threadRefreshButton(page.host);
    expect(refresh).toBeDefined();

    await act(async () => {
      refresh!.click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);
    await act(async () => {
      threadRefreshButton(page.host)!.click();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(3);

    await act(async () => {
      pageReads[1]!.work.resolve(
        pageFor(threadId, { privateRead: true, title: 'Superseded refresh title', body: 'Superseded refresh body' }),
      );
      await pageReads[1]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(page.client.getQueryData(queryKey)).toBeUndefined();
    expect(page.host.textContent).not.toContain('Superseded refresh body');
    expect(rememberedThreadSlug(threadId)).toBe('Private page title');

    await act(async () => {
      pageReads[2]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Superseding refresh body' }));
      await pageReads[2]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    if (personalReads.length > 1) await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Superseding refresh body');
    expect(page.host.textContent).not.toContain('Superseded refresh body');
    expect(page.client.getQueryData(queryKey)).toEqual(
      expect.objectContaining({ thread: expect.objectContaining({ title: 'Private page title' }) }),
    );
  } finally {
    for (const read of pageReads) read.work.resolve(pageFor(threadId, { privateRead: true }));
    for (const read of personalReads) read.work.resolve(personalFor(threadId, id(41)));
    await page.dispose();
  }
});

test('the actual loader discards an unmarked private cache before its single bounded read', async () => {
  const threadId = id(241);
  const unstamped = pageFor(threadId, { privateRead: true, body: 'Unstamped private cache body' });
  const key = threadPageQuery(threadId, undefined, 'session', slug).queryKey;
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn(), seedPage: unstamped });
  try {
    expect(pageReads).toHaveLength(1);
    expect(pageReads[0]!.data).toEqual({ id: threadId, expectedSlug: slug, credentialMode: 'session' });
    expect(page.client.getQueryData(key)).toBeUndefined();
    expect(page.host.textContent).not.toContain('Unstamped private cache body');

    const fresh = pageFor(threadId, { privateRead: true, body: 'Fresh page after private discard' });
    await page.settlePage(0, fresh);
    expect(pageReads).toHaveLength(1);
    expect(page.host.textContent).toContain('Fresh page after private discard');
    expect(page.client.getQueryData(key)).not.toBe(unstamped);
  } finally {
    await page.dispose();
  }
});

test('the actual same-client loader discards private data when locale changes without changing the query key', async () => {
  const threadId = id(242);
  const page = await mountRoute({
    threadId,
    mode: 'session',
    session: signedIn(),
    rememberedTitle: 'Private page title',
  });
  const key = threadPageQuery(threadId, undefined, 'session').queryKey;
  let reload: Promise<unknown> | undefined;
  try {
    expect(pageReads[0]!.data).toEqual({ id: threadId, credentialMode: 'session' });
    await page.settlePage(0, pageFor(threadId, { privateRead: true, body: 'English private locale body' }));
    const originalQuery = page.client.getQueryCache().find({ queryKey: key, exact: true });
    expect(originalQuery?.state.data).toBeDefined();

    await act(async () => {
      setLocale('zh-TW', { reload: false });
      reload = page.router.invalidate();
      page.setOperation(reload);
      await Promise.resolve();
    });
    expect(pageReads).toHaveLength(2);
    expect(pageReads[1]!.data).toEqual({ id: threadId, credentialMode: 'session' });
    const currentQuery = page.client.getQueryCache().find({ queryKey: key, exact: true });
    expect(currentQuery).toBeDefined();
    expect(currentQuery).not.toBe(originalQuery);
    expect(page.client.getQueryData(key)).toBeUndefined();

    const current = pageFor(threadId, { privateRead: true, body: 'Current locale private body' });
    await page.settlePage(1, current);
    expect(pageReads).toHaveLength(2);
    expect(page.host.textContent).toContain('Current locale private body');
    expect(page.client.getQueryData(key)).not.toBe(originalQuery?.state.data);
  } finally {
    if (pageReads[1]) pageReads[1]!.work.resolve(pageFor(threadId, { privateRead: true }));
    setLocale('en', { reload: false });
    if (reload) await reload.catch(() => undefined);
    await page.dispose();
  }
});

test('remembered-slug ordinary refreshes stay healthy across repeated same-key cancellation and removal', async () => {
  const threadId = id(243);
  const restore = spyOn(actions, 'restorePost').mockImplementation(async () => ({ ok: true }) as never);
  const page = await mountRoute({
    threadId,
    mode: 'session',
    session: signedIn(),
    rememberedTitle: 'Private page title',
  });
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  let backgroundRead: Promise<unknown> | undefined;
  try {
    expect(pageReads[0]!.data).toEqual({ id: threadId, credentialMode: 'session' });
    await page.settlePage(0, erasedPageFor(threadId, 'Initial erased page'));
    if (personalReads.length) await page.settlePersonal(0, personalFor(threadId, id(41)));

    const firstRestore = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_restore(),
    );
    expect(firstRestore).toBeDefined();
    await act(async () => {
      await userSession.click(firstRestore!);
      await Promise.resolve();
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pageReads).toHaveLength(2);
    expect(pageReads[1]!.data).toEqual({ id: threadId, credentialMode: 'session' });
    await act(async () => {
      pageReads[1]!.work.resolve(erasedPageFor(threadId, 'First ordinary refresh'));
      await pageReads[1]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    if (personalReads.length > 1) await page.settlePersonal(1, personalFor(threadId, id(41)));

    await act(async () => {
      backgroundRead = page.client
        .fetchQuery({ ...threadPageQuery(threadId, undefined, 'session'), staleTime: 0, retry: false })
        .catch(() => undefined);
      await Promise.resolve();
    });
    expect(pageReads).toHaveLength(3);
    const secondRestore = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_restore(),
    );
    expect(secondRestore).toBeDefined();
    await act(async () => {
      await userSession.click(secondRestore!);
      await Promise.resolve();
    });
    expect(restore).toHaveBeenCalledTimes(2);
    expect(pageReads).toHaveLength(4);
    expect(pageReads[3]!.data).toEqual({ id: threadId, credentialMode: 'session' });

    await act(async () => {
      pageReads[2]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Cancelled same-key fetch' }));
      await pageReads[2]!.work.promise;
      await backgroundRead;
      pageReads[3]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Second healthy ordinary refresh' }));
      await pageReads[3]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    if (personalReads.length > 1) await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(pageReads).toHaveLength(4);
    expect(page.host.textContent).toContain('Second healthy ordinary refresh');
    expect(page.host.textContent).not.toContain('Cancelled same-key fetch');
    expect(page.host.textContent).not.toContain(m.thread_post_unavailable());
    expect(rememberedThreadSlug(threadId)).toBe('private-page-title');
  } finally {
    if (pageReads[2]) pageReads[2]!.work.resolve(pageFor(threadId, { privateRead: true }));
    if (pageReads[3]) pageReads[3]!.work.resolve(pageFor(threadId, { privateRead: true }));
    await backgroundRead;
    restore.mockRestore();
    await page.dispose();
  }
});

test('a successful unavailable recovery can be followed by an ordinary refresh', async () => {
  const threadId = id(244);
  const restore = spyOn(actions, 'restorePost').mockImplementation(async () => ({ ok: true }) as never);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  let resume: ReturnType<typeof deferred<void>> | undefined;
  let restoreCancel: (() => void) | undefined;
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const paused = await pauseUnavailableRefresh(page, threadId, pageFor(threadId, { privateRead: true }));
    resume = paused.resume;
    restoreCancel = () => paused.cancel.mockRestore();
    await act(async () => {
      paused.resume.resolve(undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);
    expect(pageReads[1]!.data).toEqual({ id: threadId, credentialMode: 'session' });

    await act(async () => {
      pageReads[1]!.work.resolve(erasedPageFor(threadId, 'Recovered erased page'));
      await pageReads[1]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const restoreButton = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_restore(),
    );
    expect(restoreButton).toBeDefined();
    await act(async () => {
      await userSession.click(restoreButton!);
      await Promise.resolve();
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pageReads).toHaveLength(3);
    expect(pageReads[2]!.data).toEqual({ id: threadId, credentialMode: 'session' });
    await act(async () => {
      pageReads[2]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Ordinary refresh after recovery' }));
      await pageReads[2]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(page.host.textContent).toContain('Ordinary refresh after recovery');
    expect(page.host.textContent).not.toContain(m.thread_post_unavailable());
  } finally {
    resume?.resolve(undefined);
    restoreCancel?.();
    for (const read of pageReads) read.work.resolve(pageFor(threadId, { privateRead: true }));
    restore.mockRestore();
    await page.dispose();
  }
});

test('a healthy restore refresh survives its own cancellation and removal of the page cache', async () => {
  const threadId = id(145);
  const restore = spyOn(actions, 'restorePost').mockImplementation(async () => ({ ok: true }) as never);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  try {
    const fixture = pageFor(threadId, { privateRead: true });
    const erased = {
      ...fixture.posts.posts[0]!,
      body: null,
      sha256: null,
      availability: 'erased' as const,
      restorableUntil: '2026-11-10T00:00:00.000Z',
    } as ThreadReadingPage['posts']['posts'][number];
    fixture.posts.posts = [erased];
    await page.settlePage(0, fixture);
    await page.settlePersonal(0, personalFor(threadId, id(41)));

    const backgroundQuery = threadPageQuery(threadId, undefined, 'session', slug);
    const backgroundRead = page.client.fetchQuery({ ...backgroundQuery, staleTime: 0, retry: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pageReads).toHaveLength(2);

    const restoreButton = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_restore(),
    );
    expect(restoreButton).toBeDefined();
    await act(async () => {
      await userSession.click(restoreButton!);
      await Promise.resolve();
    });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(pageReads).toHaveLength(3);
    expect(pageReads[2]!.data).toEqual({ id: threadId, credentialMode: 'session' });

    await act(async () => {
      pageReads[1]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Cancelled background result' }));
      await backgroundRead.catch(() => undefined);
      await Promise.resolve();
    });
    await act(async () => {
      pageReads[2]!.work.resolve(pageFor(threadId, { privateRead: true, body: 'Healthy refreshed page' }));
      await pageReads[2]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    if (personalReads.length > 1) await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Healthy refreshed page');
    expect(page.host.textContent).not.toContain('Cancelled background result');
    expect(page.client.getQueryData(threadPageQuery(threadId, undefined, 'session').queryKey)).toEqual(
      expect.objectContaining({ thread: expect.objectContaining({ title: 'Private page title' }) }),
    );
  } finally {
    restore.mockRestore();
    await page.dispose();
  }
});

test('external distinct and structurally shared successes retire cancellation-await recovery and retain the successor', async () => {
  for (const [index, replacementKind] of ['distinct', 'equal-shared'].entries()) {
    const threadId = id(190 + index);
    const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
    const seed = pageFor(threadId, { privateRead: true, body: 'Seeded successor page' });
    let resume: ReturnType<typeof deferred<void>> | undefined;
    let restoreCancel: (() => void) | undefined;
    let restoreRemove: (() => void) | undefined;
    let cancelledBackgroundRead: Promise<unknown> | undefined;
    const removalsAfterExternalSuccess: string[] = [];
    let externalSuccessStarted = false;
    try {
      await page.settlePage(0, pageFor(threadId, { privateRead: true }));
      await page.settlePersonal(0, personalFor(threadId, id(41)));
      const cancellation = await pauseUnavailableRefresh(page, threadId, seed, true);
      resume = cancellation.resume;
      cancelledBackgroundRead = cancellation.backgroundRead;
      restoreCancel = () => cancellation.cancel.mockRestore();
      const originalRemove = page.client.removeQueries.bind(page.client);
      const remove = spyOn(page.client, 'removeQueries').mockImplementation((filters) => {
        if (externalSuccessStarted && filters?.queryKey?.[0] === 'thread-page')
          removalsAfterExternalSuccess.push(JSON.stringify(filters.queryKey));
        return originalRemove(filters);
      });
      restoreRemove = () => remove.mockRestore();

      const rememberedBefore = rememberedThreadSlug(threadId);
      const pathBefore = page.router.state.location.pathname;
      const key = cancellation.queryKey;
      const seedValue = page.client.getQueryData(key);
      expect(seedValue).toBe(seed);
      const external =
        replacementKind === 'equal-shared'
          ? structuredClone(seed)
          : pageFor(threadId, {
              privateRead: true,
              title: 'External successor title',
              body: 'External successor body',
            });
      externalSuccessStarted = true;
      await act(async () => {
        page.client.setQueryData(key, external);
      });
      const successor = page.client.getQueryData(key);
      if (replacementKind === 'equal-shared') expect(successor).toBe(seed);
      else expect(successor).toBe(external);

      await act(async () => {
        cancellation.resume.resolve(undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });

      expect(pageReads).toHaveLength(2);
      expect(page.client.getQueryData(key)).toBe(successor);
      expect(removalsAfterExternalSuccess).toEqual([]);
      expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
      expect(page.router.state.location.pathname).toBe(pathBefore);
      expectPrivatePageHidden(page.host);
    } finally {
      resume?.resolve(undefined);
      if (pageReads[1]) pageReads[1].work.resolve(pageFor(threadId, { privateRead: true }));
      await cancelledBackgroundRead?.catch(() => undefined);
      restoreCancel?.();
      restoreRemove?.();
      await page.dispose();
    }
  }
});

test('external page and session cache transitions retire a queued recovery before its next read', async () => {
  const transitions = [
    'query-remove',
    'query-recreate',
    'query-error',
    'query-setState',
    'session-success',
    'session-error',
    'session-remove',
    'session-aba',
  ] as const;
  for (const [index, transition] of transitions.entries()) {
    const threadId = id(200 + index);
    const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
    let resume: ReturnType<typeof deferred<void>> | undefined;
    let restoreCancel: (() => void) | undefined;
    try {
      await page.settlePage(0, pageFor(threadId, { privateRead: true }));
      await page.settlePersonal(0, personalFor(threadId, id(41)));
      const cancellation = await pauseUnavailableRefresh(
        page,
        threadId,
        pageFor(threadId, { privateRead: true, body: 'Cancellation transition seed' }),
      );
      resume = cancellation.resume;
      restoreCancel = () => cancellation.cancel.mockRestore();
      const pathBefore = page.router.state.location.pathname;
      const rememberedBefore = rememberedThreadSlug(threadId);

      if (transition === 'query-remove') {
        await act(async () => page.client.removeQueries({ queryKey: cancellation.queryKey, exact: true }));
      } else if (transition === 'query-recreate') {
        await act(async () => {
          page.client.removeQueries({ queryKey: cancellation.queryKey, exact: true });
          page.client.setQueryData(
            cancellation.queryKey,
            pageFor(threadId, { privateRead: true, body: 'Recreated external page' }),
          );
        });
      } else if (transition === 'query-error') {
        await act(async () => {
          await page.client
            .fetchQuery({
              queryKey: cancellation.queryKey,
              queryFn: async () => {
                throw new Error('external page query error');
              },
              retry: false,
              staleTime: 0,
            })
            .catch(() => undefined);
        });
      } else if (transition === 'query-setState') {
        const query = page.client.getQueryCache().find({ queryKey: cancellation.queryKey, exact: true });
        expect(query).toBeDefined();
        await act(async () => query!.setState({ isInvalidated: true }));
      } else if (transition === 'session-success') {
        await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
      } else if (transition === 'session-error') {
        await act(async () => {
          await page.client
            .fetchQuery({
              ...sessionQuery,
              queryFn: async () => {
                throw new Error('external session query error');
              },
              retry: false,
              staleTime: 0,
            })
            .catch(() => undefined);
        });
      } else if (transition === 'session-remove') {
        await act(async () => page.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true }));
      } else {
        await act(async () => {
          page.client.setQueryData(sessionQuery.queryKey, signedOut);
          page.client.setQueryData(sessionQuery.queryKey, signedIn());
        });
      }

      await act(async () => {
        cancellation.resume.resolve(undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(pageReads).toHaveLength(1);
      expect(page.router.state.location.pathname).toBe(pathBefore);
      expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
      expectPrivatePageHidden(page.host);
    } finally {
      resume?.resolve(undefined);
      restoreCancel?.();
      if (pageReads[1]) pageReads[1]!.work.resolve(pageFor(threadId, { privateRead: true }));
      await page.dispose();
    }
  }
});

test('response-window removal, recreation, error and setState preserve the successor and reject the late read', async () => {
  for (const [index, transition] of ['remove', 'recreate', 'error', 'setState'].entries()) {
    const threadId = id(250 + index);
    const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
    let resume: ReturnType<typeof deferred<void>> | undefined;
    let restoreCancel: (() => void) | undefined;
    try {
      await page.settlePage(0, pageFor(threadId, { privateRead: true }));
      await page.settlePersonal(0, personalFor(threadId, id(41)));
      const cancellation = await pauseUnavailableRefresh(
        page,
        threadId,
        pageFor(threadId, { privateRead: true, body: 'Response-window transition seed' }),
      );
      resume = cancellation.resume;
      restoreCancel = () => cancellation.cancel.mockRestore();
      await act(async () => {
        cancellation.resume.resolve(undefined);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(pageReads).toHaveLength(2);

      const query = page.client.getQueryCache().find({ queryKey: cancellation.queryKey, exact: true });
      expect(query).toBeDefined();
      let successorQuery = query;
      let successorData: unknown;
      if (transition === 'remove') {
        await act(async () => page.client.removeQueries({ queryKey: cancellation.queryKey, exact: true }));
        successorQuery = undefined;
      } else if (transition === 'recreate') {
        successorData = pageFor(threadId, { privateRead: true, body: 'Response-window recreated successor' });
        await act(async () => {
          page.client.removeQueries({ queryKey: cancellation.queryKey, exact: true });
          page.client.setQueryData(cancellation.queryKey, successorData);
        });
        successorQuery = page.client.getQueryCache().find({ queryKey: cancellation.queryKey, exact: true });
        successorData = page.client.getQueryData(cancellation.queryKey);
        expect(successorQuery).not.toBe(query);
      } else if (transition === 'error') {
        successorData = pageFor(threadId, { privateRead: true, body: 'Response-window error successor' });
        await act(async () => {
          page.client.setQueryData(cancellation.queryKey, successorData);
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        });
        await act(async () => {
          await page.client
            .fetchQuery({
              ...threadPageQuery(threadId, undefined, 'session'),
              queryFn: async () => {
                throw new Error('external response-window query error');
              },
              retry: false,
              staleTime: 0,
            })
            .catch(() => undefined);
        });
        successorQuery = page.client.getQueryCache().find({ queryKey: cancellation.queryKey, exact: true });
        successorData = page.client.getQueryData(cancellation.queryKey);
        expect(successorQuery?.state.status).toBe('error');
      } else {
        await act(async () => query!.setState({ isInvalidated: true }));
        successorData = query!.state.data;
        expect(query!.state.isInvalidated).toBe(true);
      }

      await act(async () => {
        pageReads[1]!.work.resolve(
          pageFor(threadId, { privateRead: true, body: 'Retired response after external transition' }),
        );
        await pageReads[1]!.work.promise;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(pageReads).toHaveLength(2);
      expect(page.client.getQueryCache().find({ queryKey: cancellation.queryKey, exact: true })).toBe(successorQuery);
      if (transition === 'recreate') expect(page.client.getQueryData(cancellation.queryKey)).toBe(successorData);
      if (transition === 'error') {
        expect(page.client.getQueryData(cancellation.queryKey)).toBe(successorData);
        expect(successorQuery?.state.status).toBe('error');
      }
      if (transition === 'setState') expect(query!.state.isInvalidated).toBe(true);
      expect(page.host.textContent).not.toContain('Retired response after external transition');
      expectPrivatePageHidden(page.host);
    } finally {
      resume?.resolve(undefined);
      restoreCancel?.();
      if (pageReads[1]) pageReads[1]!.work.resolve(pageFor(threadId, { privateRead: true }));
      await page.dispose();
    }
  }
});

test('a nested default-shared success during the response notification retires the owned result', async () => {
  const threadId = id(254);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  let resume: ReturnType<typeof deferred<void>> | undefined;
  let restoreCancel: (() => void) | undefined;
  let removeNested: (() => void) | undefined;
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const cancellation = await pauseUnavailableRefresh(
      page,
      threadId,
      pageFor(threadId, { privateRead: true, body: 'Nested notification seed' }),
    );
    resume = cancellation.resume;
    restoreCancel = () => cancellation.cancel.mockRestore();
    const pathBefore = page.router.state.location.pathname;
    const rememberedBefore = rememberedThreadSlug(threadId);
    await act(async () => {
      cancellation.resume.resolve(undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);

    let nested = false;
    let committedBeforeExternal: unknown;
    let sharedSuccessor: unknown;
    removeNested = page.client.getQueryCache().subscribe((event) => {
      if (
        nested ||
        event.type !== 'updated' ||
        event.action?.type !== 'success' ||
        event.action.manual === true ||
        JSON.stringify(event.query.queryKey) !== JSON.stringify(cancellation.queryKey)
      )
        return;
      nested = true;
      committedBeforeExternal = page.client.getQueryData(cancellation.queryKey);
      event.query.setData(structuredClone(committedBeforeExternal), { manual: false });
      sharedSuccessor = page.client.getQueryData(cancellation.queryKey);
    });

    await act(async () => {
      pageReads[1]!.work.resolve(
        pageFor(threadId, { privateRead: true, body: 'Owned response before nested replacement' }),
      );
      await pageReads[1]!.work.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(nested).toBe(true);
    expect(committedBeforeExternal).toBeDefined();
    expect(sharedSuccessor).toBe(committedBeforeExternal);
    expect(page.client.getQueryData(cancellation.queryKey)).toBe(sharedSuccessor);
    expect(page.host.textContent).not.toContain('Owned response before nested replacement');
    expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
    expect(page.router.state.location.pathname).toBe(pathBefore);
    expectPrivatePageHidden(page.host);
  } finally {
    resume?.resolve(undefined);
    if (pageReads[1]) pageReads[1]!.work.resolve(pageFor(threadId, { privateRead: true }));
    removeNested?.();
    restoreCancel?.();
    await page.dispose();
  }
});

test('an external page success during the refresh response await prevents stale cache and page publication', async () => {
  const threadId = id(220);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  let resume: ReturnType<typeof deferred<void>> | undefined;
  let restoreCancel: (() => void) | undefined;
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const cancellation = await pauseUnavailableRefresh(
      page,
      threadId,
      pageFor(threadId, { privateRead: true, body: 'Response successor seed' }),
    );
    resume = cancellation.resume;
    restoreCancel = () => cancellation.cancel.mockRestore();
    const pathBefore = page.router.state.location.pathname;
    const rememberedBefore = rememberedThreadSlug(threadId);

    await act(async () => {
      cancellation.resume.resolve(undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(2);

    const external = pageFor(threadId, {
      privateRead: true,
      title: 'Response successor title',
      body: 'Response successor body',
    });
    await act(async () => {
      page.client.setQueryData(cancellation.queryKey, external);
    });
    expect(page.client.getQueryData(cancellation.queryKey)).toBe(external);
    await act(async () => {
      pageReads[1]!.work.resolve(
        pageFor(threadId, { privateRead: true, title: 'Stale response title', body: 'Stale response body' }),
      );
      await pageReads[1]!.work.promise.catch(() => undefined);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(pageReads).toHaveLength(2);
    expect(page.client.getQueryData(cancellation.queryKey)).toBe(external);
    expect(page.host.textContent).not.toContain('Stale response body');
    expect(rememberedThreadSlug(threadId)).toBe(rememberedBefore);
    expect(page.router.state.location.pathname).toBe(pathBefore);
  } finally {
    resume?.resolve(undefined);
    restoreCancel?.();
    await page.dispose();
  }
});

test('cursor and locale changes retire the original mounted route before its old page can be reused', async () => {
  const threadId = id(150);
  const page = await mountRoute({ threadId, cursor: 'first-cursor', mode: 'session', session: signedIn() });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    expect(page.host.textContent).toContain('Private page body disclosure');
    expect(personalReads).toHaveLength(1);
    const oldPersonalSignal = personalReads[0]!.signal;
    const oldPersonalKey = ['thread-personal', threadId, 'first-cursor', false, id(41)] as const;
    const nextCursorNavigation = page.router.navigate({ href: `/threads/${threadId}/${slug}?cursor=next-cursor` });
    page.setOperation(nextCursorNavigation);
    await Promise.resolve();
    expect(pageReads).toHaveLength(2);
    expect(pageReads[1]!.data).toEqual({
      id: threadId,
      cursor: 'next-cursor',
      credentialMode: 'session',
    });
    expectPrivatePageHidden(page.host);
    await page.settlePage(1, pageFor(threadId, { privateRead: true, body: 'Second page body' }));
    expect(personalReads).toHaveLength(2);
    expect(oldPersonalSignal?.aborted).toBe(true);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    expect(page.client.getQueryData(oldPersonalKey)).toBeUndefined();
    await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Second page body');
    expect(page.host.textContent).not.toContain('Private page body disclosure');

    const nextThreadId = id(151);
    const nextSlug = 'next-thread-title';
    const nextThreadNavigation = page.router.navigate({ href: `/threads/${nextThreadId}/${nextSlug}` });
    page.setOperation(nextThreadNavigation);
    await Promise.resolve();
    expect(pageReads).toHaveLength(3);
    expect(pageReads[2]!.data).toEqual({
      id: nextThreadId,
      expectedSlug: nextSlug,
      credentialMode: 'session',
    });
    expectPrivatePageHidden(page.host);
    await page.settlePage(
      2,
      pageFor(nextThreadId, {
        privateRead: true,
        title: 'Next thread title',
        body: 'Page after id and slug transition',
      }),
    );
    expect(personalReads).toHaveLength(3);
    await page.settlePersonal(2, personalFor(nextThreadId, id(41)));
    expect(page.host.textContent).toContain('Page after id and slug transition');

    setLocale('zh-TW', { reload: false });
    await page.rerender();
    expectPrivatePageHidden(page.host);
    setLocale('en', { reload: false });
  } finally {
    setLocale('en', { reload: false });
    await page.dispose();
  }
});

test('a reply completing under a retired caller cannot invalidate or navigate the replacement view', async () => {
  const threadId = id(155);
  const response = deferred<unknown>();
  const reply = spyOn(actions, 'replyToThread').mockImplementation(() => response.promise as never);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const invalidation = spyOn(page.client, 'invalidateQueries');
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  try {
    await page.settlePage(0, pageFor(threadId, { privateRead: true }));
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const editor = page.host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
    expect(editor).toBeDefined();
    await act(async () => {
      await userSession.click(editor!);
      await userSession.keyboard('A reply pending across replacement');
      await userSession.tab();
    });
    const send = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_write_send(),
    );
    expect(send).toBeDefined();
    await act(async () => userSession.click(send!));
    expect(reply).toHaveBeenCalledTimes(1);
    const routeBeforeReplacement = page.router.state.location.pathname;

    await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
    expectPrivatePageHidden(page.host);
    const exactKey = page.host.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value;
    expect(exactKey).toBeTruthy();

    await act(async () => {
      response.resolve({ ok: true, post: pageFor(threadId).posts.posts[0] } as never);
      await response.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(invalidation).not.toHaveBeenCalled();
    expect(pageReads).toHaveLength(1);
    expect(page.router.state.location.pathname).toBe(routeBeforeReplacement);
    expect(page.host.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value).toBe(exactKey);
  } finally {
    invalidation.mockRestore();
    reply.mockRestore();
    await page.dispose();
  }
});

test('a restore callback cannot start its old page refresh after the reader retires', async () => {
  const threadId = id(156);
  const response = deferred<unknown>();
  const restore = spyOn(actions, 'restorePost').mockImplementation(() => response.promise as never);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn() });
  const invalidation = spyOn(page.client, 'invalidateQueries');
  const storyRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: user } = await import(storyRequire.resolve('@testing-library/user-event'));
  const userSession = user.setup({ document: window.document });
  try {
    const fixture = pageFor(threadId, { privateRead: true });
    const erased = {
      ...fixture.posts.posts[0]!,
      body: null,
      sha256: null,
      availability: 'erased' as const,
      restorableUntil: '2026-11-10T00:00:00.000Z',
    } as ThreadReadingPage['posts']['posts'][number];
    fixture.posts.posts = [erased];
    await page.settlePage(0, fixture);
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const restoreButton = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_post_restore(),
    );
    expect(restoreButton).toBeDefined();
    await act(async () => userSession.click(restoreButton!));
    expect(restore).toHaveBeenCalledTimes(1);

    await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
    expectPrivatePageHidden(page.host);
    await act(async () => {
      response.resolve({ ok: true } as never);
      await response.promise;
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(pageReads).toHaveLength(1);
    expect(invalidation).not.toHaveBeenCalled();
    expectPrivatePageHidden(page.host);
  } finally {
    invalidation.mockRestore();
    restore.mockRestore();
    await page.dispose();
  }
});

test('a stale slug read cannot remember a title or perform its 301 after the session changes', async () => {
  slugReads.length = 0;
  const threadId = id(160);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const parent = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: Mode;
  }>()({ component: Outlet });
  SlugRoute.update({ id: '/threads/$id', path: '/threads/$id', getParentRoute: () => parent } as never);
  const router = createRouter({
    routeTree: parent.addChildren([SlugRoute]),
    context: { queryClient: client, credentialMode: 'session' },
    history: createMemoryHistory({ initialEntries: [`/threads/${threadId}`] }),
  });
  const operation = router.load();
  expect(slugReads).toHaveLength(1);
  await act(async () => client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
  slugReads[0]!.work.resolve({ id: threadId, title: 'Changed while queued' });
  await operation.catch(() => undefined);
  expect(router.state.location.pathname).toBe(`/threads/${threadId}`);
  expect(rememberedThreadSlug(threadId)).toBeUndefined();
  router.dispose();
  client.clear();
});

test('an old expected-slug redirect is not remembered or navigated after the route admission retires', async () => {
  const threadId = id(170);
  const page = await mountRoute({ threadId, mode: 'session', session: signedIn(), slugName: 'old-private-title' });
  try {
    expect(pageReads[0]!.data.expectedSlug).toBe('old-private-title');
    await act(async () => page.client.setQueryData(sessionQuery.queryKey, signedIn('replacement-csrf')));
    await page.settlePage(0, { redirect: { id: threadId, title: 'New private title' } });
    expect(page.router.state.location.pathname).toBe(`/threads/${threadId}/old-private-title`);
    expect(rememberedThreadSlug(threadId)).toBeUndefined();
  } finally {
    await page.dispose();
  }
});

test('mounted composed advice keeps denied actions inert, seeds watch and slow mode, and retires with its viewer', async () => {
  const { authoredReadingPage } = await import('../src/kernel/fake/thread-reading-page');
  for (const [index, actionState] of (['unavailable', 'denied', 'available'] as const).entries()) {
    const allowed = actionState === 'available';
    const threadId = id(810 + index);
    const cursor = `composed-cursor-${index}`;
    const route = await mountRoute({ threadId, cursor, mode: 'session', session: signedIn(), strict: false });
    try {
      const page = pageFor(threadId, { privateRead: true });
      const composed = authoredReadingPage({ ...page.thread, viewerReaction: 'like' });
      composed.viewer = { kind: 'account', id: viewerId };
      composed.actions = {
        state: actionState === 'unavailable' ? 'unavailable' : 'current',
        retryable: actionState === 'unavailable',
        reply: { state: actionState },
        references: [
          {
            type: 'content.thread',
            id: threadId,
            state: 'current',
            operations: [
              { action: 'reaction:set', operationId: 'thread.set_reaction', state: allowed ? 'available' : 'denied' },
              { action: 'reaction:set', operationId: 'thread.clear_reaction', state: allowed ? 'available' : 'denied' },
              { action: 'thread:watch', operationId: 'thread.unwatch', state: 'available' },
            ],
          },
        ],
      };
      composed.watch = { state: 'current', watching: true };
      composed.slowMode = {
        state: 'current',
        intervalSeconds: 60,
        retryAt: null,
        nextEligibleAt: null,
        canChange: false,
        exempt: false,
        admissionState: 'pending',
        retryAfterSeconds: 0,
      };
      composed.currentness = {
        ...composed.currentness,
        actions: actionState === 'unavailable' ? 'unavailable' : 'current',
        watch: 'current',
        slowMode: 'current',
      };
      page.thread = composed.thread;
      page.composed = composed;
      page.authors = {
        [viewerId]: { id: viewerId, displayName: 'Composed private author', handle: null, avatar: null },
      };
      await route.settlePage(0, page);
      expect(route.client.getQueryCache().findAll({ queryKey: ['thread-personal', threadId] })[0]?.queryKey).toEqual([
        'thread-personal',
        threadId,
        cursor,
        false,
        id(41),
      ]);
      expect(personalReads[0]!.data).toEqual({ id: threadId, postIds: [], readReactions: false });
      await route.settlePersonal(0, personalFor(threadId, id(41)));
      expect(route.host.textContent).toContain('Composed private author');
      expect(route.host.textContent).toContain(m.thread_watch_watching());
      expect(route.host.textContent).toContain(m.slow_mode_preparing());
      const reply = route.host.querySelector<HTMLButtonElement>('button[data-slot="feed-reply-action"]');
      expect(reply?.disabled).toBe(!allowed);
      const reactionGroup = [...route.host.querySelectorAll<HTMLElement>('[role="group"]')].find(
        (group) => group.getAttribute('aria-label') === m.reaction_reactions(),
      );
      expect(reactionGroup).toBeDefined();
      const votes = [...reactionGroup!.querySelectorAll<HTMLButtonElement>('button')];
      expect(votes.length).toBeGreaterThan(0);
      expect(votes.some((button) => !button.disabled)).toBe(allowed);
      await act(async () => route.client.setQueryData(sessionQuery.queryKey, signedIn('replaced-composed-csrf')));
      expect(route.host.textContent).not.toContain('Composed private author');
      expect(route.host.textContent).not.toContain(m.thread_watch_watching());
    } finally {
      await route.dispose();
    }
  }
});

test('a personal read cannot replace the composed page account or its denied advice', async () => {
  const { authoredReadingPage } = await import('../src/kernel/fake/thread-reading-page');
  const threadId = id(820);
  const route = await mountRoute({ threadId, mode: 'session', session: signedIn(), strict: false });
  try {
    const page = pageFor(threadId, { privateRead: true });
    const composed = authoredReadingPage({ ...page.thread, viewerReaction: 'like' });
    composed.viewer = { kind: 'account', id: id(821) };
    composed.actions = {
      ...composed.actions,
      state: 'current',
      retryable: false,
      reply: { state: 'available' },
    };
    composed.currentness = { ...composed.currentness, actions: 'current' };
    page.thread = composed.thread;
    page.composed = composed;
    await route.settlePage(0, page);
    expect(personalReads).toHaveLength(0);
    expect(route.host.querySelector<HTMLButtonElement>('button[data-slot="feed-reply-action"]')?.disabled).toBe(true);
  } finally {
    await route.dispose();
  }
});
