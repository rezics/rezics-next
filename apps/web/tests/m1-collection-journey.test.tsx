import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import type { PublicCollectionSummary } from '../src/search/discovery';
import type { CollectionMember } from '../src/library/reads';
import type { EditableCollectionPage } from '../src/library/collection-load';
import { getLocale, overwriteGetLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
const id = (n: number) => `01a1a000-0000-7000-8000-0030000000${String(n).padStart(2, '0')}`;
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://site.test/en/collections/${id(20)}` });
window.document.head.innerHTML = `<link rel="canonical" href="https://site.test/en/collections/${id(20)}">`;
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLSelectElement: window.HTMLSelectElement,
  FormData: window.FormData,
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
const { readPublicCollectionPage } = await import('../src/library/public-collection-discovery/read');
const { PublicCollectionDiscoveryPage } = await import('../src/library/public-collection-discovery/page');
const { CollectionPage, CollectionReadMembers } = await import('../src/library/collection-page');
const { DynamicCollectionPage } = await import('../src/library/dynamic-collection-page');
const { NewCollectionForm } = await import('../src/routes/collections/new');
const { subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const members: CollectionMember[] = [1, 2, 3].map((n) => ({
  id: id(n + 10),
  subjectId: id(n === 2 ? 1 : n),
  addedAt: '2026-11-01T00:00:00Z',
  note: `Note ${n}`,
  subject: {
    id: id(n === 2 ? 1 : n),
    type: n === 3 ? 'person' : 'work',
    types: [n === 3 ? 'person' : 'work'],
    typeLabel: n === 3 ? 'Person' : 'Work',
    label: n === 3 ? '日本語の長い名前 · 繁體中文' : 'A long multilingual title · シュタインズ・ゲート · 命運石之門',
    cover: null,
  },
}));
const card: PublicCollectionSummary['card'] = {
  kind: 'collection',
  id: id(20),
  destination: `/collections/${id(20)}`,
  title: 'A disclosed Collection',
  description: 'Native public description',
  visibility: 'public',
  revision: 1,
  sourceGeneration: '1',
  membershipKind: 'curated',
  memberCount: 3,
  orderEpoch: 1,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  presentationKind: null,
  presentationKindSource: 'mixed',
  cover: null,
  coverSource: 'none',
  curator: { state: 'unavailable', reason: 'withheld' },
  preview: {
    state: 'available',
    partial: true,
    truncated: false,
    members: members.slice(0, 2).map((member) => ({
      id: member.id,
      subject: {
        id: member.subject!.id,
        type: member.subject!.type,
        types: member.subject!.types,
        label: { value: member.subject!.label as string, language: 'ja' },
      },
    })),
  },
};

test('native public discovery leads to ordered/mixed and grid reading, with exact occurrence return in en, zh-Hant and ja', async () => {
  const previous = getLocale;
  try {
    for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
      overwriteGetLocale(() => locale);
      let cursor: string | undefined;
      const result = await readPublicCollectionPage(locale, 'opaque+/=', async (request) => {
        cursor = request.cursor;
        return {
          status: 200,
          data: {
            ...discoveryExample,
            hits: [
              {
                key: { owner: 'library', kind: 'collection', route: 48, id: card.id },
                summary: {
                  kind: 'collection',
                  value: { id: card.id, title: card.title, description: card.description, card },
                },
              },
            ],
            next: 'native-next+/=',
          },
        };
      });
      expect(cursor).toBe('opaque+/=');
      expect(result.status).toBe('ready');
      const discovery = renderToStaticMarkup(
        <PublicCollectionDiscoveryPage locale={locale} state={result} onRetry={() => {}} />,
      );
      expect(discovery).toContain(`href="/${locale}/collections/${card.id}"`);
      expect(discovery).toContain('native-next%2B%2F%3D');
      expect(discovery).toContain('data-collection-kind="mixed"');
      expect(discovery).not.toContain('sourceGeneration');
      for (const layout of ['list', 'grid'] as const) {
        const source = `/${locale}/collections/${card.id}?cursor=opaque&layout=${layout}`;
        const read = renderToStaticMarkup(
          <CollectionReadMembers members={members} layout={layout} currentHref={source} onCopy={() => {}} />,
        );
        expect(read.indexOf(`id="collection-member-${members[0]!.id}"`)).toBeLessThan(
          read.indexOf(`id="collection-member-${members[1]!.id}"`),
        );
        const via = [...read.matchAll(/href="([^"]+)"/g)]
          .map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'))
          .find((url) => url.searchParams.get('via')?.endsWith(members[1]!.id));
        expect(via?.pathname).toContain(members[1]!.subject!.id);
        expect(subjectVisitReturn(via?.searchParams.get('via'), locale)).toBe(
          `${source}#collection-member-${members[1]!.id}`,
        );
        expect(read).not.toContain('data-rank=');
      }
    }
  } finally {
    overwriteGetLocale(previous);
  }
});

test('current native actions govern create/add/reorder; review precedes sending and only acknowledgement refreshes rows', async () => {
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { libraryNavigationQuery } = await import('../src/library/pins-read');
  const edits = await import('../src/library/collection-edit');
  const suggestions = await import('../src/threads/content-subject-search');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'original-csrf' });
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const snapshot = lifetime.getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Missing viewer observation');
  client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
    subject: 'owner',
    admitted: ['collections'],
  });
  client.setQueryData(['exposure', 'anonymous'], ['collections']);
  client.setQueryData(libraryNavigationQuery('en', 100).queryKey, { pins: { state: 'closed' }, collections: [] });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: [`/en/collections/${card.id}`] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (child: ReactNode) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>{child}</RouterContextProvider>
        </QueryClientProvider>,
      );
    });
  const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => {
      (element as HTMLElement).click();
    });
  };
  const button = (text: string) =>
    [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text,
    );
  const input = async (element: HTMLInputElement, value: string) =>
    act(async () => {
      element.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(
        new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }) as unknown as Event,
      );
    });
  const page: EditableCollectionPage = {
    id: card.id,
    title: card.title,
    description: card.description,
    members,
    memberCount: 3,
    visibility: 'public',
    curator: null,
    revision: 1,
    firstPage: true,
    following: null,
    publicExport: false,
    next: null,
    updatedAt: card.updatedAt,
    viewerActions: {
      state: 'ready',
      actions: [
        {
          action: 'collection:update',
          operations: ['collection.update', 'collection_member.create', 'collection_member.move'],
        },
      ],
    },
  };
  const calls: Parameters<typeof edits.createCollection>[0][] = [];
  const sender: typeof edits.createCollection = async (command) => {
    calls.push(command);
    return { ok: false, reason: calls.length === 1 ? 'unavailable' : 'invalid' };
  };
  let refreshes = 0;
  let acknowledged = page;
  const update = spyOn(edits, 'updateCollection').mockResolvedValue({ ok: true, id: page.id, revision: 2 });
  const moves = spyOn(edits, 'moveCollectionMember').mockImplementation(async () => {
    acknowledged = { ...page, revision: 2, members: [members[1]!, members[0]!, members[2]!] };
    return { ok: true, id: members[1]!.id };
  });
  const adds = spyOn(edits, 'addCollectionMember').mockResolvedValue({ ok: true, id: id(40) });
  const search = spyOn(suggestions, 'searchContentSubjects').mockResolvedValue([
    { id: members[0]!.subject!.id, title: 'Disclosed work', types: ['work'], typeLabel: 'Work', cover: null },
  ]);
  try {
    await render(
      <NewCollectionForm csrfToken="original-csrf" types={[{ id: 'work', label: 'Work' }]} sender={sender} />,
    );
    await input(host.querySelector('input[name=title]')!, 'Reviewed title');
    const visibility = host.querySelector('select')!;
    // The first select is the Type; visibility uses the existing radio group.
    expect(visibility.value).toBe('');
    await act(async () => {
      visibility.value = 'work';
      visibility.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    });
    await click(
      [...host.querySelectorAll('[role=radio]')].find(
        (node) => node.getAttribute('value') === 'public' || node.getAttribute('id')?.endsWith('public'),
      ) ?? host.querySelector('[role=radio]'),
    );
    expect(host.querySelector('[data-collection-create-review]')?.textContent).toContain('Reviewed title');
    await act(async () => {
      host
        .querySelector('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data.presentationKind).toBe('work');
    await click(button(m.library_publication_retry()));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    function PageHost() {
      const { data: value } = useQuery({
        queryKey: ['collection-journey'],
        queryFn: async () => acknowledged,
        initialData: acknowledged,
      });
      return (
        <CollectionPage
          queryKey={['collection-journey']}
          cursor={undefined}
          layout="grid"
          page={value}
          refreshPage={async () => {
            refreshes++;
            return acknowledged;
          }}
          readEditorPage={async () => acknowledged}
        />
      );
    }
    const show = async (value: EditableCollectionPage) => {
      acknowledged = value;
      await act(async () => {
        client.setQueryData(['collection-journey'], value);
      });
      await render(<PageHost />);
    };
    await show({ ...page, viewerActions: { state: 'ready', actions: [] } });
    expect(button(m.library_collection_add_items())).toBeUndefined();
    await show(page);
    expect(host.querySelector('[data-collection-members]')?.getAttribute('data-collection-layout')).toBe('grid');
    await click(button(m.library_collection_add_items()));
    const picker = host.querySelector<HTMLInputElement>('input[role=combobox]')!;
    await click(picker);
    await input(picker, 'Disclosed');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => {
      picker.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }) as unknown as Event,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(document.body.innerHTML).toContain('role="option"');
    await click(
      [...document.querySelectorAll('[role=option]')].find((node) => node.textContent?.includes('Disclosed work')),
    );
    expect(host.querySelector('[data-collection-add-review]')?.textContent).toContain('Disclosed work');
    await click(button(m.library_collection_add_selected()));
    expect(adds).toHaveBeenCalledTimes(1);
    expect(adds.mock.calls[0]![0].data.subjectId).toBe(members[0]!.subject!.id);
    expect(refreshes).toBe(1);
    await click(button(m.library_collection_actions()));
    await click(
      [...document.querySelectorAll('[role=menuitem], button')].find(
        (node) => node.textContent?.trim() === m.library_collection_edit(),
      ),
    );
    const down = host.querySelector<HTMLButtonElement>(
      `[data-member="${members[0]!.id}"] button[aria-label^="${m.library_member_move_down()}"]`,
    );
    await click(down);
    expect(host.querySelector('[data-collection-edit-review]')?.textContent).toContain(
      members[0]!.subject!.label as string,
    );
    expect(moves).not.toHaveBeenCalled();
    await act(async () => {
      host
        .querySelector('#collection-edit-form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
    });
    expect(moves).toHaveBeenCalledTimes(1);
    expect(moves.mock.calls[0]![0].data).toMatchObject({ memberId: members[1]!.id, after: null });
    expect(refreshes).toBe(2);
    expect(
      [...host.querySelectorAll('[data-collection-members] > li, [data-slot="collection-member-card"]')].map(
        (node) =>
          node.getAttribute('data-collection-member-id') ??
          node.querySelector('[data-collection-member-id]')?.getAttribute('data-collection-member-id'),
      ),
    ).toEqual(acknowledged.members.map((member) => member.id));
    expect(
      [...host.querySelectorAll('[data-collection-member-id]')].map((node) =>
        node.getAttribute('data-collection-member-id'),
      ),
    ).toContain(members[0]!.id);
    expect(host.querySelector('[data-collection-members]')?.getAttribute('data-collection-layout')).toBe('grid');
    const dynamic = {
      id: id(30),
      title: 'Saved property rule',
      description: null,
      curator: null,
      members: [],
      next: null,
      preparing: false,
      unavailable: false,
      retryAfterMs: 1000,
      filterType: 'work',
      filterProperties: [{ id: 'schema:datePublished', label: 'Published', datatype: 'time' }],
      filterParams: { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] },
    };
    await render(<DynamicCollectionPage page={dynamic} />);
    expect(host.querySelector('[data-collection-presentation="dynamic"]')).toBeTruthy();
    expect(host.textContent).toContain(m.library_collection_empty());
    await render(<DynamicCollectionPage page={{ ...dynamic, preparing: true }} />);
    expect(host.textContent).toContain(m.library_dynamic_preparing());
    expect(host.textContent).not.toContain(m.library_collection_empty());
    await render(<DynamicCollectionPage page={{ ...dynamic, unavailable: true, cursorRestarted: true }} />);
    expect(host.textContent).toContain(m.library_dynamic_unavailable());
    expect(host.textContent).toContain(m.library_collections_cursor_reset());
  } finally {
    update.mockRestore();
    moves.mockRestore();
    adds.mockRestore();
    search.mockRestore();
    await act(async () => root.unmount());
    stop();
    client.clear();
  }
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
