import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { SpacePageData, ShelfPage } from '../src/community/space';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/shelf' });
const globals = {
  ...Object.fromEntries(
    'document navigator location HTMLElement Element Node Document DocumentFragment HTMLButtonElement HTMLFormElement MutationObserver ResizeObserver'
      .split(' ')
      .map((key) => [key, window[key as keyof typeof window]]),
  ),
  window,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  readSpacePage: async () => ({ ...page, readerOrigin: { kind: 'signed-in', subject: 'reader' } }),
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { RealmShelf } = await import('../src/community/space-page');
const { captureSpacePageAdmission, SpacePageLifetimeHost } = await import('../src/community/space-page-lifetime');
const { spaceQuery } = await import('../src/community/space-queries');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const added = (_kind: string, id = 'new-entry') => ({
  id,
  title: id,
  label: id,
  labels: { en: id },
  types: ['schema:Book'],
  typeName: 'Book',
  cover: null,
  description: null,
  purpose: 'discussion' as const,
  visibility: 'published' as const,
});
const page: SpacePageData = {
  space: { id: 'space', title: 'Shelf', summary: '' },
  realm: {
    id: 'realm',
    title: 'Realm',
    summary: '',
    visibility: 'public',
    viewer: null,
    boards: [added('boards', 'original-board')],
    published: [added('publications', 'original-publication')],
    boardNext: 'boards-next',
    publicationNext: 'publications-next',
    credentialMode: 'session',
  },
};
const deferred = () => Promise.withResolvers<ShelfPage<ReturnType<typeof added>>>();
const reads: Record<'boards' | 'publications', ReturnType<typeof deferred>[]> = { boards: [], publications: [] };
const cursors: (string | undefined)[] = [];
function read(kind: 'boards' | 'publications', input: { cursor?: string }) {
  const response = deferred();
  reads[kind].push(response);
  cursors.push(input.cursor);
  return response.promise;
}
const transport = {
  boards: (input: { cursor?: string }) => read('boards', input),
  publications: (input: { cursor?: string }) => read('publications', input),
  change: async () => ({ kind: 'denied' as const }),
};
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let loaded: Awaited<ReturnType<InstanceType<typeof QueryClient>['fetchQuery']>>;
let frame: React.ReactNode;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function load() {
  const target = { kind: 'space' as const, address: 'shelf' };
  const admission = captureSpacePageAdmission(client, { target, locale: 'en', credentialMode: 'session' });
  const result = await client.fetchQuery({ ...spaceQuery('shelf', 'en', 'session', admission), staleTime: 0 });
  loaded = result;
  frame = (
    <SpacePageLifetimeHost {...result} target={target} locale="en" credentialMode="session">
      <RealmShelf realm={result.page.realm!} frozen transport={transport} />
    </SpacePageLifetimeHost>
  );
}
async function settle(action: () => void) {
  await act(async () => {
    action();
    await tick();
  });
}
async function paint() {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => frame }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  await settle(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}
async function mount() {
  await close();
  reads.boards.length = reads.publications.length = cursors.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: null });
  await load();
  root = createRoot(host);
  await paint();
  expect(document.activeElement).toBe(document.body);
}
async function close() {
  await settle(() => root?.unmount());
  root = undefined!;
  client?.clear();
}
afterEach(close);
afterAll(() => {
  mock.restore();
  host.remove();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const section = (kind: string) =>
  host
    .querySelector<HTMLElement>(kind === 'boards' ? '#realm-boards-heading' : '#realm-published-heading')!
    .closest('section')!;
const button = (kind: string) => section(kind).querySelector<HTMLButtonElement>('button')!;
async function activate(kind: string, pointer = false) {
  await settle(() => {
    const node = button(kind);
    if (!pointer) node.focus();
    node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: pointer ? 1 : 0 }));
  });
}
async function accept(kind: 'boards' | 'publications', items: ReturnType<typeof added>[], next: string | null = null) {
  await settle(() => reads[kind].at(-1)!.resolve({ kind: 'page', items, next, unavailable: 1 }));
}
const announcement = (kind: string) => section(kind).querySelector('.sr-only[role="status"]')!.textContent;
const kinds = ['boards', 'publications'] as const;

const name = (kind: string) => (kind === 'boards' ? m.realm_boards_heading() : m.realm_published_heading());
test('each keyboard shelf continues, recovers at its cursor, and focuses named new or sparse portions independently', async () => {
  await mount();
  for (const kind of kinds) {
    await activate(kind);
    await settle(() => reads[kind].at(-1)!.resolve({ kind: 'unavailable' }));
    expect(document.activeElement).toBe(button(kind));
    expect(button(kind).textContent).toBe(m.realm_shelf_retry());
    await activate(kind);
    await accept(
      kind,
      [added(kind, kind === 'boards' ? 'original-board' : 'original-publication'), added(kind)],
      'sparse-next',
    );
    expect(document.activeElement?.textContent).toContain('new-entry');
    expect(document.activeElement?.getAttribute('aria-label')).toContain(name(kind));
    expect(announcement(kind)).toBe(m.realm_shelf_added({ shelf: name(kind), count: 1 }));
    for (const next of ['sparse-next', null]) {
      await activate(kind);
      await accept(kind, next ? [] : [added(kind)], next);
      expect(document.activeElement).toBe(section(kind).querySelector('h2'));
      expect(announcement(kind)).toBe(m.realm_shelf_sparse({ shelf: name(kind) }));
    }
    expect(section(kind).querySelector('button')).toBeNull();
    expect(reads[kind]).toHaveLength(4);
  }
  expect(cursors).toEqual(kinds.flatMap((kind) => [`${kind}-next`, `${kind}-next`, 'sparse-next', 'sparse-next']));
});

test('pointer continuation and moving focus elsewhere suppress handoff and announcement in either shelf', async () => {
  for (const kind of kinds)
    for (const pointer of [true, false]) {
      await mount();
      await activate(kind, pointer);
      const other = button(kind === 'boards' ? 'publications' : 'boards');
      other.focus();
      await accept(kind, [added(kind)]);
      expect(document.activeElement).toBe(other);
      expect(announcement(kind)).toBe('');
    }
});

test('source replacement, Leave and session revocation discard late rows, focus and announcements', async () => {
  for (const retirement of ['source', 'leave', 'revocation']) {
    await mount();
    await activate('boards');
    await activate('publications');
    await settle(() => {
      if (retirement === 'leave') root.render(<button>Destination</button>);
      else if (retirement === 'revocation')
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      else client.setQueryData(spaceQuery('shelf', 'en', 'session').queryKey, loaded);
    });
    if (retirement === 'source') {
      await load();
      await paint();
    }
    await accept('boards', [added('boards', 'obsolete-board')]);
    await accept('publications', [added('publications', 'obsolete-publication')]);
    expect(host.textContent).not.toContain('obsolete');
    expect([...host.querySelectorAll('[role="status"]')].every((node) => !node.textContent)).toBe(true);
    expect(document.activeElement).toBe(document.body);
  }
});
