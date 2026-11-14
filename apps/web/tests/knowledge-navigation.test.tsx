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
import type { OrganizationReadResult, OrganizationRequest } from '../src/knowledge/organization-read';

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
  embedded?: boolean;
  selectedDocumentId?: string;
};

async function mount(
  read: KnowledgeNavigationOperations['read'],
  address: KnowledgeNavigationAddress = rootAddress,
  {
    organization = false,
    embedded = false,
  }: { organization?: boolean | undefined; embedded?: boolean | undefined } = {},
) {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const returning = knowledgeNavigationReturn(client);
  let current: Entry = {
    address,
    locale: 'en',
    binding: 'signed-in-session-csrf-exposure',
    access: 'available',
    embedded,
    operations: {
      read,
      ...(organization
        ? {
            organization: {
              read: (request: OrganizationRequest) =>
                read(request as KnowledgeNavigationRequest) as Promise<OrganizationReadResult>,
              prepare: async () => {
                throw new Error('Navigation does not prepare a write');
              },
              move: async () => {
                throw new Error('Navigation does not move a placement');
              },
            },
          }
        : {}),
    },
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
  const elsewhere = document.createElement('button');
  elsewhere.textContent = 'Continue another reading';
  document.body.append(host, elsewhere);
  elsewhere.focus();
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
  const click = async (label: string | HTMLElement, keyboard = false) => {
    const target =
      typeof label === 'string'
        ? [...host.querySelectorAll<HTMLElement>('button,a')].find(
            (node) => node.textContent?.trim() === label || node.textContent?.trim().startsWith(label + ':'),
          )
        : label;
    if (!target) throw new Error(`Missing navigation control: ${label}`);
    await act(async () => {
      if (keyboard) {
        target.focus();
        target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        target.click();
      } else {
        target.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
        target.focus();
        target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      }
    });
  };
  return {
    host,
    elsewhere,
    key: (label: string | HTMLElement) => click(label, true),
    boundary: () => host.querySelector<HTMLElement>('section[aria-busy]')!,
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
      elsewhere.remove();
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
    await act(async () => pending.at(-1)!(outline(rootAddress, { next: 'retired-frontier' })));
    for (const changes of [
      { binding: 'replacement-viewer' },
      { binding: 'replacement-csrf' },
      { binding: 'replacement-exposure' },
      { locale: 'de' },
      { operations: { read } },
      { address: { kind: 'outline' as const, notebookId: id(11), parentPlacementId: null } },
    ]) {
      await view.key(view.host.querySelector<HTMLElement>('section > button')!);
      const stale = pending.at(-1)!;
      const before = calls.length;
      await view.show(changes);
      expect(calls.length).toBe(before + 1);
      await act(async () => {
        stale(outline(rootAddress));
      });
      expect(view.host.textContent).not.toContain('Private supplied note');
      await act(async () => pending.at(-1)!(outline(rootAddress, { next: 'retired-frontier' })));
      expect(document.activeElement).not.toBe(view.boundary());
    }
    await view.key(view.host.querySelector<HTMLElement>('section > button')!);
    await view.show({ access: 'denied' });
    await act(async () => {
      pending.at(-1)!(outline(rootAddress));
    });
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
    expect(document.activeElement).not.toBe(view.boundary());
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
    await view.key('Return to notebook reading');
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(view.host.textContent).not.toContain('Child page');
    await act(async () => {
      readmit(outline(calls[2]!, { structureRevisionId: id(31) }));
    });
    expect(view.host.textContent).toContain('This reading changed');
    expect(document.activeElement).toBe(view.boundary());
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

for (const configuration of [
  { organization: false },
  { organization: true },
  { embedded: true },
  { organization: true, embedded: true },
]) {
  test(`navigation orientation follows explicit keyboard completion and failure ${JSON.stringify(configuration)}`, async () => {
    const calls: KnowledgeNavigationRequest[] = [];
    let resolve!: (result: KnowledgeNavigationResult) => void;
    const view = await mount(
      (request) => {
        calls.push(request);
        return new Promise<KnowledgeNavigationResult>((done) => {
          resolve = done;
        });
      },
      rootAddress,
      configuration,
    );
    const complete = async (result: KnowledgeNavigationResult) => act(async () => resolve(result));
    try {
      expect(document.activeElement).toBe(view.elsewhere);
      await complete(outline(rootAddress, { next: 'first-frontier' }));
      expect(document.activeElement).toBe(view.elsewhere);
      await view.click('More');
      await complete(outline(calls.at(-1)!, { placements: [], next: 'sparse-frontier' }));
      expect(document.activeElement).not.toBe(view.boundary());
      await view.key('More');
      await complete({ state: 'unavailable' });
      expect(document.activeElement === view.boundary()).toBe(!configuration.embedded);
      await view.key('Retry this page');
      expect(calls.at(-1)).toEqual(calls.at(-2));
      expect(calls.at(-1)?.cursor).toBe('sparse-frontier');
      await complete(outline(calls.at(-1)!));
      expect(document.activeElement === view.boundary()).toBe(!configuration.embedded);
      await view.key('Explore children');
      view.elsewhere.focus();
      await complete(outline(calls.at(-1)!, { next: 'continuing-child' }));
      await view.show({});
      expect(document.activeElement).toBe(view.elsewhere);
      for (const cancel of [
        () => view.elsewhere.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })),
        () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
        () => window.dispatchEvent(new dom.window.Event('blur')),
        () => view.show({ selectedDocumentId: id(90) }),
      ]) {
        await view.key('More');
        await cancel();
        await complete(outline(calls.at(-1)!, { next: 'continuing-child' }));
        expect(document.activeElement).not.toBe(view.boundary());
      }
      expect(calls).toHaveLength(9);
    } finally {
      await view.dispose();
    }
  });
}

