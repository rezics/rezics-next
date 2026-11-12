import { afterAll, expect, mock, test } from 'bun:test';
import { act, StrictMode, useState } from 'react';
import * as start from '../.storybook/react-start';
import { installPostReadingDom } from './post-reading-dom';
import type {
  KnowledgeNavigationAddress,
  KnowledgeNavigationRequest,
  KnowledgeNavigationResult,
} from '../src/knowledge/navigation-read';
import type { KnowledgeNavigationOperations, KnowledgeNavigationAccess } from '../src/knowledge/navigation-page';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } =
  await import('@tanstack/react-router');
const { KnowledgeNavigationEntry } = await import('../src/knowledge/navigation-page');
const { KnowledgeNavigationReturnLink, knowledgeNavigationReturn } =
  await import('../src/knowledge/navigation-return-link');
const { setLocale } = await import('../src/paraglide/runtime.js');

afterAll(async () => {
  await dom.restore();
  mock.restore();
});
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const notebookId = id(10),
  placementId = id(20),
  documentId = id(21),
  structureRevisionId = id(30);
const rootAddress = { kind: 'outline', notebookId, parentPlacementId: null } as const;
const placement = { placementId, documentId, parentPlacementId: null, position: '2', title: 'Private supplied note' };
const outline = (request: KnowledgeNavigationRequest, overrides = {}): KnowledgeNavigationResult => ({
  state: 'ready',
  page: {
    kind: 'outline',
    notebookId,
    parentPlacementId: request.kind === 'outline' ? request.parentPlacementId : null,
    structureRevisionId,
    placements: [placement],
    next: null,
    ...overrides,
  },
});
type Entry = {
  address: KnowledgeNavigationAddress;
  locale: string;
  binding: string;
  access: KnowledgeNavigationAccess;
  operations: KnowledgeNavigationOperations;
};

