import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, StrictMode, useState } from 'react';
import * as start from '../.storybook/react-start';
import type { startThread } from '../src/threads/actions';

// UNRUN: composed route regressions use the real fields, composer, session cache and deferred server seams.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const owner = { state: 'signed-in' as const, subject: id(40), csrfToken: 'initial-csrf' };
const vote = { questionId: '00000000-0000-7000-8000-000000000001', units: 14, revision: 8 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type PageConfig = {
  boardId: string;
  purpose: 'discussion' | 'reviews';
  presetSubject: string;
  presetSubjectTitle: string;
  key: string;
  visible: boolean;
};

async function mountPage(initial: PageConfig) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards/board-one/new', width: 1280, height: 900 });
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
    scrollTo: window.scrollTo.bind(window),
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
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { sessionQuery } = await import('../src/session/query');
  const { observeThreadCreationReader, threadCreationPreset } = await import('../src/threads/thread-creation-lifetime');
  const { NewThreadComposition } = await import('../src/routes/boards/$id_.new');
  const actions = await import('../src/threads/actions');
  const voteRead = await import('../src/threads/review-vote-read');
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });

  const writes: {
    data: Parameters<typeof actions.startThread>[0]['data'];
    csrf: string | null;
    work: ReturnType<typeof deferred<Awaited<ReturnType<typeof actions.startThread>>>>;
  }[] = [];
  const write = spyOn(actions, 'startThread').mockImplementation((input) => {
    const work = deferred<Awaited<ReturnType<typeof actions.startThread>>>();
    writes.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
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

  type Board = Parameters<typeof NewThreadComposition>[0]['board'];
  const board = (config: PageConfig): Board =>
    ({ id: config.boardId, purpose: config.purpose, title: 'Reader board' }) as Board;
  let updateConfig!: (next: PageConfig | ((current: PageConfig) => PageConfig)) => void;
  let poke!: () => void;
  function ComposePage() {
    const [config, setConfig] = useState(initial);
    const search = composeRoute.useSearch();
    const params = composeRoute.useParams();
    const [readerAdmission] = useState(() => {
      const observation = observeThreadCreationReader(client);
      return observation ? { observation, actualSubject: observation.subject } : null;
    });
    const [, rerender] = useState(0);
    updateConfig = setConfig;
    poke = () => rerender((value) => value + 1);
    return (
      <>
        {config.visible && readerAdmission ? (
          <NewThreadComposition
            board={board({ ...config, boardId: params.id })}
            idempotencyKey={config.key}
            readerAdmission={readerAdmission}
            {...(search.subject ? { presetSubject: search.subject } : {})}
            {...(search.subjectTitle ? { presetSubjectTitle: search.subjectTitle } : {})}
          />
        ) : null}
        <button type="button" onClick={() => setConfig((current) => ({ ...current, visible: false }))}>
          Hide authoring page
        </button>
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  let routeRead: ReturnType<typeof deferred<void>> | undefined;
  const composeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/boards/$id/new',
    validateSearch: threadCreationPreset,
    loader: () => routeRead?.promise,
    component: ComposePage,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/boards/$id',
    component: () => <p>Board</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([composeRoute, boardRoute]),
    history: createMemoryHistory({
      initialEntries: [
        `/boards/${initial.boardId}/new?${new URLSearchParams({ subject: initial.presetSubject, subjectTitle: initial.presetSubjectTitle })}`,
      ],
    }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, owner);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);

  const render = async () => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <StrictMode>
            <RouterProvider router={router} />
          </StrictMode>
        </QueryClientProvider>,
      ),
    );
  };
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const editor = () => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
  const title = () => host.querySelector<HTMLInputElement>('#thread-title');
  const form = () => host.querySelector<HTMLFormElement>('form')!;
  const fill = async (titleText: string, bodyText: string) => {
    await settle(() => !!title() && !!editor());
    await act(async () => user.type(title()!, titleText));
    await act(async () => {
      await user.click(editor()!);
      await user.keyboard(bodyText);
      await user.tab();
    });
  };
  const submit = async () => {
    // Dispatch does not await the retained deferred transport; the test settles that gate explicitly.
    await act(async () => {
      form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const go = (href: string) => act(() => void router.navigate({ href }));
  const choose = async (choice: 'stay' | 'leave') => {
    await settle(() => !!document.querySelector('[role="alertdialog"]'));
    const label = choice === 'stay' ? m.thread_authoring_stay() : m.thread_authoring_leave();
    await act(async () =>
      user.click([...document.querySelectorAll('button')].find((node) => node.textContent === label)!),
    );
    await settle(() => !document.querySelector('[role="alertdialog"]'));
  };
  const resolveWrite = async (index: number, result: Awaited<ReturnType<typeof actions.startThread>>) => {
    await act(async () => {
      writes[index]!.work.resolve(result);
      await Promise.resolve();
    });
  };
  const dispose = async () => {
    await act(async () => root.unmount());
    write.mockRestore();
    readVote.mockRestore();
    navigate.mockRestore();
    client.clear();
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
    client,
    router,
    m,
    user,
    setLocale,
    sessionKey: sessionQuery.queryKey,
    writes,
    voteReads,
    navigation,
    title,
    editor,
    render,
    settle,
    fill,
    submit,
    choose,
    go,
    pauseRead: () => (routeRead = deferred<void>()),
    resolveWrite,
    updateConfig,
    poke,
    dispose,
  };
}

test('real new-thread composition preserves a selected review citation and retries the exact uncertain command', async () => {
  const page = await mountPage({
    boardId: id(1),
    purpose: 'reviews',
    presetSubject: id(2),
    presetSubjectTitle: 'Selected subject',
    key: id(3),
    visible: true,
  });
  try {
    await page.render();
    await page.settle(() => page.voteReads.length === 1 && !!page.editor());
    expect(page.voteReads.map(({ subjectId }) => subjectId)).toEqual([id(2)]);
    await act(async () => {
      page.voteReads[0]!.work.resolve(vote);
      await Promise.resolve();
    });
    await page.settle(() => page.host.querySelector('[role="checkbox"]') !== null);
    const checkbox = page.host.querySelector<HTMLElement>('[role="checkbox"]')!;
    await act(async () => page.user.click(checkbox));
    await page.fill('A review title', 'My review stays attached to this subject.');
    await page.poke();
    expect(page.host.querySelector<HTMLElement>('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => page.updateConfig((current) => ({ ...current, key: id(5) })));
    await page.submit();
    await page.settle(() => page.writes.length === 1);
    const original = structuredClone(page.writes[0]!.data);
    expect(original).toMatchObject({
      boardId: id(1),
      title: 'A review title',
      kind: 'review',
      subjectId: id(2),
      voteCitation: vote,
      idempotencyKey: id(3),
    });
    expect(page.writes[0]!.csrf).toBe(owner.csrfToken);
    await act(async () => page.writes[0]!.work.reject(new Error('Response lost after commit')));
    await page.settle(() => page.host.textContent?.includes(page.m.thread_write_unavailable()) === true);
    await page.go(`/boards/${id(1)}/new?subject=${id(4)}`);
    await page.choose('stay');
    expect(page.host.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    expect(page.writes).toHaveLength(1);
    await act(async () => {
      const retry = [...page.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === page.m.thread_write_retry(),
      );
      expect(retry).toBeDefined();
      await page.user.click(retry!);
    });
    await page.settle(() => page.writes.length === 2);
    expect(page.writes[1]!.data).toEqual(original);
    expect(page.writes[1]!.csrf).toBe(owner.csrfToken);
    const created = {
      ok: true,
      thread: { id: id(9), title: 'A review title' },
    } as Awaited<ReturnType<typeof startThread>>;
    await page.resolveWrite(1, created);
    await page.settle(() => page.navigation.length === 1);
    expect(page.navigation).toEqual([`/en/threads/${id(9)}/a-review-title`]);
    expect(page.window.document.cookie).toContain(`rezics_draft_key=${id(9)}.${page.writes[1]!.data.idempotencyKey}`);
    expect(page.voteReads).toHaveLength(1);

    await act(async () => page.updateConfig((current) => ({ ...current, visible: false })));
    await act(async () => page.updateConfig((current) => ({ ...current, visible: true })));
    await page.settle(() => !!page.editor() && page.voteReads.length === 2);
    expect(page.title()?.value).toBe('');
    await act(async () => {
      page.voteReads[1]!.work.resolve(null);
      await Promise.resolve();
    });
  } finally {
    await page.dispose();
  }
});

test('same-turn session away and back retires late review reads, writes and their cookie/navigation effects', async () => {
  const page = await mountPage({
    boardId: id(11),
    purpose: 'reviews',
    presetSubject: id(12),
    presetSubjectTitle: 'Private subject',
    key: id(13),
    visible: true,
  });
  try {
    await page.render();
    await page.settle(() => page.voteReads.length === 1 && !!page.editor());
    await page.fill('An unsubmitted review', 'The body remains protected in the composer.');
    await page.submit();
    await page.settle(() => page.writes.length === 1);

    await act(async () => {
      page.client.setQueryData(page.sessionKey, {
        state: 'signed-out',
        subject: null,
        csrfToken: null,
      });
      page.client.setQueryData(page.sessionKey, owner);
    });
    await page.settle(() => page.host.textContent?.includes(page.m.thread_authoring_session_changed()) === true);
    expect(page.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(page.voteReads).toHaveLength(1);
    expect(page.writes).toHaveLength(1);

    await act(async () => {
      page.voteReads[0]!.work.resolve(vote);
      page.writes[0]!.work.resolve({
        ok: true,
        thread: { id: id(19), title: 'An unsubmitted review' },
      } as Awaited<ReturnType<typeof startThread>>);
      await Promise.resolve();
    });
    await page.settle(() => page.host.querySelector('[role="alert"]') !== null);
    expect(page.host.querySelector('[role="checkbox"]')).toBeNull();
    expect(page.window.document.cookie).not.toContain('rezics_draft_key=');
    expect(page.navigation).toEqual([]);
    expect(page.writes).toHaveLength(1);
  } finally {
    await page.dispose();
  }
});

test('preset navigation and Back/Forward preserve a draft on Stay and replace it only on Leave', async () => {
  const page = await mountPage({
    boardId: id(21),
    purpose: 'discussion',
    presetSubject: id(22),
    presetSubjectTitle: 'Discussion subject',
    key: id(23),
    visible: true,
  });
  try {
    await page.render();
    await page.fill('A discussion title', 'A discussion can cite an ordered reference list.');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      'base64',
    );
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/original')) return new Response(png, { headers: { 'content-type': 'image/png' } });
      if (init?.method === 'PUT') return new Response(null, { status: 204 });
      return Response.json({
        media: { id: id(90), state: 'available', mediaType: 'image/png', byteCount: png.length },
      });
    });
    const clipboard = new page.window.DataTransfer();
    clipboard.setData('text/html', `<img src="/media/${id(75)}" alt="Draft chart">`);
    await act(async () => {
      await page.user.click(page.editor()!);
      await page.user.paste(clipboard);
    });
    await page.settle(
      () =>
        !!page.host.querySelector('[role="img"][aria-label="Draft chart"]') &&
        page.host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled === false,
    );
    const original = { title: page.title(), body: page.editor()!.innerHTML };
    const href = (subject: string) => `/boards/${id(21)}/new?subject=${subject}`;
    await act(async () => page.router.navigate({ href: `${href(id(22))}&subjectTitle=New+hint&unrelated=1#anchor` }));
    original.title!.focus();
    await page.go(href(id(24)));
    await page.choose('stay');
    await page.settle(() => document.activeElement === original.title);
    expect(page.title()).toBe(original.title);
    expect(page.editor()!.innerHTML).toBe(original.body);
    expect(page.host.textContent).toContain('Discussion subject');
    await page.go(href(id(24)));
    await page.choose('leave');
    await page.settle(() => !!page.editor() && page.title()?.value === '');
    expect(page.host.innerHTML).not.toContain('Draft chart');
    await page.fill('Replacement draft', 'Replacement body');
    await act(async () => page.router.history.back());
    await page.choose('stay');
    expect(page.title()?.value).toBe('Replacement draft');
    for (const direction of ['back', 'forward'] as const) {
      await act(async () => page.router.history[direction]());
      await page.choose('leave');
      await page.settle(() => !!page.editor() && page.title()?.value === '');
      await page.fill('Another draft', 'Writing in the selected context');
    }
    await page.submit();
    await page.settle(() => page.writes.length === 1);
    expect(page.writes[0]!.data).toMatchObject({ subjectIds: [id(24)] });
    expect(page.writes[0]!.data.idempotencyKey).not.toBe(id(23));
    const replacementRead = page.pauseRead();
    await page.go(`/boards/${id(25)}/new`);
    await page.choose('leave');
    await page.resolveWrite(0, { ok: true, thread: { id: id(28), title: 'Late thread' } } as Awaited<
      ReturnType<typeof startThread>
    >);
    expect(page.navigation).toEqual([]);
    expect(page.window.document.cookie).not.toContain('rezics_draft_key=');
    await act(async () => replacementRead.resolve());
    await page.settle(() => !!page.editor() && page.title()?.value === '');
    expect(page.writes).toHaveLength(1);
  } finally {
    await page.dispose();
  }
});

test('ordinary discussion submission keeps its ordered preset and current success side effects', async () => {
  const page = await mountPage({
    boardId: id(25),
    purpose: 'discussion',
    presetSubject: id(26),
    presetSubjectTitle: 'Ordered discussion reference',
    key: id(27),
    visible: true,
  });
  try {
    await page.render();
    await page.settle(
      () => !!page.editor() && page.host.textContent?.includes('Ordered discussion reference') === true,
    );
    await page.fill('An ordinary discussion', 'The selected reference stays ordered in the command.');
    await page.submit();
    await page.settle(() => page.writes.length === 1);
    expect(page.writes[0]!.data).toMatchObject({
      boardId: id(25),
      title: 'An ordinary discussion',
      subjectIds: [id(26)],
    });
    expect(page.writes[0]!.data).not.toHaveProperty('voteCitation');
    expect(page.voteReads).toHaveLength(0);

    await page.resolveWrite(0, {
      ok: true,
      thread: { id: id(28), title: 'An ordinary discussion' },
    } as Awaited<ReturnType<typeof startThread>>);
    await page.settle(() => page.navigation.length === 1);
    expect(page.navigation).toEqual([`/en/threads/${id(28)}/an-ordinary-discussion`]);
    expect(page.window.document.cookie).toContain(`rezics_draft_key=${id(28)}.${page.writes[0]!.data.idempotencyKey}`);
  } finally {
    await page.dispose();
  }
});

test('same-account CSRF replacement immediately clears private writing and cannot send with the new token', async () => {
  const page = await mountPage({
    boardId: id(31),
    purpose: 'discussion',
    presetSubject: id(32),
    presetSubjectTitle: 'Current reference',
    key: id(33),
    visible: true,
  });
  try {
    await page.render();
    await page.settle(() => !!page.editor() && page.host.textContent?.includes('Current reference') === true);
    await page.fill('Private discussion', 'This exact draft remains in the mounted composer.');
    await act(async () => page.client.setQueryData(page.sessionKey, { ...owner, csrfToken: 'replacement-csrf' }));
    await page.settle(() => page.host.textContent?.includes(page.m.thread_authoring_session_changed()) === true);
    expect(page.host.textContent).not.toContain('Current reference');
    expect(page.title()).toBeNull();
    expect(page.editor()).toBeNull();
    expect(page.host.innerHTML).not.toContain('Private discussion');
    expect(page.writes).toHaveLength(0);
  } finally {
    await page.dispose();
  }
});

test('locale changes retire metadata monotonically while benign rerenders keep the selection', async () => {
  const page = await mountPage({
    boardId: id(41),
    purpose: 'discussion',
    presetSubject: id(42),
    presetSubjectTitle: 'Locale-bound reference',
    key: id(43),
    visible: true,
  });
  try {
    await page.render();
    await page.settle(() => !!page.editor() && page.host.textContent?.includes('Locale-bound reference') === true);
    await page.poke();
    expect(page.host.textContent).toContain('Locale-bound reference');
    await page.fill('A draft title', 'A draft body');
    await act(async () => page.setLocale('fr', { reload: false }));
    await page.poke();
    await page.settle(() => page.host.textContent?.includes(page.m.thread_authoring_session_changed()) === true);
    expect(page.host.textContent).not.toContain('Locale-bound reference');
    expect(page.title()?.value).toBe('A draft title');
    await act(async () => page.setLocale('en', { reload: false }));
    await page.poke();
    expect(page.host.textContent).not.toContain('Locale-bound reference');
    expect(page.writes).toHaveLength(0);
  } finally {
    await page.dispose();
  }
});

test('caller revisions reject retained callbacks after same-value cache replacement and same-turn readiness loss', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { ThreadCreationLifetime, observeThreadCreationReader, threadCreationSessionSource } =
    await import('../src/threads/thread-creation-lifetime');
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, owner);
  const source = threadCreationSessionSource(client);
  const observation = observeThreadCreationReader(client);
  expect(observation).not.toBeNull();
  const admission = { observation: observation!, actualSubject: owner.subject };
  const binding = { client, source, scope: 'board-purpose-original-intent' };
  const lifetime = new ThreadCreationLifetime(client, source, () => binding, binding.scope, admission);
  const disconnect = lifetime.connect();
  const originalTicket = lifetime.connectionTicket;
  const retainedSelection = () => lifetime.isEditable(originalTicket);
  expect(retainedSelection()).toBe(true);
  const queuedSelection = Promise.resolve().then(retainedSelection);

  client.setQueryData(sessionQuery.queryKey, { ...owner });
  expect(source.snapshot()).toBe(1);
  expect(await queuedSelection).toBe(false);
  disconnect();

  const replayClient = new QueryClient();
  replayClient.setQueryData(sessionQuery.queryKey, owner);
  const replaySource = threadCreationSessionSource(replayClient);
  const replayObservation = observeThreadCreationReader(replayClient);
  expect(replayObservation).not.toBeNull();
  const replayAdmission = { observation: replayObservation!, actualSubject: owner.subject };
  const replayBinding = { client: replayClient, source: replaySource, scope: 'same-mounted-visit' };
  const replay = new ThreadCreationLifetime(
    replayClient,
    replaySource,
    () => replayBinding,
    replayBinding.scope,
    replayAdmission,
  );
  const firstCleanup = replay.connect();
  const beforeReplay = replay.connectionTicket;
  firstCleanup();
  const replayCleanup = replay.connect();
  const afterReplay = replay.connectionTicket;
  expect(replay.isCurrent(beforeReplay)).toBe(false);
  expect(replay.isCurrent(afterReplay)).toBe(true);
  await Promise.resolve();
  expect(replay.isCurrent(afterReplay)).toBe(true);
  replayCleanup();
  await Promise.resolve();
  expect(replay.isCurrent(afterReplay)).toBe(false);

  const readinessClient = new QueryClient();
  readinessClient.setQueryData(sessionQuery.queryKey, owner);
  const readinessSource = threadCreationSessionSource(readinessClient);
  const readinessObservation = observeThreadCreationReader(readinessClient);
  expect(readinessObservation).not.toBeNull();
  const readinessAdmission = { observation: readinessObservation!, actualSubject: owner.subject };
  const readinessBinding = { client: readinessClient, source: readinessSource, scope: 'ready-original' };
  const readiness = new ThreadCreationLifetime(
    readinessClient,
    readinessSource,
    () => readinessBinding,
    readinessBinding.scope,
    readinessAdmission,
  );
  const readinessCleanup = readiness.connect();
  const readinessTicket = readiness.connectionTicket;
  readinessClient.setQueryData(sessionQuery.queryKey, { state: 'unknown', subject: null, csrfToken: null });
  readinessClient.setQueryData(sessionQuery.queryKey, owner);
  expect(readiness.isCurrent(readinessTicket)).toBe(false);
  readinessCleanup();

  client.clear();
  replayClient.clear();
  readinessClient.clear();
});

test('mounted future-thread attachments retain recovery only until the admitted composer leaves', async () => {
  const page = await mountPage({
    boardId: id(81),
    purpose: 'discussion',
    presetSubject: id(82),
    presetSubjectTitle: 'Subject',
    key: id(83),
    visible: true,
  });
  const reservations: { body: Record<string, unknown>; key: string | null }[] = [];
  let first = true;
  let lose = true;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      reservations.push({ body, key: new Headers(init.headers).get('idempotency-key') });
      if (body.newThread) {
        if (!first) return Response.json({}, { status: 409 });
        first = false;
      } else if (lose) {
        lose = false;
        throw new Error('lost reservation');
      }
      return Response.json({
        media: { id: id(84), containerId: id(85), state: 'reserved', mediaType: 'image/png', byteCount: 3 },
      });
    }
    if (init?.method === 'PUT') return new Response(null, { status: 204 });
    return Response.json({ media: { id: id(84), state: 'available', mediaType: 'image/png', byteCount: 3 } });
  });
  const button = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
  const attach = async (name: string) => {
    await act(async () => page.user.click(button(page.m.editor_image())));
    await page.settle(() => !!document.querySelector('input[type="file"]'));
    await act(async () =>
      page.user.upload(
        document.querySelector<HTMLInputElement>('input[type="file"]')!,
        new File(['png'], name, { type: 'image/png' }),
      ),
    );
    await act(async () => page.user.click(button(page.m.editor_insert_image())));
  };
  try {
    await page.render();
    await page.fill('Draft title', 'Keep this writing through recovery.');
    await attach('first.png');
    await page.settle(() => reservations.length === 1 && page.host.querySelector('[role="img"]') !== null);
    await attach('second.png');
    await page.settle(() => !!button(page.m.editor_retry_upload()));
    expect(page.title()?.value).toBe('Draft title');
    await act(async () => page.user.click(button(page.m.editor_retry_upload())));
    await page.settle(() => reservations.length === 3);
    expect(reservations[1]!.body).toMatchObject({ containerId: id(85) });
    expect(reservations[2]).toEqual(reservations[1]);
    await act(async () => page.updateConfig((current) => ({ ...current, visible: false })));
    await act(async () => page.updateConfig((current) => ({ ...current, visible: true })));
    await page.settle(() => !!page.editor());
    await attach('new-visit.png');
    await page.settle(() => reservations.length === 4);
    expect(reservations[3]!.body).toHaveProperty('newThread');
    expect(reservations[3]!.body).not.toHaveProperty('containerId');
  } finally {
    transport.mockRestore();
    await page.dispose();
  }
});

