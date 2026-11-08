import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { dirname } from 'node:path';
import type { WorkbenchRead } from '../src/moderation/workbench-queue/read';
import type { HistoryEntry } from '../src/moderation/workbench-history/read';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/moderation/workbench' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  scrollTo: window.scrollTo.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { WorkbenchRoutePage } = await import('../src/routes/moderation/workbench');
const { createWorkbenchLoader } = await import('../src/moderation/workbench-queue/route-loader');
const { readWorkbenchPage, workbenchSearch } = await import('../src/moderation/workbench-queue/read');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { WorkbenchHistoryWindows } = await import('../src/moderation/workbench-history/window-history');
const { m } = await import('../src/paraglide/messages.js');
const session = { state: 'signed-in', subject: 'moderator', csrfToken: 'original' };
const readerOrigin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(session.csrfToken) };
const entry: HistoryEntry = {
  id: 'exact-decision',
  targetId: 'original-post',
  targetKind: 'post',
  action: 'takedown',
  statement: 'Earlier retained reason',
  decidedAt: '2026-11-04T00:00:00Z',
  history: { reasonState: 'retained', decider: 'withheld', receipt: 'permitted', target: 'unavailable' },
};

test('the production route rereads three native windows, retries Previous, closes an exact receipt and returns to the current queue', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], session);
  const reads: Array<string | undefined> = [];
  let failPrevious = false;
  let failExact = true;
  let exactReads = 0;
  let queueReads = 0;
  const native = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.headers.get('authorization')).toBe('Bearer prepared');
      expect(init?.cache).toBe('no-store');
      const response = (data: unknown, status = 200) =>
        Response.json(data, { status, headers: { [SESSION_HEADER]: 'native-session' } });
      if (url.pathname === '/v1/boards/board-one/moderation-history') {
        const cursor = url.searchParams.get('cursor') ?? undefined;
        reads.push(cursor);
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('targetKind')).toBe('all');
        expect(url.searchParams.has('historyDecision')).toBe(false);
        if (failPrevious && cursor === 'history-2') {
          failPrevious = false;
          return response({ code: 'dependency_unavailable' }, 503);
        }
        return response({
          viewer: { kind: 'board-moderator' },
          entries: cursor === 'history-2' ? [entry] : [],
          nextCursor: cursor === 'history-3' ? null : cursor === 'history-2' ? 'history-3' : 'history-2',
        });
      }
      if (url.pathname === `/v1/moderation-decisions/${entry.id}`) {
        exactReads++;
        return failExact
          ? response({ code: 'dependency_unavailable' }, 503)
          : response({
              ...entry,
              appeal: null,
              appealDeadline: null,
              viewer: {
                affectedAuthor: false,
                observedAt: entry.decidedAt,
                appeal: { state: 'unavailable', reason: 'not_affected_author' },
              },
              targetContext: { state: 'concealed' },
            });
      }
      expect(url.pathname).toBe('/v1/boards/board-one/reports');
      expect(url.searchParams.get('targetKind')).toBe('post');
      expect(url.searchParams.get('order')).toBe('oldest');
      const cursor = url.searchParams.get('cursor');
      queueReads++;
      expect(['queue-original', 'queue-next']).toContain(cursor);
      return response({ reports: [], next: cursor === 'queue-original' ? 'queue-next' : null });
    }) as typeof fetch,
  });
  const loader = createWorkbenchLoader((search, signal) =>
    readWorkbenchPage(native, search, 'Bearer prepared', readerOrigin, signal),
  );
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/moderation/workbench',
    validateSearch: workbenchSearch,
    staleTime: 0,
    gcTime: 0,
    loaderDeps: ({ search }) => search,
    loader: (input) => loader({ ...input, context: { queryClient: cache } }),
    component: () => <WorkbenchRoutePage page={route.useLoaderData()} search={route.useSearch()} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        '/moderation/workbench?board=board-one&queue=reports&cursor=queue-original&targetKind=post&order=oldest',
      ],
    }),
    defaultPendingMs: 0,
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  async function click(label: string) {
    const control = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === label && !button.disabled,
    );
    expect(control).toBeDefined();
    await act(async () => {
      control!.focus();
      control!.click();
      await router.latestLoadPromise;
    });
  }
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={cache}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    await click(m.threads_next_page());
    expect(router.state.location.search.cursor).toBe('queue-next');
    await click(m.moderation_workbench_history());
    expect(reads).toEqual([undefined]);
    await click(m.threads_next_page());
    expect(host.textContent).toContain(entry.statement);
    await click(m.threads_next_page());
    expect(host.textContent).not.toContain(entry.statement);
    expect(host.textContent).toContain(m.moderation_history_empty());
    failPrevious = true;
    await click(m.moderation_workbench_previous());
    expect(host.textContent).toContain(m.moderation_workbench_history_unavailable());
    await click(m.moderation_queue_retry());
    expect(reads).toEqual([undefined, 'history-2', 'history-3', 'history-2', 'history-2']);
    expect(window.document.activeElement?.id).toBe('workbench-history-heading');
    await click(m.moderation_history_open_receipt());
    expect(host.textContent).toContain(m.moderation_history_receipt_unavailable());
    expect(host.textContent).toContain(entry.statement);
    failExact = false;
    await click(m.moderation_queue_retry());
    expect(exactReads).toBe(2);
    expect(host.textContent).toContain(m.moderation_target_withheld());
    expect(host.querySelector('a[href*="original-post"]')).toBeNull();
    await click(m.moderation_history_close_receipt());
    expect((window.document.activeElement as HTMLElement)?.dataset.historyReceipt).toBe(entry.id);
    await click(m.moderation_workbench_previous());
    expect(router.state.location.search.historyCursor).toBeUndefined();
    expect(host.textContent).toContain(m.moderation_workbench_empty_next());
    await click(m.threads_next_page());
    await click(m.moderation_workbench_first());
    expect(router.state.location.search.historyCursor).toBeUndefined();
    await click(m.moderation_workbench_history_return());
    expect(queueReads).toBe(3);
    expect(router.state.location.search.cursor).toBe('queue-next');
    expect(router.state.location.search.targetKind).toBe('post');
    expect(router.state.location.search.order).toBe('oldest');
    expect(window.document.activeElement?.id).toBe('workbench-queue-reports');
    expect(exactReads).toBe(2);
    await click(m.moderation_workbench_previous());
    expect(router.state.location.search.cursor).toBe('queue-original');
    expect(queueReads).toBe(4);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    cache.clear();
  }
});