async function mount(read: KnowledgeNavigationOperations['read'], address: KnowledgeNavigationAddress = rootAddress) {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const returning = knowledgeNavigationReturn(client);
  let current: Entry = {
    address,
    locale: 'en',
    binding: 'signed-in-session-csrf-exposure',
    access: 'available',
    operations: { read },
  };
  let update!: (next: Entry) => void;
  function Visit() {
    const [entry, set] = useState(current);
    update = set;
    return <KnowledgeNavigationEntry {...entry} returning={returning} />;
  }
  const parent = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => parent, path: '/knowledge', component: Visit });
  const notebookRoute = createRoute({
    getParentRoute: () => parent,
    path: '/knowledge/notebooks/$notebookId',
    component: Visit,
  });
  const editor = createRoute({
    getParentRoute: () => parent,
    path: '/knowledge/notebooks/$notebookId/documents/$documentId',
    component: () => (
      <>
        <KnowledgeNavigationReturnLink address={{ notebookId, documentId }} binding={current.binding} locale="en" />
        <h1>Exact existing editor route</h1>
      </>
    ),
  });
  const router = createRouter({
    routeTree: parent.addChildren([route, notebookRoute, editor]),
    history: createMemoryHistory({ initialEntries: [`/knowledge/notebooks/${notebookId}`] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const react = createRoot(host);
  await act(async () => {
    react.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  const click = async (label: string) => {
    const target = [...host.querySelectorAll<HTMLElement>('button,a')].find(
      (node) => node.textContent?.trim() === label || node.textContent?.trim().startsWith(label + ':'),
    );
    if (!target) throw new Error(`Missing navigation control: ${label}`);
    await act(async () => {
      target.click();
    });
  };
  return {
    host,
    client,
    returning,
    router,
    click,
    async show(changes: Partial<Entry>) {
      current = { ...current, ...changes };
      setLocale(current.locale as never, { reload: false });
      await act(async () => update(current));
    },
    async flush() {
      await act(async () => {
        await Promise.resolve();
      });
    },
    async dispose() {
      await act(async () => react.unmount());
      client.clear();
      host.remove();
    },
  };
}

test('mounted root/children/sparse/More/Retry replace one page and keep exact native operands', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  const view = await mount(async (request) => {
    calls.push({ ...request });
    if (calls.length === 1) return outline(request);
    if (calls.length === 2) return outline(request, { placements: [], next: 'sparse-frontier' });
    if (calls.length === 3) return { state: 'unavailable' };
    return outline(request, {
      placements: [{ ...placement, placementId: id(22), parentPlacementId: placementId, title: 'Next private child' }],
    });
  });
  try {
    expect(calls).toEqual([rootAddress]);
    expect(view.host.textContent).toContain('Private supplied note');
    const document = view.host.querySelector('a[href*="/documents/"]');
    expect(document?.getAttribute('href')).toBe(`/knowledge/notebooks/${notebookId}/documents/${documentId}`);
    await view.click('Explore children');
    expect(view.host.textContent).toContain('No available rows on this page');
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
    await view.click('More');
    expect(view.host.textContent).toContain('unavailable right now');
    await view.click('Retry this page');
    expect(calls).toEqual([
      rootAddress,
      { ...rootAddress, parentPlacementId: placementId },
      { ...rootAddress, parentPlacementId: placementId, cursor: 'sparse-frontier' },
      { ...rootAddress, parentPlacementId: placementId, cursor: 'sparse-frontier' },
    ]);
    expect(view.host.textContent).toContain('Next private child');
    expect(document?.isConnected).toBe(false);
    expect(view.host.querySelectorAll('li')).toHaveLength(1);
  } finally {
    await view.dispose();
  }
});

test('mounted replacement retires late results for session, CSRF, exposure, locale, source and address', async () => {
  const pending: Array<(result: KnowledgeNavigationResult) => void> = [];
  const calls: KnowledgeNavigationRequest[] = [];
  const read = (request: KnowledgeNavigationRequest) => {
    calls.push(request);
    return new Promise<KnowledgeNavigationResult>((resolve) => pending.push(resolve));
  };
  const view = await mount(read);
  try {
    for (const changes of [
      { binding: 'replacement-viewer' },
      { binding: 'replacement-csrf' },
      { binding: 'replacement-exposure' },
      { locale: 'de' },
      { operations: { read } },
      { address: { kind: 'outline' as const, notebookId: id(11), parentPlacementId: null } },
    ]) {
      const stale = pending.at(-1)!;
      const before = calls.length;
      await view.show(changes);
      expect(calls.length).toBe(before + 1);
      await act(async () => {
        stale(outline(rootAddress));
      });
      expect(view.host.textContent).not.toContain('Private supplied note');
    }
    await view.show({ access: 'denied' });
    await act(async () => {
      pending.at(-1)!(outline(rootAddress));
    });
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
  } finally {
    await view.dispose();
  }
});

test('editor return re-admits the same child frontier before rows, then exposes explicit structure restart', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  let readmit!: (result: KnowledgeNavigationResult) => void;
  const view = await mount(async (request) => {
    calls.push({ ...request });
    if (calls.length === 1) return outline(request);
    if (calls.length === 2)
      return outline(request, {
        placements: [{ ...placement, parentPlacementId: placementId, title: 'Child page' }],
        next: 'next-child',
      });
    if (calls.length === 3)
      return new Promise<KnowledgeNavigationResult>((resolve) => {
        readmit = resolve;
      });
    return outline(request, { structureRevisionId: id(31), placements: [] });
  });
  try {
    await view.click('Explore children');
    await view.click('Open document');
    expect(view.host.textContent).toContain('Exact existing editor route');
    expect(view.host.textContent).not.toContain('Child page');
    await view.click('Return to notebook reading');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(view.host.textContent).not.toContain('Child page');
    await act(async () => {
      readmit(outline(calls[2]!, { structureRevisionId: id(31) }));
    });
    expect(view.host.textContent).toContain('This reading changed');
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
    await view.click('Restart this parent');
    expect(calls[3]).toEqual({ ...rootAddress, parentPlacementId: placementId });
    expect(view.host.textContent).toContain('No documents are available at this level');
    expect(view.host.textContent).not.toContain('Child page');
  } finally {
    await view.dispose();
  }
});

test('inventory reloads once and changed/expired returns require explicit restart without an automatic read', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  const read: KnowledgeNavigationOperations['read'] = async (request) => {
    calls.push(request);
    return { state: 'ready', page: { kind: 'owned', notebooks: [], next: 'sparse-owned' } };
  };
  const view = await mount(read, { kind: 'owned' });
  try {
    expect(calls).toEqual([{ kind: 'owned' }]);
    await view.show({ binding: 'reload-owned' });
    expect(calls).toHaveLength(2);
    expect(view.host.textContent).toContain('More continues this reading');
    view.returning.returnTo('reload-owned', { notebookId, documentId });
    await view.show({ address: rootAddress });
    expect(calls).toHaveLength(2);
    expect(view.host.textContent).toContain('return expired');
    await view.click('Restart this parent');
    expect(calls[2]).toEqual(rootAddress);
  } finally {
    await view.dispose();
  }
});