test('retired page attachments ignore late reservation stages after departure and credential ABA; a fresh composer admits new files', async () => {
  for (const reason of ['departure', 'account', 'csrf'] as const) {
    const page = await mountPage({
      boardId: id(101),
      purpose: 'discussion',
      presetSubject: id(102),
      presetSubjectTitle: 'Subject',
      key: id(103),
      visible: true,
    });
    const late = deferred<Response>();
    let posts = 0;
    let puts = 0;
    const transport = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        posts++;
        if (posts === 1) return late.promise;
        return Response.json({
          media: { id: id(104), containerId: id(105), state: 'reserved', mediaType: 'image/png', byteCount: 3 },
        });
      }
      if (init?.method === 'PUT') {
        puts++;
        return new Response(null, { status: 204 });
      }
      return Response.json({ media: { id: id(104), state: 'available', mediaType: 'image/png', byteCount: 3 } });
    });
    const button = (name: string) =>
      [...page.host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
    const attach = async () => {
      await act(async () => page.user.click(button(page.m.editor_image())));
      const panel = page.host.querySelector('[role="dialog"]')!;
      await act(async () =>
        page.user.upload(
          panel.querySelector<HTMLInputElement>('input[type="file"]')!,
          new File(['png'], 'same.png', { type: 'image/png' }),
        ),
      );
      await act(async () => page.user.click(button(page.m.editor_insert_image())));
    };
    try {
      await page.render();
      await page.fill('Current draft', 'Keep until accepted departure.');
      await attach();
      await page.settle(() => posts === 1);
      const staleRemove = button(page.m.editor_dismiss_upload());
      if (reason === 'departure') {
        await page.go(`/boards/${id(101)}`);
        await page.choose('leave');
      } else {
        await act(async () => {
          page.client.setQueryData(page.sessionKey, {
            ...owner,
            ...(reason === 'account' ? { subject: id(106) } : { csrfToken: 'replacement' }),
          });
          page.client.setQueryData(page.sessionKey, owner);
        });
      }
      await act(async () => {
        staleRemove.click();
        late.resolve(
          Response.json({
            media: { id: id(107), containerId: id(108), state: 'reserved', mediaType: 'image/png', byteCount: 3 },
          }),
        );
        await Promise.resolve();
      });
      expect(puts).toBe(0);
      expect(page.host.querySelector('[role="img"]')).toBeNull();
      if (reason === 'departure') await page.go(`/boards/${id(101)}/new`);
      else {
        await act(async () => page.updateConfig((current) => ({ ...current, visible: false })));
        await act(async () => page.updateConfig((current) => ({ ...current, visible: true })));
      }
      await page.settle(() => !!page.editor());
      await attach();
      await page.settle(() => page.host.querySelector('[role="img"]') !== null);
      expect(posts).toBe(2);
      expect(puts).toBe(1);
    } finally {
      transport.mockRestore();
      await page.dispose();
    }
  }
});
