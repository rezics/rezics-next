import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { ExactRevisionState } from '../src/threads/exact-revision';
import type {
  HistoricalActualReader,
  HistoricalReadBinding,
  HistoricalReadEnvelope,
} from '../src/threads/historical-reader-provenance';
import { selected, ready as recordedReady, id } from '../src/stories/exact-revision/fixture';
import accounts from '../src/kernel/recorded/accounts.json';

// Authored composed route/cache regressions; the designated acceptance command is intentionally UNRUN here.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/posts/example/revisions/example' });
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
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

type DeferredRead = ReturnType<typeof deferred<HistoricalReadEnvelope<ExactRevisionState>>>;
const reads: {
  data: { postId: string; revisionId: string; locale: string; credentialMode: string; binding: HistoricalReadBinding };
  actualReader: HistoricalActualReader;
  work: DeferredRead;
}[] = [];
const editionReads: { postId: string; revisionId: string }[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
let activeClient: import('@tanstack/react-query').QueryClient | undefined;
mock.module('../src/threads/exact-revision-read', () => ({
  readExactRevision: ({ data }: { data: (typeof reads)[number]['data'] }) => {
    const session = activeClient?.getQueryData<{ state?: string; subject?: string | null }>(['session']);
    const actualReader: HistoricalActualReader =
      data.credentialMode === 'session' && session?.state === 'signed-in'
        ? { credentialMode: 'session', subject: session.subject ?? null, complete: !!session.subject }
        : { credentialMode: 'anonymous', subject: null, complete: true };
    const work = deferred<HistoricalReadEnvelope<ExactRevisionState>>();
    reads.push({ data: { ...data }, actualReader, work });
    return work.promise;
  },
}));
mock.module('../src/content-editions/edition-create-actions', () => ({
  readEditionCreateEntry: ({ data }: { data: { postId: string; revisionId: string } }) => {
    editionReads.push({ ...data });
    return Promise.resolve({ kind: 'available' as const });
  },
}));

const privateImageId = id(70);
const privateRevision = {
  ...selected,
  mediaIds: [privateImageId],
  body: {
    ...selected.body,
    doc: {
      ...selected.body.doc,
      content: [
        ...selected.body.doc.content!,
        { type: 'image', attrs: { id: 'private-exact-image', src: privateImageId, alt: 'Private exact media' } },
      ],
    },
  },
};
const privateAuthor = { ...accounts.accounts[0]!, id: selected.authorId, displayName: 'Private exact author' };
const readyPage: ExactRevisionState = {
  ...recordedReady,
  revision: privateRevision,
  thread: { ...recordedReady.thread, title: 'Private exact backlink title' },
  authors: { [privateAuthor.id]: privateAuthor },
  documentMedia: {
    kind: 'ready',
    images: new Map([
      [
        privateImageId,
        {
          id: privateImageId,
          containerId: selected.threadId,
          digest: 'b'.repeat(64),
          width: 200,
          height: 100,
          variants: [{ format: 'webp', width: 200, height: 100 }],
          placeholder: null,
          focalPoint: null,
          credit: null,
        },
      ],
    ]),
  },
};
function readyFor(postId: string, revisionId: string): ExactRevisionState {
  if (readyPage.state !== 'ready') return readyPage;
  return { ...readyPage, revision: { ...readyPage.revision, id: postId, revisionId } };
}
const problem: ExactRevisionState = { state: 'problem', status: 503, code: 'dependency_unavailable' };
const signedIn = (subject = id(1), csrfToken = 'original-csrf') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const signedOut = { state: 'signed-out' as const, subject: null, csrfToken: null };
const hidden = [
  'The original edition leaves room for the reader to pause.',
  'Private exact media',
  'Private exact author',
  'Private exact backlink title',
  'CC-BY-SA-4.0',
  selected.revisionId,
  'data-slot="document-body"',
  'data-slot="document-image"',
  '/threads/',
];

const { setLocale, getLocale } = await import('../src/paraglide/runtime.js');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { createRoot } = await import('react-dom/client');
const { Route } = await import('../src/routes/posts/$id.revisions.$revisionId');
const { ExactRevisionCaller } = await import('../src/threads/exact-revision-caller');
const { m } = await import('../src/paraglide/messages.js');

type Mode = 'anonymous' | 'session';
type Session =
  | { state: 'signed-in'; subject: string; csrfToken: string | null }
  | typeof signedOut
  | { state: 'unavailable'; subject: null; csrfToken: null };

async function mount({
  session = signedOut,
  credentialMode = 'anonymous',
  postId = selected.id,
  revisionId = selected.revisionId,
  strict = true,
}: {
  session?: Session | null;
  credentialMode?: Mode;
  postId?: string;
  revisionId?: string;
  strict?: boolean;
} = {}) {
  reads.length = 0;
  editionReads.length = 0;
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (session !== null) client.setQueryData(['session'], session);
  activeClient = client;
  notifyManager.setScheduler((callback) => callback());
  const parent = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: Mode;
  }>()({ component: Outlet });
  Route.update({
    id: '/posts/$id/revisions/$revisionId',
    path: '/posts/$id/revisions/$revisionId',
    getParentRoute: () => parent,
  } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: client, credentialMode },
    history: createMemoryHistory({ initialEntries: [`/posts/${postId}/revisions/${revisionId}`] }),
  });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const tree = () => {
    const route = createElementFromProvider();
    return strict ? <StrictMode>{route}</StrictMode> : route;
  };
  function createElementFromProvider() {
    return (
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
  }
  const root = createRoot(host);
  let operation: Promise<unknown> = router.load();
  const originalInvalidate = router.invalidate.bind(router);
  spyOn(router, 'invalidate').mockImplementation((...args) => {
    operation = originalInvalidate(...args);
    return operation as ReturnType<typeof router.invalidate>;
  });
  await act(async () => {
    root.render(tree());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  const settle = async (index: number, page: ExactRevisionState) => {
    await act(async () => {
      reads[index]!.work.resolve({
        data: page,
        provenance: {
          binding: reads[index]!.data.binding,
          actualReader: reads[index]!.actualReader,
          responseGeneration: index + 1,
        },
      });
      await operation;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const retainRetry = () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === m.exact_revision_retry(),
    );
    expect(button).toBeDefined();
    const propsKey = Object.getOwnPropertyNames(button!).find((key) => key.startsWith('__reactProps$'));
    expect(propsKey).toBeDefined();
    const props = (button as unknown as Record<string, { onClick?: () => void }>)[propsKey!];
    expect(typeof props.onClick).toBe('function');
    return props.onClick!;
  };
  const hiddenNow = () => {
    for (const text of hidden) expect(host.innerHTML).not.toContain(text);
    expect(host.querySelector(`[aria-label="${m.edition_publication_entry_heading()}"]`)).toBeNull();
  };
  let activeRoot = root;
  const dispose = async () => {
    await act(async () => activeRoot.unmount());
    router.dispose();
    client.clear();
    host.remove();
  };
  return {
    client,
    router,
    host,
    root,
    replaceRoot(value: typeof root) {
      activeRoot = value;
    },
    settle,
    retainRetry,
    hiddenNow,
    async rerender() {
      await act(async () => activeRoot.render(tree()));
    },
    setOperation(value: Promise<unknown>) {
      operation = value;
    },
    dispose,
  };
}

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('actual exact route keeps healthy anonymous and signed-in reads and an explicit current retry', async () => {
  const anonymous = await mount();
  try {
    expect(
      reads.map(({ data }) => ({
        postId: data.postId,
        revisionId: data.revisionId,
        locale: data.locale,
        credentialMode: data.credentialMode,
      })),
    ).toEqual([{ postId: selected.id, revisionId: selected.revisionId, locale: 'en', credentialMode: 'anonymous' }]);
    await anonymous.settle(0, readyPage);
    expect(anonymous.host.textContent).toContain('The original edition leaves room for the reader to pause.');
    expect(anonymous.host.querySelector('a[href*="/threads/"]')).not.toBeNull();
    expect(editionReads).toHaveLength(0);
    await anonymous.rerender();
    expect(anonymous.host.textContent).toContain('The original edition leaves room for the reader to pause.');
  } finally {
    await anonymous.dispose();
  }

  const viewer = await mount({ session: signedIn(), credentialMode: 'session' });
  try {
    expect(reads[0]!.data.credentialMode).toBe('session');
    await viewer.settle(0, problem);
    expect(viewer.host.querySelector('button')?.textContent).toContain(m.exact_revision_retry());
    const clickRetry = viewer.host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      clickRetry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads).toHaveLength(2);
    expect(reads[1]!.data).toMatchObject({
      postId: selected.id,
      revisionId: selected.revisionId,
      locale: 'en',
      credentialMode: 'session',
    });
    expect(reads[1]!.data.binding.target).toEqual({
      kind: 'exact-revision',
      postId: selected.id,
      revisionId: selected.revisionId,
      locale: 'en',
      credentialMode: 'session',
    });
    await viewer.settle(1, readyPage);
    expect(viewer.host.textContent).toContain('Private exact author');
    expect(editionReads).toEqual([{ postId: selected.id, revisionId: selected.revisionId }]);
  } finally {
    await viewer.dispose();
  }
});

test('the original pending and already-ready result retire on cache replacement, readiness loss and sign-out', async () => {
  const replacements: Session[] = [
    signedIn(id(1), 'rotated-csrf'),
    { state: 'signed-in', subject: id(1), csrfToken: null },
    signedOut,
  ];
  for (const next of replacements) {
    const pending = await mount({ session: signedIn(), credentialMode: 'session' });
    try {
      await act(async () => pending.client.setQueryData(['session'], next));
      pending.hiddenNow();
      await pending.settle(0, readyPage);
      pending.hiddenNow();
      expect(editionReads).toHaveLength(0);
      expect(reads).toHaveLength(1);
    } finally {
      await pending.dispose();
    }

    const ready = await mount({ session: signedIn(), credentialMode: 'session' });
    try {
      await ready.settle(0, readyPage);
      expect(ready.host.textContent).toContain('Private exact author');
      await act(async () => ready.client.setQueryData(['session'], next));
      ready.hiddenNow();
      expect(reads).toHaveLength(1);
    } finally {
      await ready.dispose();
    }
  }
});

test('an away and back cache replacement in one batch retires ready content and its retained retry', async () => {
  const page = await mount({ session: signedIn(), credentialMode: 'session' });
  try {
    await page.settle(0, problem);
    const oldRetry = page.retainRetry();
    await act(async () => {
      page.client.setQueryData(['session'], signedIn(id(2), 'other-csrf'));
      page.client.setQueryData(['session'], signedIn(id(1), 'original-csrf'));
    });
    page.hiddenNow();
    oldRetry();
    expect(reads).toHaveLength(1);
    expect(editionReads).toHaveLength(0);
  } finally {
    await page.dispose();
  }
});

test('anonymous hydration and the existing anonymous-to-prepared route refresh retain only current authority', async () => {
  const page = await mount({ session: null, credentialMode: 'anonymous' });
  try {
    expect(Route.options.staticData?.sessionReread).toBe(true);
    await page.settle(0, readyPage);
    await act(async () => page.client.setQueryData(['session'], signedOut));
    expect(page.host.textContent).toContain('The original edition leaves room for the reader to pause.');
    expect(reads).toHaveLength(1);

    await act(async () => page.client.setQueryData(['session'], signedIn()));
    page.hiddenNow();
    page.router.update({ context: { ...page.router.options.context, credentialMode: 'session' } });
    const refresh = page.router.invalidate();
    page.setOperation(refresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads).toHaveLength(2);
    expect(reads[1]!.data.credentialMode).toBe('session');
    await page.settle(1, readyPage);
    expect(page.host.textContent).toContain('Private exact author');
  } finally {
    await page.dispose();
  }
});

test('SSR route admission hydrates on the matching browser cache and retires when that cache prepares a viewer', async () => {
  reads.length = 0;
  setLocale('en', { reload: false });
  const serverClient = new QueryClient();
  activeClient = serverClient;
  const loader = Route.options.loader as unknown as (input: {
    params: { id: string; revisionId: string };
    context: { queryClient: InstanceType<typeof QueryClient>; credentialMode: Mode };
  }) => Promise<Parameters<typeof ExactRevisionCaller>[0]['visit']>;
  const serverVisit = loader({
    params: { id: selected.id, revisionId: selected.revisionId },
    context: { queryClient: serverClient, credentialMode: 'anonymous' },
  });
  await Promise.resolve();
  expect(reads).toHaveLength(1);
  reads[0]!.work.resolve({
    data: readyPage,
    provenance: {
      binding: reads[0]!.data.binding,
      actualReader: reads[0]!.actualReader,
      responseGeneration: 1,
    },
  });
  const visit = await serverVisit;

  const browserClient = new QueryClient();
  browserClient.setQueryData(['session'], signedOut);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const html = renderToStaticMarkup(
    <QueryClientProvider client={serverClient}>
      <ExactRevisionCaller
        visit={visit}
        identity={{ postId: selected.id, revisionId: selected.revisionId }}
        locale="en"
        credentialMode="anonymous"
        loading={false}
        onRetry={() => undefined}
      />
    </QueryClientProvider>,
  );
  const host = window.document.createElement('main') as unknown as HTMLElement;
  host.innerHTML = html;
  window.document.body.append(host);
  const { hydrateRoot } = await import('react-dom/client');
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => {
    root = hydrateRoot(
      host,
      <QueryClientProvider client={browserClient}>
        <ExactRevisionCaller
          visit={visit}
          identity={{ postId: selected.id, revisionId: selected.revisionId }}
          locale="en"
          credentialMode="anonymous"
          loading={false}
          onRetry={() => undefined}
        />
      </QueryClientProvider>,
    );
  });
  expect(host.textContent).toContain('Private exact author');
  await act(async () => browserClient.setQueryData(['session'], signedIn()));
  for (const text of hidden) expect(host.innerHTML).not.toContain(text);
  await act(async () => root!.unmount());
  host.remove();
  serverClient.clear();
  browserClient.clear();
});

test('post, revision and locale transitions withhold the old view until the route admits a new visit', async () => {
  const page = await mount({ session: signedOut });
  try {
    await page.settle(0, problem);
    const oldRetry = page.retainRetry();
    const nextPost = id(80);
    const nextRevision = id(81);
    const navigation = page.router.navigate({
      to: '/posts/$id/revisions/$revisionId',
      params: { id: nextPost, revisionId: nextRevision },
    });
    page.setOperation(navigation);
    await new Promise((resolve) => setTimeout(resolve, 0));
    page.hiddenNow();
    expect(reads[1]!.data).toMatchObject({
      postId: nextPost,
      revisionId: nextRevision,
      locale: 'en',
      credentialMode: 'anonymous',
    });
    oldRetry();
    expect(reads).toHaveLength(2);
    await page.settle(1, readyFor(nextPost, nextRevision));
    expect(page.host.textContent).toContain('The original edition leaves room for the reader to pause.');

    setLocale('zh-Hant', { reload: false });
    const localeRefresh = page.router.invalidate();
    page.setOperation(localeRefresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    page.hiddenNow();
    await page.settle(2, readyFor(nextPost, nextRevision));
    expect(reads[2]!.data.postId).toBe(nextPost);
    const activeMatch = page.router.state.matches.find((match) => match.routeId === '/posts/$id/revisions/$revisionId');
    expect((activeMatch?.loaderData as { admission?: { locale?: string } } | undefined)?.admission?.locale).toBe(
      'zh-Hant',
    );
    expect(page.host.querySelector(`a[href^="/${getLocale()}/threads/"]`)).not.toBeNull();
    expect(reads).toHaveLength(3);
  } finally {
    setLocale('en', { reload: false });
    await page.dispose();
  }
});

test('unmount/remount cannot reuse a ready loader result and StrictMode reconnects its original mounted visit', async () => {
  const page = await mount({ session: signedOut, strict: true });
  try {
    await page.settle(0, readyPage);
    expect(page.host.textContent).toContain('The original edition leaves room for the reader to pause.');
    const match = page.router.state.matches.find((item) => item.routeId === '/posts/$id/revisions/$revisionId');
    const visit = match?.loaderData as Parameters<typeof ExactRevisionCaller>[0]['visit'] | undefined;
    expect(visit).toBeDefined();
    await act(async () => page.root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacementRoot = createRoot(page.host);
    page.replaceRoot(replacementRoot);
    await act(async () =>
      replacementRoot.render(
        <StrictMode>
          <QueryClientProvider client={page.client}>
            <ExactRevisionCaller
              visit={visit!}
              identity={{ postId: selected.id, revisionId: selected.revisionId }}
              locale={getLocale()}
              credentialMode="anonymous"
              loading={false}
              onRetry={() => undefined}
            />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    page.hiddenNow();
  } finally {
    await page.dispose();
  }
});
