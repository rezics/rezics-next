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
const pageReads: { data: ReadData; work: ReturnType<typeof deferred<ThreadReadingPage | { redirect: { id: string; title: string | null } }>> }[] = [];
const slugReads: { data: ReadData; work: ReturnType<typeof deferred<{ id: string; title: string | null }>> }[] = [];
const readModule = await import('../src/threads/reads');
const personalReads: {
  data: { id: string; postIds: string[] };
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
const personalReader = spyOn(readModule, 'readThreadPersonal').mockImplementation(({ data }) => {
  const work = deferred<Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>>();
  personalReads.push({ data: { id: data.id, postIds: [...data.postIds] }, work });
  return work.promise;
});

const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  RouterProvider,
} = await import('@tanstack/react-router');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { sessionQuery } = await import('../src/session/query');
const { Route } = await import('../src/routes/threads/$id_.$slug');
const { Route: SlugRoute } = await import('../src/routes/threads/$id');
const { threadPageQuery } = await import('../src/threads/thread-queries');
const { rememberedThreadSlug } = await import('../src/threads/thread-href');
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
}: {
  threadId: string;
  cursor?: string;
  mode?: Mode;
  session?: Session;
  strict?: boolean;
  slugName?: string;
}) {
  pageReads.length = 0;
  personalReads.length = 0;
  setLocale('en', { reload: false });
  notifyManager.setScheduler((callback) => callback());
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
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
      {strict ? <StrictMode><RouterProvider router={router} /></StrictMode> : <RouterProvider router={router} />}
    </QueryClientProvider>
  );
  await act(async () => {
    root.render(tree());
    await Promise.resolve();
  });
  const settlePage = async (index: number, result: ThreadReadingPage | { redirect: { id: string; title: string | null } }) => {
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
    async rerender(provider = client) {
      await act(async () => root.render(tree(provider)));
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
    reactions: { [threadId]: 'like', [postId]: 'love' },
    reviewVotes: {},
  } as Awaited<ReturnType<(typeof readModule)['readThreadPersonal']>>;
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
    <QueryClientProvider client={serverClient}><RouterProvider router={router} /></QueryClientProvider>,
  );
  window.document.body.append(host);
  const browserClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  browserClient.setQueryData(sessionQuery.queryKey, signedOut);
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(
      host,
      <QueryClientProvider client={browserClient}><RouterProvider router={router} /></QueryClientProvider>,
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
    <QueryClientProvider client={serverClient}><RouterProvider router={router} /></QueryClientProvider>,
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
      <QueryClientProvider client={browserClient}><RouterProvider router={router} /></QueryClientProvider>,
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
    expect(page.client.getQueryCache().find({ queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey, exact: true })).toBeUndefined();
    expectPrivatePageHidden(page.host);
  } finally {
    await page.dispose();
  }
});

test('a ready private page and pending personal result retire on readiness loss, sign-out and batched away/back', async () => {
  const replacements: Session[] = [
    signedIn(null),
    signedOut,
    signedIn(),
  ];
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
      expect(page.client.getQueryCache().find({ queryKey: ['thread-personal', threadId, null, id(41)], exact: true })).toBeUndefined();
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
    expect(personalReads[0]!.data).toEqual({ id: threadId, postIds: [id(41)] });
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
    expect(page.client.getQueryCache().find({ queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey, exact: true })).toBeUndefined();
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
  const queryKey = ['thread-personal', threadId, null, id(41)] as const;
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
      await userSession.click(editor!);
      await userSession.keyboard('A retained reply draft');
      await userSession.tab();
    });
    const send = [...page.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.thread_write_send(),
    );
    expect(send).toBeDefined();
    await act(async () => userSession.click(send!));
    expect(commands).toHaveLength(1);
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
      page.client.removeQueries({ queryKey: threadPageQuery(threadId, undefined, 'session', slug).queryKey, exact: true }),
    );
    expectPrivatePageHidden(page.host);
    expect(page.host.querySelector(`section[aria-label="${m.thread_reply_label()}"]`)).toBe(replyRegion);
    expect(replyRegion!.hidden).toBe(true);
    expect(replyRegion!.querySelector('.ProseMirror')?.textContent).toContain('A retained reply draft');
    expect(replyRegion!.querySelector<HTMLInputElement>('input[name="idempotency_key"]')?.value).toBe(exactKey);
    expect(page.client.getQueryData(['thread-personal', threadId, null, id(41)])).toBeUndefined();
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
    await page.settlePage(1, pageFor(threadId, { privateRead: true, body: 'Fresh current page body' }));
    expect(personalReads).toHaveLength(2);
    await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Fresh current page body');
    expect(page.host.textContent).not.toContain(m.thread_post_unavailable());
  } finally {
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
    await page.settlePersonal(0, personalFor(threadId, id(41)));
    const next = page.router.navigate({ href: `/threads/${threadId}/${slug}?cursor=next-cursor` });
    page.setOperation(next);
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
    await page.settlePersonal(1, personalFor(threadId, id(41)));
    expect(page.host.textContent).toContain('Second page body');
    expect(page.host.textContent).not.toContain('Private page body disclosure');

    const nextThreadId = id(151);
    const nextSlug = 'next-thread-title';
    const next = page.router.navigate({ href: `/threads/${nextThreadId}/${nextSlug}` });
    page.setOperation(next);
    await Promise.resolve();
    expect(pageReads).toHaveLength(3);
    expect(pageReads[2]!.data).toEqual({
      id: nextThreadId,
      expectedSlug: nextSlug,
      credentialMode: 'session',
    });
    expectPrivatePageHidden(page.host);
    await page.settlePage(2, pageFor(nextThreadId, {
      privateRead: true,
      title: 'Next thread title',
      body: 'Page after id and slug transition',
    }));
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