for (const organization of [false, true]) {
  test(`document return re-admits the saved page and selection with cancellable orientation (${organization})`, async () => {
    for (const outcome of ['keyboard', 'pointer', 'moved', 'missing', 'unavailable'] as const) {
      const calls: KnowledgeNavigationRequest[] = [];
      let resolve!: (result: KnowledgeNavigationResult) => void;
      const view = await mount(
        async (request) => {
          calls.push(request);
          if (calls.length === 1) return outline(request, { next: 'selected-page' });
          if (calls.length === 2) return outline(request);
          return new Promise<KnowledgeNavigationResult>((done) => {
            resolve = done;
          });
        },
        rootAddress,
        { organization },
      );
      try {
        await view.click('More');
        await view.click('Open document');
        if (outcome === 'pointer') await view.click('Return to notebook reading');
        else await view.key('Return to notebook reading');
        expect(calls).toHaveLength(3);
        expect(calls[2]).toEqual(calls[1]);
        expect(view.host.querySelectorAll('li')).toHaveLength(0);
        if (outcome === 'moved') view.elsewhere.focus();
        await act(async () =>
          resolve(
            outcome === 'unavailable'
              ? { state: 'unavailable' }
              : outline(calls[2]!, { placements: outcome === 'missing' ? [] : [placement] }),
          ),
        );
        const selected = view.host.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
        expect(Boolean(selected)).toBe(outcome !== 'missing' && outcome !== 'unavailable');
        if (outcome === 'keyboard') expect(document.activeElement).toBe(selected);
        else if (outcome === 'missing' || outcome === 'unavailable')
          expect(document.activeElement).toBe(view.boundary());
        else expect(document.activeElement).not.toBe(view.boundary());
        if (outcome === 'moved') expect(document.activeElement).toBe(view.elsewhere);
        if (outcome === 'pointer') expect(document.activeElement).not.toBe(selected);
      } finally {
        await view.dispose();
      }
    }
  });
}
