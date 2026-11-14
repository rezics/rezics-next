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
const { KnowledgeOutlineReading } = await import('../src/knowledge/navigation-reading');
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

for (const organization of [false, true]) {
  test(`two independent branches preserve native order, repeated documents, sparse More and exact Retry (${organization})`, async () => {
    const calls: KnowledgeNavigationRequest[] = [];
    let attempts = 0;
    const sibling = { ...placement, placementId: id(23), title: 'Second branch', position: '1' };
    const view = await mount(
      async (request) => {
        calls.push({ ...request });
        if (request.kind !== 'outline' || request.parentPlacementId === null)
          return outline(request, { placements: [placement, sibling] });
        if (request.parentPlacementId === sibling.placementId)
          return outline(request, {
            placements: [
              {
                ...placement,
                placementId: id(24),
                parentPlacementId: sibling.placementId,
                title: 'Second branch child',
              },
            ],
          });
        if (!request.cursor) return outline(request, { placements: [], next: 'sparse-frontier' });
        if (attempts++ === 0) return { state: 'unavailable' };
        return outline(request, {
          placements: [
            { ...placement, placementId: id(22), parentPlacementId: placementId, title: 'Next private child' },
          ],
        });
      },
      rootAddress,
      { organization },
    );
    try {
      expect(calls).toEqual([rootAddress]);
      const document = view.host.querySelector('a[href*="/documents/"]');
      expect(document?.getAttribute('href')).toBe(`/knowledge/notebooks/${notebookId}/documents/${documentId}`);
      expect(
        [...view.host.querySelectorAll('[data-knowledge-placement]')].map((row) =>
          row.getAttribute('data-knowledge-placement'),
        ),
      ).toEqual([placementId, sibling.placementId]);
      await view.click('Explore children: Private supplied note');
      await view.click('Explore children: Second branch');
      expect(view.host.textContent).toContain('No available rows on this page');
      expect(view.host.textContent).toContain('Second branch child');
      await view.click('More');
      expect(view.host.textContent).toContain('unavailable right now');
      expect(view.host.textContent).toContain('Second branch child');
      await view.click('Retry this page');
      expect(calls).toEqual([
        rootAddress,
        { ...rootAddress, parentPlacementId: placementId },
        { ...rootAddress, parentPlacementId: sibling.placementId },
        { ...rootAddress, parentPlacementId: placementId, cursor: 'sparse-frontier' },
        { ...rootAddress, parentPlacementId: placementId, cursor: 'sparse-frontier' },
      ]);
      expect(document?.isConnected).toBe(true);
      expect(view.host.querySelectorAll('a[href*="/documents/"]')).toHaveLength(4);
      await view.click('Collapse children: Private supplied note');
      expect(view.host.textContent).not.toContain('Next private child');
      expect(view.host.textContent).toContain('Second branch child');
      await view.click('Explore children: Private supplied note');
      expect(view.host.textContent).toContain('Next private child');
      expect(calls).toHaveLength(5);
    } finally {
      await view.dispose();
    }
  });
}

test('branch requests complete independently and collapsed pending pages cannot move focus', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  const pending = new Map<string, (result: KnowledgeNavigationResult) => void>();
  const sibling = { ...placement, placementId: id(23), title: 'Second branch' };
  const view = await mount(async (request) => {
    calls.push(request);
    if (request.kind !== 'outline' || request.parentPlacementId === null)
      return outline(request, { placements: [placement, sibling] });
    return new Promise((resolve) => pending.set(request.parentPlacementId!, resolve));
  });
  try {
    await view.key('Explore children: Private supplied note');
    await view.key('Explore children: Second branch');
    await view.key('Collapse children: Private supplied note');
    view.elsewhere.focus();
    await act(async () => {
      pending.get(sibling.placementId)!(
        outline(calls[2]!, {
          placements: [
            {
              ...sibling,
              placementId: id(25),
              parentPlacementId: sibling.placementId,
              title: 'Second completed first',
            },
          ],
        }),
      );
      pending.get(placementId)!(
        outline(calls[1]!, {
          placements: [
            { ...placement, placementId: id(26), parentPlacementId: placementId, title: 'Hidden completion' },
          ],
        }),
      );
    });
    expect(view.host.textContent).toContain('Second completed first');
    expect(view.host.textContent).not.toContain('Hidden completion');
    expect(document.activeElement).toBe(view.elsewhere);
    await view.click('Explore children: Private supplied note');
    expect(view.host.textContent).toContain('Hidden completion');
    expect(calls).toHaveLength(3);
  } finally {
    await view.dispose();
  }
});

