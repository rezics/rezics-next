import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient, type KernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { startThread } from '../src/threads/actions';
import type { NewThreadPageResult } from '../src/threads/new-thread-read';
import type { ThreadCreationReaderAdmission } from '../src/threads/thread-creation-lifetime';
import type { SessionEnv } from '../src/session/client';

// UNRUN: this connected regression exercises the real QueryClient, admission adapter, reader preparation and composition.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const ownerA = { state: 'signed-in' as const, subject: id(40), csrfToken: 'browser-csrf-a' };
const ownerB = { state: 'signed-in' as const, subject: id(41), csrfToken: 'browser-csrf-b' };
const vote = { questionId: '00000000-0000-7000-8000-000000000001', units: 14, revision: 8 };

type BoardResource = ReturnType<KernelClient['boards']>;
type Board = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
type LoadedPage = NewThreadPageResult & { readerAdmission: ThreadCreationReaderAdmission };
type Purpose = 'discussion' | 'reviews';
type Entry = {
  key: string;
  page: LoadedPage;
  presetSubject?: string;
  presetSubjectTitle?: string;
};

let Composition: typeof import('../src/routes/boards/$id_.new').NewThreadComposition | undefined;

function CompositionHost({ entries }: { entries: Entry[] }) {
  if (!Composition) return null;
  return (
    <>
      {entries.map((entry) => (
        <Composition
          key={entry.key}
          board={entry.page.board}
          idempotencyKey={entry.page.idempotencyKey}
          readerAdmission={entry.page.readerAdmission}
          {...(entry.presetSubject ? { presetSubject: entry.presetSubject } : {})}
          {...(entry.presetSubjectTitle ? { presetSubjectTitle: entry.presetSubjectTitle } : {})}
        />
      ))}
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function boardFor(boardId: string, purpose: Purpose, title: string): Board {
  return {
    id: boardId,
    realmId: id(800),
    community: null,
    route: 0,
    title,
    purpose,
    visibility: 'protected',
    securityRevision: '1',
    availability: 'available',
    createdAt: '2026-01-01T00:00:00.000Z',
  } as Board;
}

function preparedSession(subject: string | undefined, csrfToken: string | null = 'server-csrf') {
  let reads = 0;
  const env = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'board:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'test-only',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => {
          reads++;
          return {
            status: 'active',
            accessToken: `server-access-${subject ?? 'missing'}`,
            subject,
            csrfToken,
          };
        },
      }),
    },
  } as unknown as SessionEnv;
  const request = new Request(`https://site.test/en/boards/${id(1)}/new`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  return { env, request, reads: () => reads };
}

async function preparePage(
  queryClient: import('@tanstack/react-query').QueryClient,
  options: { boardId: string; purpose: Purpose; readerSubject: string; preparedSubject: string; title?: string },
) {
  const [{ loadAdmittedNewThreadPage }, { loadNewThreadPage }] = await Promise.all([
    import('../src/routes/boards/$id_.new'),
    import('../src/threads/new-thread-read'),
  ]);
  const session = preparedSession(options.preparedSubject);
  const board = boardFor(options.boardId, options.purpose, options.title ?? `Private board ${options.readerSubject}`);
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ board });
    }) as typeof fetch,
  });
  const page = await loadAdmittedNewThreadPage(queryClient, options.boardId, (expectedReaderSubject) =>
    loadNewThreadPage(client, session.request, session.env, {
      id: options.boardId,
      expectedReaderSubject,
    }),
  );
  return { page, calls, sessionReads: session.reads() };
}

