import { afterAll, expect, mock, test } from 'bun:test';
import { act, StrictMode, useState } from 'react';
import * as start from '../.storybook/react-start';
import { installPostReadingDom } from './post-reading-dom';
import type { KnowledgeNavigationOperations } from '../src/knowledge/navigation-page';
import type {
  OrganizationIntent,
  OrganizationOperations,
  OrganizationReadResult,
  OrganizationRequest,
} from '../src/knowledge/organization-read';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const dom = installPostReadingDom();
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { KnowledgeNavigationEntry } = await import('../src/knowledge/navigation-page');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { default: userEvent } = await import('@testing-library/user-event');
afterAll(async () => {
  await dom.restore();
  mock.restore();
});
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const notebookId = id(1),
  placementId = id(2),
  documentId = id(3),
  structureRevisionId = id(4),
  parentId = id(6),
  siblingId = id(7);
const binding = { viewer: id(99), csrfToken: 'original-csrf', credential: 'original-captured-token' };
const root = { kind: 'outline', notebookId, parentPlacementId: null } as const;
const page = (request: OrganizationRequest, overrides = {}): OrganizationReadResult => ({
  state: 'ready',
  page: {
    kind: request.kind === 'historical' ? 'historical' : 'outline',
    notebookId,
    structureRevisionId: request.kind === 'historical' ? request.revisionId : structureRevisionId,
    parentPlacementId: request.kind === 'history' ? null : request.parentPlacementId,
    placements:
      request.kind !== 'history' && request.parentPlacementId
        ? [
            {
              placementId: siblingId,
              documentId: id(8),
              parentPlacementId: request.parentPlacementId,
              title: 'Child sibling',
              position: '90',
            },
          ]
        : [
            { placementId, documentId, parentPlacementId: null, title: 'Stable source document', position: '9' },
            {
              placementId: parentId,
              documentId: id(8),
              parentPlacementId: null,
              title: 'Destination chapter',
              position: '2',
            },
          ],
    next: null,
    ...overrides,
  },
});
const revision = (available = true) => ({
  structureRevisionId: id(40),
  revisionNumber: '4',
  historyAvailable: available,
  changeKind: 'placement_moved' as const,
  createdAt: '2026-11-11T12:00:00Z',
  changes: [],
});