test('mounted replacement retires all revealed branches and late results for session, CSRF, exposure, locale, source and address', async () => {
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
      await act(async () => stale(outline(rootAddress)));
      expect(view.host.textContent).not.toContain('Private supplied note');
      await act(async () => pending.at(-1)!(outline(rootAddress, { next: 'retired-frontier' })));
      expect(document.activeElement).not.toBe(view.boundary());
    }
    await view.key(view.host.querySelector<HTMLElement>('section > button')!);
    await view.show({ access: 'denied' });
    await act(async () => pending.at(-1)!(outline(rootAddress)));
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
    expect(document.activeElement).not.toBe(view.boundary());
  } finally {
    await view.dispose();
  }
});

for (const organization of [false, true]) {
  test(`return re-admits the row's supplying page after branch More and retains exact selection (${organization})`, async () => {
    const calls: KnowledgeNavigationRequest[] = [];
    let readmit!: (result: KnowledgeNavigationResult) => void;
    const child = { ...placement, placementId: id(40), parentPlacementId: placementId, title: 'First child page' };
    const view = await mount(
      async (request) => {
        calls.push({ ...request });
        if (calls.length === 1) return outline(request);
        if (calls.length === 2) return outline(request, { placements: [child], next: 'next-child' });
        if (calls.length === 3)
          return outline(request, { placements: [{ ...child, placementId: id(41), title: 'Later child page' }] });
        return new Promise((resolve) => {
          readmit = resolve;
        });
      },
      rootAddress,
      { organization },
    );
    try {
      await view.click('Explore children');
      await view.click('More');
      await view.click('Open document: First child page');
      expect(view.host.textContent).toContain('Exact existing editor route');
      expect(view.host.textContent).not.toContain('First child page');
      await view.key('Return to notebook reading');
      expect(calls).toHaveLength(4);
      expect(calls[3]).toEqual(calls[1]);
      expect(view.host.querySelectorAll('li')).toHaveLength(0);
      await act(async () => readmit(outline(calls[3]!, { placements: [child] })));
      expect(document.activeElement).toBe(view.host.querySelector('a[aria-current="page"]'));
      expect(view.host.textContent).toContain('First child page');
      expect(view.host.textContent).not.toContain('Later child page');
      await view.key('Notebook root');
      expect(calls[4]).toEqual(rootAddress);
      await act(async () => readmit(outline(rootAddress)));
      expect(document.activeElement).toBe(view.boundary());
      expect(view.host.textContent).toContain('Private supplied note');
    } finally {
      await view.dispose();
    }
  });
}

test('native structure replacement conceals the whole outline until explicit restart', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  const view = await mount(async (request) => {
    calls.push(request);
    return calls.length === 2 ? outline(request, { structureRevisionId: id(31) }) : outline(request);
  });
  try {
    await view.click('Explore children');
    expect(view.host.textContent).toContain('This reading changed');
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
    expect(calls).toHaveLength(2);
    await view.click('Restart this parent');
    expect(calls[2]).toEqual(rootAddress);
    expect(view.host.textContent).toContain('Private supplied note');
  } finally {
    await view.dispose();
  }
});