async function mountCompositions(queryClient: import('@tanstack/react-query').QueryClient, initial: Entry[]) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards/board-one/new', width: 1280, height: 900 });
  const initialTitle = initial[0]?.page.board.title ?? 'New thread';
  const titleTag = window.document.createElement('title');
  titleTag.textContent = `${initialTitle} – REZICS`;
  window.document.head.append(titleTag);
  for (const [attribute, value] of [
    ['property', 'og:title'],
    ['name', 'twitter:title'],
  ] as const) {
    const meta = window.document.createElement('meta');
    meta.setAttribute(attribute, value);
    meta.setAttribute('content', `${initialTitle} – REZICS`);
    window.document.head.append(meta);
  }
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const [{ createRoot }, router, { QueryClientProvider }, { setLocale }, actions, voteRead, { sessionQuery }, route] =
    await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-router'),
      import('@tanstack/react-query'),
      import('../src/paraglide/runtime.js'),
      import('../src/threads/actions'),
      import('../src/threads/review-vote-read'),
      import('../src/session/query'),
      import('../src/routes/boards/$id_.new'),
    ]);
  Composition = route.NewThreadComposition;
  setLocale('en', { reload: false });

  const writes: {
    input: Parameters<typeof actions.startThread>[0];
    data: Parameters<typeof actions.startThread>[0]['data'];
    csrf: string | null;
    work: ReturnType<typeof deferred<Awaited<ReturnType<typeof actions.startThread>>>>;
  }[] = [];
  const write = spyOn(actions, 'startThread').mockImplementation((input) => {
    const work = deferred<Awaited<ReturnType<typeof actions.startThread>>>();
    writes.push({
      input,
      data: structuredClone(input.data),
      csrf: new Headers(input.headers).get('X-CSRF-Token'),
      work,
    });
    return work.promise;
  });
  const voteReads: {
    subjectId: string;
    work: ReturnType<typeof deferred<Awaited<ReturnType<typeof voteRead.readCurrentReviewVote>>>>;
  }[] = [];
  const readVote = spyOn(voteRead, 'readCurrentReviewVote').mockImplementation(({ data }) => {
    const work = deferred<Awaited<ReturnType<typeof voteRead.readCurrentReviewVote>>>();
    voteReads.push({ subjectId: data.subjectId, work });
    return work.promise;
  });
  const navigation: string[] = [];
  const navigate = spyOn(window.location, 'assign').mockImplementation((href) => navigation.push(String(href)));

  let entries = initial;
  function ComposeRoute() {
    return <CompositionHost entries={entries} />;
  }
  const rootRoute = router.createRootRoute({ component: router.Outlet });
  const composeRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: '/compose',
    component: ComposeRoute,
  });
  const boardRoute = router.createRoute({
    getParentRoute: () => rootRoute,
    path: '/boards/$id',
    component: () => <p>Board</p>,
  });
  const appRouter = router.createRouter({
    routeTree: rootRoute.addChildren([composeRoute, boardRoute]),
    history: router.createMemoryHistory({ initialEntries: ['/compose'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <StrictMode>
            <router.RouterProvider router={appRouter} />
          </StrictMode>
        </QueryClientProvider>,
      ),
    );
  };
  const setEntries = async (next: Entry[]) => {
    entries = next;
    await render();
  };
  const settle = async (ready: () => boolean) => {
    for (let index = 0; index < 180 && !ready(); index++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const title = () => host.querySelector<HTMLInputElement>('#thread-title');
  const editor = () => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
  const form = () => host.querySelector<HTMLFormElement>('form');
  const fill = async (titleText: string, bodyText: string) => {
    await settle(() => !!title() && !!editor());
    const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
    const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
    const user = userEvent.setup({ document: window.document });
    await act(async () => user.type(title()!, titleText));
    await act(async () => {
      await user.click(editor()!);
      await user.keyboard(bodyText);
      await user.tab();
    });
  };
  const submit = async () => {
    await act(async () => {
      form()?.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    write.mockRestore();
    readVote.mockRestore();
    navigate.mockRestore();
    Composition = undefined;
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return {
    host,
    window,
    writes,
    voteReads,
    navigation,
    title,
    editor,
    render,
    setEntries,
    settle,
    fill,
    submit,
    dispose,
    sessionKey: sessionQuery.queryKey,
  };
}

async function queryClientWith(
  session: typeof ownerA | typeof ownerB | { state: 'signed-in'; subject: string; csrfToken: null },
) {
  const { QueryClient } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, session);
  return client;
}

test('the production admission adapter binds prepared actual provenance and hydrates a null-CSRF reader read-only', async () => {
  const { dehydrate, hydrate, QueryClient } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { observeThreadCreationReader } = await import('../src/threads/thread-creation-lifetime');
  const serverClient = new QueryClient();
  serverClient.setQueryData(sessionQuery.queryKey, { ...ownerA, csrfToken: null });
  const { page, calls, sessionReads } = await preparePage(serverClient, {
    boardId: id(1),
    purpose: 'discussion',
    readerSubject: ownerA.subject,
    preparedSubject: ownerA.subject,
  });
  expect(page.readerSubject).toBe(ownerA.subject);
  expect(page.readerAdmission.actualSubject).toBe(ownerA.subject);
  expect(page.board.title).toBe(`Private board ${ownerA.subject}`);
  expect(calls).toHaveLength(1);
  expect(sessionReads).toBe(1);
  expect(JSON.stringify(page)).not.toContain('server-access-');
  expect(JSON.stringify(page)).not.toContain('server-csrf');

  const browserClient = new QueryClient();
  hydrate(browserClient, dehydrate(serverClient));
  expect(observeThreadCreationReader(browserClient)).toEqual(page.readerAdmission.observation);
  const pageView = await mountCompositions(browserClient, [{ key: 'null-csrf', page }]);
  try {
    await pageView.render();
    await pageView.settle(() => !!pageView.title() && !!pageView.editor());
    expect(pageView.host.textContent).toContain(page.board.title);
    expect(pageView.host.querySelector('[inert]')).not.toBeNull();
    expect(
      [...pageView.host.querySelectorAll('button')].some((button) => button.type === 'submit' && button.disabled),
    ).toBe(true);
    expect(pageView.writes).toHaveLength(0);
  } finally {
    await pageView.dispose();
    serverClient.clear();
    browserClient.clear();
  }
});

test('the actual prepared subject must match the original observed reader before the board GET', async () => {
  const client = await queryClientWith(ownerA);
  const { loadAdmittedNewThreadPage } = await import('../src/routes/boards/$id_.new');
  const { loadNewThreadPage } = await import('../src/threads/new-thread-read');
  const session = preparedSession(ownerB.subject);
  const calls: Request[] = [];
  const kernel = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ board: boardFor(id(2), 'discussion', 'Wrong reader board') });
    }) as typeof fetch,
  });

  await expect(
    loadAdmittedNewThreadPage(client, id(2), (expectedReaderSubject) =>
      loadNewThreadPage(kernel, session.request, session.env, { id: id(2), expectedReaderSubject }),
    ),
  ).rejects.toMatchObject({ isNotFound: true });
  expect(session.reads()).toBe(1);
  expect(calls).toEqual([]);
  client.clear();
});