test('history admission bounds predecessors, retains failed targets and resets on scope or reader replacement', () => {
  const windows = new WorkbenchHistoryWindows();
  let search = workbenchSearch({ board: 'board-one', history: true, cursor: 'queue-kept' });
  let visit = '0';
  const page = (state: 'ready' | 'unavailable' = 'ready', revision = 0): WorkbenchRead => ({
    state: 'ready',
    search,
    readKey: '',
    generation: 'read',
    realms: [],
    realmsNext: null,
    boards: [],
    boardsNext: null,
    reports: [],
    appeals: [],
    selectedTarget: null,
    cases: [],
    next: null,
    history: { state, entries: [], next: 'next' },
    readerOrigin,
    readerBinding: {
      id: 'binding',
      source: 'source',
      revision,
      key: '',
      placement: 'browser',
      expected: readerOrigin,
      retired: false,
    },
  });
  let current = page();
  windows.admit(visit, search, current, 'en', true);
  for (let index = 1; index <= 10; index++) {
    current.history!.next = `cursor-${index}`;
    const next = windows.begin(visit, search, current, 'en', 'next')!;
    windows.navigate(visit, { pathname: '/moderation/workbench', search: next }, search, current);
    search = next;
    visit = String(index);
    current = page();
    windows.admit(visit, search, current, 'en', true);
  }
  // Failed Previous cannot be committed merely because the outer Workbench is ready.
  const previous = windows.begin(visit, search, current, 'en', 'previous')!;
  windows.navigate(visit, { pathname: '/moderation/workbench', search: previous }, search, current);
  search = previous;
  visit = 'failed';
  current = page('unavailable');
  windows.admit(visit, search, current, 'en', true);
  expect(windows.view(visit, search, current).retry).toBe('previous');
  expect(windows.begin(visit, search, current, 'en', 'retry')).toEqual(search);
  current = page();
  windows.admit(visit, search, current, 'en', true);
  for (let index = 0; index < 7; index++) {
    const next = windows.begin(visit, search, current, 'en', 'previous')!;
    windows.navigate(visit, { pathname: '/moderation/workbench', search: next }, search, current);
    search = next;
    visit = `back-${index}`;
    current = page();
    windows.admit(visit, search, current, 'en', true);
  }
  expect(search.historyCursor).toBe('cursor-2');
  expect(search.cursor).toBe('queue-kept');
  expect(windows.view(visit, search, current).previous).toBe(false);
  const next = windows.begin(visit, search, current, 'en', 'next')!;
  windows.navigate(visit, { pathname: '/moderation/workbench', search: next }, search, current);
  search = next;
  visit = 'branch';
  current = page();
  windows.admit(visit, search, current, 'en', true);
  expect(windows.view(visit, search, current).previous).toBe(true);
  windows.admit(visit, search, page('ready', 1), 'en', true);
  expect(windows.view(visit, search, current).previous).toBe(false);
  windows.admit(visit, search, page('ready', 1), 'en', false);
  expect(windows.view(visit, search, current).previous).toBe(false);
});

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
