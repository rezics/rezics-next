import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { WorkbenchReader, WorkbenchNativeSource } from '../src/moderation/workbench-queue/read';
import type { ModerationDirectoryPage } from '../src/moderation/workbench-queue/directory';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/moderation/workbench' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/moderation/workbench');
const { Route: CaseRoute } = await import('../src/routes/moderation/cases.$id');
const { createWorkbenchLoader } = await import('../src/moderation/workbench-queue/route-loader');
const { readWorkbench } = await import('../src/moderation/workbench-queue/read');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { prepareModerationReportRead, reportReadKey } = await import('../src/moderation/reports-read');
const { workbenchCaseInput } = await import('../src/moderation/workbench-case/read-model');
const { workbenchQueueHref, workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { m } = await import('../src/paraglide/messages.js');
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

test('served discovery selects a direct Board or independent Global queue, inspects an exact case and returns to its captured page', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'moderator', csrfToken: null });
  const readerOrigin = { subject: 'moderator', csrfFingerprint: await privateReaderFingerprint(null) };
  const directory: ModerationDirectoryPage = {
    state: 'ready',
    source: 'native-source',
    validUntil: new Date(Date.now() + 60000).toISOString(),
    next: 'next-discovery',
    items: [
      {
        scope: { kind: 'board', id: 'direct-board' },
        label: 'Direct Board',
        parent: { id: 'parent', label: 'Parent Realm' },
        queues: ['reports', 'appeals', 'resolved'],
        viewer: { open: 'permitted' },
      },
      {
        scope: { kind: 'catalogue' },
        label: 'Global catalogue',
        parent: null,
        queues: ['reports', 'resolved'],
        viewer: { open: 'permitted' },
      },
    ],
  };
  const report = {
    id: 'exact-report',
    target: { kind: 'post' as const, id: 'different-target' },
    revisionId: null,
    reason: 'spam',
    evidence: null,
    createdAt: '2026-11-01T00:00:00Z',
    outcome: null,
    resolvedAt: null,
  };
  const calls: string[] = [];
  const source: WorkbenchNativeSource = {
    directory: async (input) => {
      calls.push(`directory:${input.cursor}:${input.realmId}`);
      return directory;
    },
    realms: async () => {
      throw new Error('Membership cannot create a queue');
    },
    boards: async () => {
      throw new Error('Board inventory cannot create a queue');
    },
    boardReports: async (id, cursor) => {
      calls.push(`board:${id}:${cursor}`);
      return { reports: [report], next: 'queue-next' };
    },
    boardAppeals: async () => ({ appeals: [], next: null }),
    catalogueReports: async (_, selection) => {
      calls.push(`catalogue:${selection.status}`);
      return { reports: [], next: null };
    },
  };
  const read: WorkbenchReader = async (search, signal) => ({
    ...(await readWorkbench(source, search, signal)),
    generation: crypto.randomUUID(),
    readerOrigin,
  });
  const parent = createRootRouteWithContext<{ queryClient: typeof client }>()({ component: Outlet });
  const route = Route.update({
    path: '/moderation/workbench',
    getParentRoute: () => parent,
    beforeLoad: () => {},
    loader: createWorkbenchLoader(read),
  } as never);
  const inspected: string[] = [];
  const caseRoute = CaseRoute.update({
    path: '/moderation/cases/$id',
    getParentRoute: () => parent,
    beforeLoad: () => {},
    loader: async ({
      params,
      deps,
      context,
      abortController,
      location,
    }: {
      params: { id: string };
      deps: Parameters<typeof workbenchCaseInput>[0];
      context: { queryClient: typeof client };
      abortController: AbortController;
      location: { state: { __TSR_key?: string }; href: string };
    }) => {
      const input = workbenchCaseInput(deps, params.id);
      inspected.push(input.reportId!);
      const page = await prepareModerationReportRead(
        context.queryClient,
        input,
        async () => ({
          readKey: reportReadKey(input),
          generation: crypto.randomUUID(),
          viewerId: 'moderator',
          readerOrigin,
          input,
          reports: [report],
          targets: [],
          revisions: [],
          next: null,
          state: 'ready',
        }),
        abortController.signal,
      );
      return { ...page, navigationKey: location.state.__TSR_key ?? location.href };
    },
  } as never);
  const original = workbenchSearch({ realm: 'original-filter', directoryCursor: 'opaque:/+frontier=' });
  const router = createRouter({
    routeTree: parent.addChildren([route, caseRoute]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [workbenchQueueHref(original)] }),
  });
  await router.load();
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
  const follow = async (link: HTMLAnchorElement) => {
    const url = new URL(link.href);
    await act(() => router.navigate({ href: url.pathname + url.search }));
  };
  try {
    await act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    expect(host.textContent).toContain('Direct Board');
    const select = host.querySelector<HTMLButtonElement>(
      '[aria-label="Direct Board: ' + m.moderation_workbench_queue_reports() + '"]',
    )!;
    await act(() => select.click());
    expect(router.state.location.search).toMatchObject({
      board: 'direct-board',
      realm: 'parent',
      directoryRealm: 'original-filter',
      directoryCursor: original.directoryCursor,
    });
    await act(() => button(m.threads_next_page()).click());
    const queueLocation = router.state.location.href;
    await follow(host.querySelector<HTMLAnchorElement>('a[href*="/moderation/cases/"]')!);
    expect(inspected).toEqual(['exact-report']);
    expect(host.querySelector('article')).not.toBeNull();
    await follow(host.querySelector<HTMLAnchorElement>('a[href*="/moderation/workbench?"]')!);
    expect(router.state.location.href).toBe(queueLocation);
    await act(() => button(m.moderation_directory_return()).click());
    expect(calls.filter((call) => call.startsWith('directory:'))).toEqual(
      Array(2).fill('directory:opaque:/+frontier=:original-filter'),
    );
    const globalButton = host.querySelector<HTMLButtonElement>(
      '[aria-label="Global catalogue: ' + m.moderation_workbench_queue_resolved() + '"]',
    )!;
    await act(() => globalButton.click());
    expect(calls.at(-1)).toBe('catalogue:resolved');
    expect(host.querySelector('#workbench-queue-appeals')).toBeNull();
    expect(router.state.location.search).toMatchObject({
      scope: 'catalogue',
      directoryCursor: original.directoryCursor,
    });
    await act(() => button(m.moderation_directory_return()).click());
    expect(host.textContent).toContain('Direct Board');
    delete source.directory;
    await act(() => router.invalidate({ sync: true }));
    expect(host.textContent).toContain(m.moderation_directory_continuation_failed());
    expect(host.querySelector('[data-moderation-scope]')).toBeNull();
    await act(() => router.navigate({ href: workbenchQueueHref(workbenchSearch({ board: 'manual-board' })) }));
    expect(calls.at(-1)).toBe('board:manual-board:undefined');
    expect(host.querySelector('a[href*="/moderation/cases/"]')).not.toBeNull();
  } finally {
    await act(() => root.unmount());
    client.clear();
  }
});