test('a delayed original board response is discarded if its observed session changes before admission', async () => {
  const client = await queryClientWith(ownerA);
  const [{ loadAdmittedNewThreadPage }, { loadNewThreadPage }, { sessionQuery }] = await Promise.all([
    import('../src/routes/boards/$id_.new'),
    import('../src/threads/new-thread-read'),
    import('../src/session/query'),
  ]);
  const session = preparedSession(ownerA.subject);
  const response = deferred<Response>();
  const calls: Request[] = [];
  const kernel = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      calls.push(new Request(input, init));
      return response.promise;
    }) as typeof fetch,
  });
  const loading = loadAdmittedNewThreadPage(client, id(7), (expectedReaderSubject) =>
    loadNewThreadPage(kernel, session.request, session.env, { id: id(7), expectedReaderSubject }),
  );
  for (let index = 0; index < 50 && calls.length === 0; index++) await Promise.resolve();
  expect(calls).toHaveLength(1);
  await act(async () => client.setQueryData(sessionQuery.queryKey, ownerB));
  response.resolve(Response.json({ board: boardFor(id(7), 'discussion', 'Private delayed A board') }));
  await expect(loading).rejects.toMatchObject({ isNotFound: true });
  expect(session.reads()).toBe(1);
  expect(calls).toHaveLength(1);
  client.clear();
});

