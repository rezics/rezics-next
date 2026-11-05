import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useLayoutEffect, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { CopiesCurrentRead, CopyDetailCurrentRead } from '../src/library/copies-actions';
import type { CopiesPageData, CopyItem } from '../src/library/copies-read';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/library/copies' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({
    open,
    children,
    onOpenChangeComplete,
  }: {
    open: boolean;
    children: ReactNode;
    onOpenChangeComplete?: (open: boolean) => void;
  }) => {
    useLayoutEffect(() => {
      if (!open) onOpenChangeComplete?.(false);
    }, [open, onOpenChangeComplete]);
    return open ? <div role="dialog">{children}</div> : null;
  },
  DialogContent: Part,
  DialogDescription: Part,
  DialogHeader: Part,
  DialogTitle: Part,
  DialogFooter: Part,
  DialogClose: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  DialogTrigger: Part,
  DialogOverlay: Part,
  DialogPortal: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({ BottomSheet: Part }));
mock.module('@rezics/ui/responsive-dialog', () => ({
  ResponsiveDialog: ({
    open,
    children,
    onOpenChangeComplete,
    finalFocus,
  }: {
    open: boolean;
    children: ReactNode;
    onOpenChangeComplete?: (open: boolean) => void;
    finalFocus?: () => HTMLElement | false;
  }) => {
    useLayoutEffect(() => {
      if (!open) {
        const target = finalFocus?.();
        if (target && target.isConnected) target.focus();
        onOpenChangeComplete?.(false);
      }
    }, [open]);
    return open ? <div role="dialog">{children}</div> : null;
  },
}));
mock.module('@rezics/ui/shadcn/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogContent: Part,
  AlertDialogDescription: Part,
  AlertDialogFooter: Part,
  AlertDialogHeader: Part,
  AlertDialogTitle: Part,
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ trigger, entries }: { trigger: ReactNode; entries: { label: string; onSelect: () => void }[] }) => (
    <div>
      {trigger}
      {entries.map((entry) => (
        <button key={entry.label} onClick={entry.onSelect}>
          {entry.label}
        </button>
      ))}
    </div>
  ),
}));