test('inventory stays replacing and expired returns require explicit restart without an automatic read', async () => {
  const calls: KnowledgeNavigationRequest[] = [];
  const view = await mount(
    async (request) => {
      calls.push(request);
      if (request.kind === 'outline') return outline(request);
      return {
        state: 'ready',
        page: {
          kind: 'owned',
          notebooks: [
            {
              notebookId,
              subjectId: id(50),
              structureRevisionId,
              createdAt: '2026-11-01T00:00:00Z',
              title: request.cursor ? 'Second notebook page' : 'First notebook page',
            },
          ],
          next: request.cursor ? null : 'next-owned',
        },
      };
    },
    { kind: 'owned' },
  );
  try {
    expect(calls).toEqual([{ kind: 'owned' }]);
    await view.click('More');
    expect(view.host.textContent).toContain('Second notebook page');
    expect(view.host.textContent).not.toContain('First notebook page');
    await view.show({ binding: 'reload-owned' });
    expect(calls).toHaveLength(3);
    view.returning.returnTo('reload-owned', { notebookId, documentId });
    await view.show({ address: rootAddress });
    expect(calls).toHaveLength(3);
    expect(view.host.textContent).toContain('return expired');
    await view.click('Restart this parent');
    expect(calls[3]).toEqual(rootAddress);
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
  test(`branch continuation and retry keep deliberate keyboard orientation ${JSON.stringify(configuration)}`, async () => {
    const calls: KnowledgeNavigationRequest[] = [];
    let resolve!: (result: KnowledgeNavigationResult) => void;
    const view = await mount(
      (request) => {
        calls.push(request);
        return new Promise((done) => {
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
      expect(view.host.textContent).toContain('Private supplied note');
      await view.key('More');
      await complete({ state: 'unavailable' });
      expect(document.activeElement === view.boundary()).toBe(!configuration.embedded);
      await view.key('Retry this page');
      expect(calls.at(-1)).toEqual(calls.at(-2));
      expect(calls.at(-1)?.cursor).toBe('sparse-frontier');
      await complete(outline(calls.at(-1)!, { placements: [], next: 'continuing-root' }));
      expect(document.activeElement === view.boundary()).toBe(!configuration.embedded);
      for (const cancel of [
        () => view.elsewhere.focus(),
        () => view.elsewhere.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })),
        () => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true })),
        () => window.dispatchEvent(new dom.window.Event('blur')),
        () => view.show({ selectedDocumentId: id(90) }),
      ]) {
        await view.key('More');
        await cancel();
        await complete(outline(calls.at(-1)!, { placements: [], next: 'continuing-root' }));
        expect(document.activeElement).not.toBe(view.boundary());
      }
      expect(calls).toHaveLength(9);
    } finally {
      await view.dispose();
    }
  });
}

for (const organization of [false, true]) {
  test(`document return admission and focus remain cancellable (${organization})`, async () => {
    for (const outcome of ['keyboard', 'pointer', 'moved', 'missing', 'unavailable'] as const) {
      const calls: KnowledgeNavigationRequest[] = [];
      let resolve!: (result: KnowledgeNavigationResult) => void;
      const view = await mount(
        async (request) => {
          calls.push(request);
          if (calls.length === 1) return outline(request, { next: 'selected-page' });
          if (calls.length === 2)
            return outline(request, {
              placements: [{ ...placement, placementId: id(60), title: 'Selected continued placement' }],
            });
          return new Promise((done) => {
            resolve = done;
          });
        },
        rootAddress,
        { organization },
      );
      try {
        await view.click('More');
        await view.click('Open document: Selected continued placement');
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
              : outline(calls[2]!, {
                  placements:
                    outcome === 'missing'
                      ? []
                      : [placement, { ...placement, placementId: id(60), title: 'Selected continued placement' }],
                }),
          ),
        );
        const selected = view.host.querySelector<HTMLAnchorElement>(
          `[data-knowledge-placement="${id(60)}"] a[aria-current="page"]`,
        );
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

test('retiring a returned branch discards its private breadcrumb labels and cursor', async () => {
  const reading = new KnowledgeOutlineReading(async () => ({ state: 'denied' }), {
    request: { ...rootAddress, parentPlacementId: placementId, cursor: 'private-return-cursor' },
    breadcrumbs: [{ placementId, title: 'Private ancestor label' }],
    structureRevisionId,
  });
  await reading.open();
  const closed = reading.getSnapshot();
  expect(closed.root).toBeNull();
  expect([...closed.branches.values()].map((branch) => branch.frontier)).toEqual([
    { request: rootAddress, breadcrumbs: [] },
  ]);
  expect([...closed.branches.values()].flatMap((branch) => branch.rows)).toEqual([]);
  reading.retire();
  expect(reading.getSnapshot().branches.get(null)?.state).toBe('retired');
});