test.each(['discussion', 'reviews'] as const)(
  'a current-token %s reader creates once with its original context, key, cookie and navigation',
  async (purpose) => {
    const client = await queryClientWith(ownerA);
    const boardId = purpose === 'discussion' ? id(3) : id(4);
    const { page, calls, sessionReads } = await preparePage(client, {
      boardId,
      purpose,
      readerSubject: ownerA.subject,
      preparedSubject: ownerA.subject,
    });
    const entry: Entry = {
      key: purpose,
      page,
      presetSubject: id(30),
      presetSubjectTitle: `${purpose} subject`,
    };
    const browser = await mountCompositions(client, [entry]);
    try {
      await browser.render();
      await browser.settle(() => !!browser.title() && !!browser.editor());
      expect(browser.host.textContent).toContain(page.board.title);
      if (purpose === 'reviews') {
        await browser.settle(() => browser.voteReads.length === 1);
        expect(browser.voteReads[0]!.subjectId).toBe(id(30));
        await act(async () => {
          browser.voteReads[0]!.work.resolve(vote);
          await Promise.resolve();
        });
        await browser.settle(() => browser.host.querySelector('[role="checkbox"]') !== null);
        const { default: userEvent } = await import(
          createRequire(createRequire(import.meta.url).resolve('storybook/test')).resolve('@testing-library/user-event')
        );
        const user = userEvent.setup({ document: browser.window.document });
        await act(async () => user.click(browser.host.querySelector('[role="checkbox"]') as HTMLElement));
      }
      await browser.fill(`A ${purpose} thread`, 'This draft belongs to the original observed reader.');
      await browser.submit();
      await browser.settle(() => browser.writes.length === 1);

      const write = browser.writes[0]!;
      expect(write.data).toMatchObject({
        boardId,
        title: `A ${purpose} thread`,
        idempotencyKey: page.idempotencyKey,
      });
      expect(write.csrf).toBe(ownerA.csrfToken);
      if (purpose === 'discussion') {
        expect(write.data).toMatchObject({ subjectIds: [id(30)] });
        expect(write.data).not.toHaveProperty('voteCitation');
      } else {
        expect(write.data).toMatchObject({ kind: 'review', subjectId: id(30), voteCitation: vote });
      }
      expect(typeof write.input.fetch).toBe('function');
      expect(calls).toHaveLength(1);
      expect(sessionReads).toBe(1);
      await act(async () => {
        write.work.resolve({
          ok: true,
          thread: { id: id(50), title: `A ${purpose} thread` },
        } as Awaited<ReturnType<typeof startThread>>);
        await Promise.resolve();
      });
      await browser.settle(() => browser.navigation.length === 1);
      expect(browser.navigation).toEqual([`/en/threads/${id(50)}/a-${purpose}-thread`]);
      expect(browser.window.document.cookie).toContain(`rezics_draft_key=${id(50)}.${write.data.idempotencyKey}`);
      expect(browser.writes).toHaveLength(1);
    } finally {
      await browser.dispose();
      client.clear();
    }
  },
);