const actions = await import('../src/library/copies-actions');
const { Route: CopiesRoute } = await import('../src/routes/library/copies');
const { copyInventoryReturnHref } = await import('../src/library/copy-reading-context/navigation');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const routerApi = await import('@tanstack/react-router');
const { createRoute, createRootRoute, createMemoryHistory, RouterProvider, Outlet, Link, useRouterState } = routerApi;
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { copiesAddress, copiesQuery } = await import('../src/library/copies-query');
const {
  admitCopiesWindowRead,
  createCopiesWindows,
  reconcileCopiesWindows,
  stageCopiesWindowMove,
} = await import('../src/library/copies-windows/model');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { CopiesCurrent } = await import('../src/library/copies-current');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
const edition = id(10);
type Search = { subjectId?: string; kind?: string; status?: string; cursor?: string };
function copy(number: number, note = `Copy from window ${number}`): CopyItem {
  return {
    id: id(number),
    revision: 7,
    kind: 'print',
    status: 'shelf',
    meaning: 'known',
    statusEditing: { state: 'supported', statuses: [{ id: 'shelf', label: 'On shelf' }] },
    location: 'Study',
    source: 'Bookshop',
    acquiredOn: null,
    disposedOn: null,
    note,
    subject: { id: edition, type: 'Book', label: 'Window edition', cover: null },
    idempotencyKey: id(number + 100),
  };
}
function response(search: Search, page: Partial<CopiesPageData> = {}): CopiesCurrentRead {
  const cursor = search.cursor ?? null;
  const number = cursor === 'c1' ? 2 : cursor === 'c2' ? 3 : 1;
  return {
    sessionSubject: 'A',
    requested: { ...copiesAddress(search, 'en') },
    page: {
      signedIn: true,
      subjectId: search.subjectId ?? null,
      kind: search.kind ?? null,
      status: search.status ?? null,
      requestedCursor: cursor,
      copies: [copy(number)],
      next: cursor === null ? 'c1' : cursor === 'c1' ? 'c2' : null,
      addKey: id(90 + number),
      sendKind: true,
      ...page,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('window history keeps eight admitted opaque predecessors and never infers a direct cursor predecessor', () => {
  let address = copiesAddress({}, 'en');
  let state = createCopiesWindows(address, 'reader-0', 1);
  state = admitCopiesWindowRead(state, address, 'reader-0', 1, {
    signedIn: true,
    subjectId: null,
    copies: [],
    next: 'c1',
    addKey: id(90),
  }).state;
  for (let index = 1; index <= 10; index++) {
    const cursor = `c${index}`;
    state = stageCopiesWindowMove(state, address, 'more', cursor, false);
    const nextAddress = copiesAddress({ cursor }, 'en');
    const reader = `reader-${index}`;
    state = reconcileCopiesWindows(state, nextAddress, reader, 1, true);
    state = admitCopiesWindowRead(state, nextAddress, reader, 1, {
      signedIn: true,
      subjectId: null,
      requestedCursor: cursor,
      copies: [],
      next: index === 10 ? null : `c${index + 1}`,
      addKey: id(90 + index),
    }).state;
    address = nextAddress;
  }
  expect(state.current).toBe('c10');
  expect(state.predecessors).toHaveLength(8);
  expect(state.predecessors[0]).toBe('c2');
  expect(state.predecessors.at(-1)).toBe('c9');

  const direct = copiesAddress({ cursor: 'c10' }, 'en');
  const directState = admitCopiesWindowRead(createCopiesWindows(direct, 'direct', 1), direct, 'direct', 1, {
    signedIn: true,
    subjectId: null,
    requestedCursor: 'c10',
    copies: [],
    next: null,
    addKey: id(99),
  }).state;
  expect(directState.predecessors).toEqual([]);
});

test('three routed windows retain admitted predecessors, retry the exact target, edit, and return through Commerce address', async () => {
  const routeReads: Search[] = [];
  const listReads: (ReturnType<typeof deferred<CopiesCurrentRead>> & { data: Search })[] = [];
  const detailReads: (ReturnType<typeof deferred<CopyDetailCurrentRead>> & { data: Search & { id: string } })[] = [];
  spyOn(actions, 'readCopiesCurrent').mockImplementation(({ data }) => {
    const call = { ...deferred<CopiesCurrentRead>(), data: data as Search };
    listReads.push(call);
    return call.promise;
  });
  spyOn(actions, 'readCopyDetailCurrent').mockImplementation(({ data }) => {
    const call = { ...deferred<CopyDetailCurrentRead>(), data: data as Search & { id: string } };
    detailReads.push(call);
    return call.promise;
  });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const copiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/copies',
    validateSearch: (search: Record<string, unknown>) => copiesQuery(search),
    loaderDeps: ({ search }) => search,
    loader: ({ deps }) => {
      const search = deps as Search;
      routeReads.push(search);
      return response(search, routeReads.length > 1 && search.cursor === 'c1' ? { copies: [copy(2, 'Fresh return')] } : {});
    },
    shouldReload: ({ cause }) => cause === 'enter',
    component: () => {
      const routeState = useRouterState({
        select: (state) => ({
          search: state.location.search as Search,
          initial: state.matches.find((match) => match.routeId === '/library/copies')?.loaderData as CopiesCurrentRead,
        }),
      });
      return <CopiesCurrent initial={routeState.initial} search={routeState.search} locale="en" />;
    },
  });
  const subjectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/subject',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => {
      const via = useRouterState({ select: (state) => (state.location.search as { via?: string }).via });
      const address = new URL(via ?? '/', window.location.origin);
      const search = Object.fromEntries(['subjectId', 'kind', 'status', 'cursor'].flatMap((key) => {
        const value = address.searchParams.get(key);
        return value === null ? [] : [[key, value]];
      }));
      return (
        <Link to="/library/copies" search={search}>
          Return to inventory
        </Link>
      );
    },
  });
  const router = routerApi.createRouter({
    routeTree: rootRoute.addChildren([copiesRoute, subjectRoute]),
    history: createMemoryHistory({ initialEntries: ['/library/copies'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
  client.setQueryData(['exposure', 'anonymous'], []);
  const exposure = viewerExposureLifetime(client);
  const admitExposure = () => {
    const snapshot = exposure.getSnapshot();
    if (snapshot.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
        subject: snapshot.observation.subject,
        admitted: ['personal_library'],
      });
  };
  admitExposure();
  const release = exposure.subscribe(admitExposure);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const link = (label: string) => {
    const node = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === label);
    expect(node, `Missing link ${label} in ${host.textContent}`).toBeDefined();
    return node!;
  };
  const button = (label: string, region: ParentNode = host) => {
    const node = [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
    expect(node, `Missing button ${label} in ${region.textContent}`).toBeDefined();
    return node!;
  };
  const clickLink = async (label: string) => {
    await act(async () => link(label).click());
    await tick();
  };
  const accept = async (index: number, search: Search, page: Partial<CopiesPageData> = {}) => {
    await act(async () => listReads[index]!.resolve(response(search, page)));
    await tick();
  };

  try {
    await tick();
    expect(routeReads).toEqual([{}]);
    expect(host.textContent).toContain('Copy from window 1');
    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(0, { cursor: 'c1' });
    expect(host.textContent).toContain('Copy from window 2');
    expect(window.document.activeElement?.id).toBe('copies-inventory-heading');

    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c2');
    await act(async () => listReads.at(-1)!.reject(new Error('Target read failed')));
    await tick();
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.error_message());
    await act(async () => button(m.subject_view_retry()).click());
    await tick();
    expect(listReads.at(-1)?.data.cursor).toBe('c2');
    await accept(2, { cursor: 'c2' });
    expect(host.textContent).toContain('Copy from window 3');

    await clickLink(m.library_label_previous_page());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(3, { cursor: 'c1' });
    expect(host.textContent).toContain('Copy from window 2');
    await clickLink(m.library_collections_first_page());
    expect(listReads.at(-1)?.data.cursor).toBeUndefined();
    await accept(4, {});
    expect(host.textContent).toContain('Copy from window 1');
    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(5, { cursor: 'c1' });

    await act(async () => button(m.library_copy_edit()).click());
    await tick();
    expect(detailReads.at(-1)?.data).toMatchObject({ cursor: 'c1', id: id(2) });
    await act(async () =>
      detailReads.at(-1)!.resolve({
        sessionSubject: 'A',
        requested: copiesAddress({ cursor: 'c1' }, 'en'),
        id: id(2),
        result: { ok: true, copy: copy(2, 'Inspected current Copy') },
      }),
    );
    await tick();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Inspected current Copy');
    const editor = host.querySelector('[role="dialog"]')!;
    await act(async () => button(m.library_copy_more(), editor).click());
    const note = [...editor.querySelectorAll<HTMLTextAreaElement>('textarea')].find((field) => field.value);
    expect(note).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Unsaved change');
      note!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await clickLink(m.library_copy_more());
    const departure = host.querySelector('[role="alertdialog"]')!;
    expect(host.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(departure.textContent).toContain(m.library_copy_draft_navigation_description());
    expect(router.state.location.search).toMatchObject({ cursor: 'c1' });
    expect(listReads).toHaveLength(6);
    await act(async () => button(m.library_copy_draft_navigation_stay(), departure).click());
    await tick();
    expect(router.state.location.search).toMatchObject({ cursor: 'c1' });
    await act(async () => button(m.library_copy_cancel(), host.querySelector('[role="dialog"]')!).click());
    const discard = host.querySelector('[role="alertdialog"]')!;
    expect(discard.textContent).toContain(m.library_copy_draft_navigation_description());
    await act(async () => button(m.library_copy_draft_navigation_discard(), discard).click());
    await tick();
    expect(window.document.activeElement?.getAttribute('aria-label')).toBe(m.library_copy_more_actions());
    expect(router.state.location.search).toMatchObject({ cursor: 'c1' });

    const title = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((node) => node.href.includes('/subjects/'))!;
    const via = new URL(title.href).searchParams.get('via');
    expect(via).toBe(copyInventoryReturnHref({ subjectId: null, cursor: 'c1' }, 'en'));
    await act(async () => router.navigate({ to: '/subject', search: { via } }));
    await tick();
    await clickLink('Return to inventory');
    expect(routeReads.at(-1)).toMatchObject({ cursor: 'c1' });
    expect(host.textContent).toContain('Fresh return');
    expect([...host.querySelectorAll('a')].some((node) => node.textContent === m.library_label_previous_page())).toBe(
      false,
    );
    expect(listReads).toHaveLength(6);
    expect(CopiesRoute.options.shouldReload?.({ cause: 'stay' } as never)).toBe(false);
  } finally {
    release();
    await act(async () => root.unmount());
    router.history.destroy();
    client.clear();
    host.remove();
  }
});