type Props = {
  binding: string;
  locale: string;
  access: 'available' | 'signed-out';
  address: typeof root;
  operations: KnowledgeNavigationOperations;
};
async function mount(organization: OrganizationOperations) {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let retire!: () => void;
  let props: Props = {
    binding: 'original-session-csrf-exposure',
    locale: 'en',
    access: 'available',
    address: root,
    operations: {
      read: async () => {
        throw new Error('Organization must use its admitted reader');
      },
      organization,
      subscribeRetirement: (callback) => {
        retire = callback;
        return () => {};
      },
    },
  };
  let update!: (props: Props) => void;
  function Entry() {
    const [state, set] = useState(props);
    update = set;
    return <KnowledgeNavigationEntry {...state} />;
  }
  const route = createRootRoute({ component: Entry });
  const child = createRoute({ getParentRoute: () => route, path: '/knowledge' });
  const router = createRouter({
    routeTree: route.addChildren([child]),
    history: createMemoryHistory({ initialEntries: ['/knowledge'] }),
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
  const find = (label: string) => {
    const node = [...host.querySelectorAll<HTMLElement>('button,a')].find(
      (n) => n.textContent?.trim() === label || n.textContent?.trim().startsWith(label + ':'),
    );
    if (!node) throw new Error(`Missing organization control: ${label}`);
    return node;
  };
  return {
    host,
    find,
    retire: () => retire(),
    click: async (label: string) => {
      await act(async () => {
        find(label).click();
      });
    },
    show: async (next: Partial<Props>) => {
      props = { ...props, ...next };
      await act(async () => {
        update(props);
      });
    },
    dispose: async () => {
      await act(async () => {
        react.unmount();
      });
      client.clear();
      host.remove();
    },
  };
}
function operations() {
  const requests: OrganizationRequest[] = [],
    intents: OrganizationIntent[] = [];
  const ops: OrganizationOperations = {
    read: async (request) => {
      requests.push(structuredClone(request));
      return page(request);
    },
    prepare: async () => ({ state: 'ready', binding }),
    move: async (intent) => {
      intents.push(intent);
      return { state: 'acknowledged', receipt: { notebookId, placementId, structureRevisionId: id(5) } };
    },
  };
  return { ops, requests, intents };
}

for (const destination of ['nested', 'same-parent', 'root'] as const)
  test(`mounted ${destination} move reviews observed operands, then reopens the same document with a fresh reading`, async () => {
    const f = operations();
    const view = await mount(f.ops);
    try {
      if (destination === 'root') {
        await view.click('Explore children: Destination chapter');
        await view.click('Move document: Child sibling');
        await view.click('Notebook root');
      } else {
        await view.click('Move document: Stable source document');
        if (destination === 'nested') await view.click('Explore children: Destination chapter');
      }
      await view.click(
        destination === 'same-parent' ? 'Place before this document: Destination chapter' : 'Place at end',
      );
      expect(view.host.textContent).toContain('Review move');
      expect(f.intents).toHaveLength(0);
      const confirm = view.find('Confirm move');
      confirm.focus();
      const user = userEvent.setup({ document: window.document });
      await act(async () => {
        await user.keyboard('{Enter}');
      });
      expect(f.intents).toHaveLength(1);
      expect(f.intents[0]).toMatchObject({
        placementId: destination === 'root' ? siblingId : placementId,
        expectedStructureRevisionId: structureRevisionId,
        destinationParentPlacementId: destination === 'nested' ? parentId : null,
        beforePlacementId: destination === 'same-parent' ? parentId : null,
        binding,
      });
      expect(view.host.textContent).toContain('Move acknowledged');
      expect(view.host.querySelectorAll('li')).toHaveLength(0);
      const before = f.requests.length;
      await view.click('Read current root');
      expect(f.requests).toHaveLength(before + 1);
      expect(view.host.textContent).toContain(id(5));
      const editor = view.host.querySelector<HTMLAnchorElement>(
        `a[href="/knowledge/notebooks/${notebookId}/documents/${documentId}"]`,
      );
      expect(editor?.textContent).toContain('Stable source document');
    } finally {
      await view.dispose();
    }
  });

test('mounted conflict preserves review and uncertain retry repeats the sealed command without reading or changing operands', async () => {
  const f = operations();
  let attempt = 0;
  const intents: OrganizationIntent[] = [];
  const view = await mount({
    ...f.ops,
    move: async (intent) => {
      intents.push(intent);
      return { state: attempt++ === 0 ? 'conflict' : 'uncertain' };
    },
  });
  try {
    await view.click('Move document');
    await view.click('Place at end');
    await view.click('Confirm move');
    expect(view.host.textContent).toContain('Your previous choice is kept');
    expect(view.host.textContent).toContain('Stable source document');
    await view.click('Review fresh source and destination');
    expect(f.requests).toHaveLength(2);
    expect(intents).toHaveLength(1);
    await view.click('Move document');
    await view.click('Place before this document: Destination chapter');
    await view.click('Confirm move');
    expect(view.host.textContent).toContain('The result is uncertain');
    const count = f.requests.length;
    await view.click('Retry same move');
    expect(intents[1]).toBe(intents[2]!);
    expect(intents[1]!.idempotencyKey).not.toBe(intents[0]!.idempotencyKey);
    expect(f.requests).toHaveLength(count);
    expect(view.host.querySelectorAll('li')).toHaveLength(0);
  } finally {
    await view.dispose();
  }
});

test('mounted history separates unavailable history and historical placements from a fresh current source selection', async () => {
  const f = operations();
  const requests: OrganizationRequest[] = [];
  const view = await mount({
    ...f.ops,
    read: async (request) => {
      requests.push(request);
      if (request.kind === 'history')
        return {
          state: 'ready',
          page: {
            kind: 'history',
            notebookId,
            revisions: [revision(), { ...revision(false), structureRevisionId: id(41), revisionNumber: '3' }],
            next: null,
          },
        };
      return page(request);
    },
  });
  try {
    await view.click('Move document');
    await view.click('Structure history');
    expect(view.host.textContent).toContain('History is unavailable for this revision');
    expect(view.host.textContent).not.toContain('Selected document');
    await view.click('Historical outline: 4');
    expect(requests.at(-1)).toMatchObject({ kind: 'historical', revisionId: id(40), parentPlacementId: null });
    expect([...view.host.querySelectorAll('button')].some((b) => b.textContent?.startsWith('Move document'))).toBe(
      false,
    );
    await view.click('Explore children: Destination chapter');
    expect(requests.at(-1)).toMatchObject({ kind: 'historical', revisionId: id(40), parentPlacementId: parentId });
    await view.click('Read current parent');
    expect(requests.at(-1)).toEqual(root);
    await view.click('Move document');
    expect(view.host.textContent).toContain('Selected document');
  } finally {
    await view.dispose();
  }
});

test('mounted sparse history continues once and Retry keeps the attempted cursor', async () => {
  const f = operations();
  const requests: OrganizationRequest[] = [];
  let more = 0;
  const view = await mount({
    ...f.ops,
    read: async (request) => {
      requests.push(request);
      if (request.kind !== 'history') return page(request);
      if (request.cursor && more++ === 0) return { state: 'unavailable' };
      return {
        state: 'ready',
        page: { kind: 'history', notebookId, revisions: [], next: request.cursor ? null : 'opaque-sparse' },
      };
    },
  });
  try {
    await view.click('Structure history');
    expect(requests).toHaveLength(2);
    await view.click('More');
    expect(requests).toHaveLength(3);
    await view.click('Retry');
    expect(requests).toHaveLength(4);
    expect(requests[2]).toEqual(requests[3]);
    expect(view.host.textContent).toContain('No structure history is available on this page');
  } finally {
    await view.dispose();
  }
});

test('mounted replacement retires reviews and late reads/commands for session, CSRF, exposure, source, locale and address', async () => {
  const f = operations();
  let finish!: (result: Awaited<ReturnType<OrganizationOperations['move']>>) => void;
  const view = await mount({
    ...f.ops,
    move: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    await view.click('Move document');
    await view.click('Place at end');
    await view.click('Confirm move');
    await act(async () => {
      view.retire();
    });
    await act(async () => {
      finish({ state: 'acknowledged', receipt: { notebookId, placementId, structureRevisionId: id(5) } });
    });
    expect(view.host.textContent).not.toContain('Move acknowledged');
    for (const boundary of ['session', 'csrf', 'exposure', 'locale', 'source', 'address']) {
      let complete!: (result: OrganizationReadResult) => void;
      const pending = {
        ...f.ops,
        read: () =>
          new Promise<OrganizationReadResult>((resolve) => {
            complete = resolve;
          }),
      };
      await view.show({
        binding: `pending-${boundary}`,
        operations: { read: async () => ({ state: 'retired' }), organization: pending },
      });
      await view.show({
        binding: `replaced-${boundary}`,
        locale: boundary === 'locale' ? 'ja' : 'en',
        address: boundary === 'address' ? { ...root, notebookId: id(100) } : root,
        operations: { read: async () => ({ state: 'retired' }), organization: f.ops },
      });
      await act(async () => {
        complete(
          page(root, {
            placements: [{ placementId, documentId, parentPlacementId: null, title: 'Retired secret', position: '1' }],
          }),
        );
      });
      expect(view.host.textContent).not.toContain('Retired secret');
      expect(view.host.textContent).not.toContain('Confirm move');
    }
  } finally {
    await view.dispose();
  }
});