test('observer and fetch notifications keep the original visit; equal replacement fences delayed work from a fresh owner', async () => {
  const client = await queryClientWith(ownerA);
  const { QueryObserver } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const first = await preparePage(client, {
    boardId: id(5),
    purpose: 'reviews',
    readerSubject: ownerA.subject,
    preparedSubject: ownerA.subject,
  });
  const oldEntry: Entry = {
    key: 'original-a',
    page: first.page,
    presetSubject: id(31),
    presetSubjectTitle: 'Private A subject',
  };
  const browser = await mountCompositions(client, [oldEntry]);
  try {
    await browser.render();
    await browser.settle(() => !!browser.title() && !!browser.editor() && browser.voteReads.length === 1);
    expect(browser.window.document.title).toContain(first.page.board.title);
    await browser.fill('Original A draft', 'The old request remains an uncertain accepted command.');
    await browser.submit();
    await browser.settle(() => browser.writes.length === 1);
    expect(browser.writes[0]!.data).toMatchObject({
      boardId: id(5),
      kind: 'review',
      subjectId: id(31),
      idempotencyKey: first.page.idempotencyKey,
    });
    const departure = new browser.window.Event('beforeunload', { cancelable: true });
    browser.window.dispatchEvent(departure);
    expect(departure.defaultPrevented).toBe(true);

    const observer = new QueryObserver(client, { ...sessionQuery, enabled: false });
    const unobserve = observer.subscribe(() => {});
    unobserve();
    expect(browser.host.textContent).toContain(first.page.board.title);
    expect(browser.title()?.value).toBe('Original A draft');

    const background = deferred<typeof ownerA>();
    const fetchResult = client.fetchQuery({
      queryKey: sessionQuery.queryKey,
      queryFn: () => background.promise,
      retry: false,
      staleTime: 0,
    });
    await Promise.resolve();
    expect(client.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
    expect(browser.host.textContent).toContain(first.page.board.title);
    expect(browser.title()?.value).toBe('Original A draft');

    await act(async () => {
      background.resolve({ ...ownerA });
      await fetchResult;
    });
    await browser.settle(() => !browser.host.textContent?.includes(first.page.board.title));
    expect(browser.host.textContent).not.toContain('Private A subject');
    expect(browser.window.document.title).not.toContain(first.page.board.title);
    expect(browser.window.document.head.innerHTML).not.toContain(first.page.board.title);
    expect(browser.title()?.value).toBe('Original A draft');

    const { sessionQuery: currentSessionQuery } = await import('../src/session/query');
    await act(async () => client.setQueryData(currentSessionQuery.queryKey, ownerB));
    const second = await preparePage(client, {
      boardId: id(6),
      purpose: 'discussion',
      readerSubject: ownerB.subject,
      preparedSubject: ownerB.subject,
    });
    const newEntry: Entry = {
      key: 'fresh-b',
      page: second.page,
      presetSubject: id(32),
      presetSubjectTitle: 'Fresh B subject',
    };
    await browser.setEntries([oldEntry, newEntry]);
    await browser.settle(() => browser.host.textContent?.includes(second.page.board.title) === true);
    expect(browser.host.textContent).not.toContain(first.page.board.title);
    expect(browser.host.textContent).toContain('Fresh B subject');

    await act(async () => {
      browser.voteReads[0]!.work.resolve(vote);
      browser.writes[0]!.work.resolve({
        ok: true,
        thread: { id: id(51), title: 'Original A draft' },
      } as Awaited<ReturnType<typeof startThread>>);
      await Promise.resolve();
    });
    expect(browser.host.textContent).not.toContain('Private A subject');
    expect(browser.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(browser.writes).toHaveLength(1);
    expect(browser.window.document.cookie).not.toContain('rezics_draft_key=');
    expect(browser.navigation).toEqual([]);

    await browser.fill('Fresh B discussion', 'The new owner gets a new draft and command.');
    await browser.submit();
    await browser.settle(() => browser.writes.length === 2);
    expect(browser.writes[1]!.data).toMatchObject({
      boardId: id(6),
      subjectIds: [id(32)],
      idempotencyKey: second.page.idempotencyKey,
    });
    expect(browser.writes[1]!.csrf).toBe(ownerB.csrfToken);
    await act(async () => {
      browser.writes[1]!.work.resolve({
        ok: true,
        thread: { id: id(52), title: 'Fresh B discussion' },
      } as Awaited<ReturnType<typeof startThread>>);
      await Promise.resolve();
    });
    await browser.settle(() => browser.navigation.length === 1);
    expect(browser.navigation).toEqual([`/en/threads/${id(52)}/fresh-b-discussion`]);
    expect(browser.window.document.cookie).toContain(
      `rezics_draft_key=${id(52)}.${browser.writes[1]!.data.idempotencyKey}`,
    );
    expect(browser.writes).toHaveLength(2);
  } finally {
    await browser.dispose();
    client.clear();
  }
});

test('an old unavailable command result and finally cannot alter a fresh owner visit', async () => {
  const client = await queryClientWith(ownerA);
  const first = await preparePage(client, {
    boardId: id(8),
    purpose: 'discussion',
    readerSubject: ownerA.subject,
    preparedSubject: ownerA.subject,
  });
  const oldEntry: Entry = {
    key: 'uncertain-old-a',
    page: first.page,
    presetSubject: id(33),
    presetSubjectTitle: 'Private A selector',
  };
  const browser = await mountCompositions(client, [oldEntry]);
  try {
    await browser.render();
    await browser.fill('Pending A command', 'This accepted request remains uncertain after ownership retires.');
    await browser.submit();
    await browser.settle(() => browser.writes.length === 1);

    const { sessionQuery } = await import('../src/session/query');
    await act(async () => client.setQueryData(sessionQuery.queryKey, ownerB));
    const second = await preparePage(client, {
      boardId: id(9),
      purpose: 'discussion',
      readerSubject: ownerB.subject,
      preparedSubject: ownerB.subject,
    });
    await browser.setEntries([
      oldEntry,
      {
        key: 'fresh-b-after-failure',
        page: second.page,
        presetSubject: id(34),
        presetSubjectTitle: 'Fresh B selector',
      },
    ]);
    await browser.settle(() => browser.host.textContent?.includes(second.page.board.title) === true);
    expect(browser.host.textContent).not.toContain(first.page.board.title);
    expect(browser.host.textContent).toContain('Fresh B selector');
    expect(browser.writes[0]!.data).toMatchObject({
      boardId: id(8),
      idempotencyKey: first.page.idempotencyKey,
      subjectIds: [id(33)],
    });

    await act(async () => {
      browser.writes[0]!.work.resolve({ ok: false, reason: 'unavailable' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(browser.writes).toHaveLength(1);
    expect(browser.host.textContent).toContain('Fresh B selector');
    expect(browser.host.querySelector<HTMLInputElement>('#thread-title')?.value).toBe('');
    expect(browser.window.document.cookie).not.toContain('rezics_draft_key=');
    expect(browser.navigation).toEqual([]);
  } finally {
    await browser.dispose();
    client.clear();
  }
});

test.each([
  'query-error',
  'query-removal',
  'sign-out',
  'unknown',
  'subject-change',
  'credential-change',
  'readiness-loss',
  'aba',
] as const)('the real composition retires private board disclosure after %s', async (change) => {
  const client = await queryClientWith(ownerA);
  const { sessionQuery } = await import('../src/session/query');
  const loaded = await preparePage(client, {
    boardId: id(60),
    purpose: 'discussion',
    readerSubject: ownerA.subject,
    preparedSubject: ownerA.subject,
  });
  const browser = await mountCompositions(client, [{ key: change, page: loaded.page }]);
  try {
    await browser.render();
    await browser.settle(
      () => !!browser.title() && browser.host.textContent?.includes(loaded.page.board.title) === true,
    );
    if (change === 'query-error') {
      await client
        .fetchQuery({
          queryKey: sessionQuery.queryKey,
          queryFn: async () => {
            throw new Error('session refresh failed');
          },
          retry: false,
          staleTime: 0,
        })
        .catch(() => undefined);
    } else if (change === 'query-removal') {
      client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    } else if (change === 'sign-out') {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    } else if (change === 'unknown') {
      client.setQueryData(sessionQuery.queryKey, { state: 'unknown', subject: null, csrfToken: null });
    } else if (change === 'subject-change') {
      client.setQueryData(sessionQuery.queryKey, ownerB);
    } else if (change === 'credential-change') {
      client.setQueryData(sessionQuery.queryKey, { ...ownerA, csrfToken: 'rotated-csrf' });
    } else if (change === 'readiness-loss') {
      client.setQueryData(sessionQuery.queryKey, { ...ownerA, csrfToken: null });
    } else {
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        client.setQueryData(sessionQuery.queryKey, ownerA);
      });
    }
    await browser.settle(() => !browser.host.textContent?.includes(loaded.page.board.title));
    expect(browser.window.document.title).not.toContain(loaded.page.board.title);
    expect(browser.window.document.head.innerHTML).not.toContain(loaded.page.board.title);
    expect(browser.writes).toHaveLength(0);
    expect(browser.host.querySelector('a[href*="/boards/"]')).toBeNull();
  } finally {
    await browser.dispose();
    client.clear();
  }
});

test('final unmount retires an outstanding review read without restoring private selectors', async () => {
  const client = await queryClientWith(ownerA);
  const loaded = await preparePage(client, {
    boardId: id(70),
    purpose: 'reviews',
    readerSubject: ownerA.subject,
    preparedSubject: ownerA.subject,
  });
  const browser = await mountCompositions(client, [
    { key: 'unmount-review', page: loaded.page, presetSubject: id(71), presetSubjectTitle: 'Private pending subject' },
  ]);
  try {
    await browser.render();
    await browser.settle(() => browser.voteReads.length === 1 && !!browser.editor());
    const oldRead = browser.voteReads[0]!.work;
    await browser.setEntries([]);
    await act(async () => {
      oldRead.resolve(vote);
      await Promise.resolve();
    });
    expect(browser.host.textContent).not.toContain('Private pending subject');
    expect(browser.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(browser.navigation).toEqual([]);
    expect(browser.window.document.cookie).not.toContain('rezics_draft_key=');
  } finally {
    await browser.dispose();
    client.clear();
  }
});
