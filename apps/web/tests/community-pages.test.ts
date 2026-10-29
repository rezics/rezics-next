import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

mock.module('@tanstack/react-router', () => ({
  Link: ({ children, to, params, className }: any) =>
    createElement('a', { href: `${to.replace(/\$id/, params?.id ?? '')}`, className }, children),
  useLocation: () => ({ publicHref: 'https://site.example/en/spaces/atlas' }),
}));
mock.module('../src/community/realm-membership', () => ({
  RealmMembership: () => createElement('button', { className: 'h-10 px-4' }, 'Join'),
}));

const { SpacePage } = await import('../src/community/space-page');
const { MyRealmsPageView } = await import('../src/community/my-realms-page');
const { loadSpacePage } = await import('../src/community/space');

const space = {
  id: 'space-42',
  title: 'Atlas Readers',
  summary: 'Read slowly, together.',
  banner: {
    media: 'banner-42',
    width: 1200,
    height: 500,
    placeholder: { thumbhash: '', color: '#252a31' },
    variants: [{ format: 'webp', width: 320 }],
    focalPoint: null,
    credit: null,
  },
};

const spacePage = {
  space,
  realm: {
    id: 'realm-42',
    title: 'Atlas Readers',
    summary: 'A public reading room.',
    visibility: 'public',
    viewer: { state: 'none', idempotencyKey: 'join-key' },
    boards: [
      { id: 'board-1', title: 'General', description: 'Talk about books.', kind: 'discussion', purpose: 'discussion' },
    ],
    published: [],
  },
};

test('Space header uses a carried banner, and places its primary membership action beside the title', () => {
  const html = renderToString(createElement(SpacePage, { page: spacePage as any }));
  const header = /<header\b[^>]*>[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
  expect(header).toContain('/media/banner-42/');
  expect(header).toContain('Atlas Readers');
  expect(header).toContain('Read slowly, together.');
  expect(header).toContain('>Join</button>');
  expect(header.indexOf('>Join</button>')).toBeLessThan(header.indexOf('</header>'));
});

test('Space placeholder tone is stable by Space ID, with readable title and summary over the surface', () => {
  const page = { ...spacePage, space: { ...space, banner: undefined } } as any;
  const first = renderToString(createElement(SpacePage, { page }));
  const second = renderToString(createElement(SpacePage, { page }));
  const color = /style="([^"]+)"/.exec(first)?.[1];
  expect(color).toBeTruthy();
  expect(/style="([^"]+)"/.exec(second)?.[1]).toBe(color);
  expect(color).not.toContain('var(--brand)');
  expect(first).toContain('Atlas Readers');
  expect(first).toContain('Read slowly, together.');
});

test('Space board rows show their description and kind as plain row text', () => {
  const html = renderToString(createElement(SpacePage, { page: spacePage as any }));
  expect(html).toContain('Talk about books.');
  expect(html).toContain('Discussion');
  expect(html).not.toContain('data-slot="badge"');
});

test('My Realms uses description-bearing stretched ListRows without totals or resting cards', () => {
  const html = renderToString(
    createElement(MyRealmsPageView, {
      page: {
        signedIn: true,
        next: null,
        realms: [{ realmId: 'realm-42', name: 'Atlas Readers', description: 'A public reading room.' }],
      } as any,
    }),
  );
  expect(html).toContain('data-slot="list-row"');
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).toContain('Atlas Readers');
  expect(html).toContain('A public reading room.');
  expect(html).not.toMatch(/\b(?:\d+ members|\d+ followers)\b/i);
  expect(html).not.toMatch(/divide-y|rounded-2xl border|bg-card/);
});

test('Space Realm list uses the same stretched ListRow pattern with no totals', () => {
  const html = renderToString(createElement(SpacePage, { page: spacePage as any }));
  expect(html).toContain('data-slot="list-row"');
  expect(html).toContain('data-slot="list-row-link"');
  expect(html).not.toMatch(/\b(?:\d+ members|\d+ followers)\b/i);
  expect(html).not.toMatch(/divide-y|rounded-2xl border|bg-card/);
});

test('rendering the Space and carried Realm uses the existing five reads and adds no read', async () => {
  const calls: string[] = [];
  const client = {
    spaceAddresses: () => ({ get: async () => (calls.push('address'), { data: { spaceId: 'space-42' } }) }),
    spaces: () => ({
      get: async () => (
        calls.push('space'),
        { data: { space: { spaceId: 'space-42', realmId: 'realm-42', title: 'Atlas Readers', summary: 'Summary' } } }
      ),
    }),
    realms: () => ({
      get: async () => (
        calls.push('realm'),
        {
          data: {
            realm: {
              realmId: 'realm-42',
              title: 'Atlas Readers',
              summary: 'A public reading room.',
              visibility: 'public',
            },
          },
        }
      ),
      boards: { get: async () => (calls.push('boards'), { data: { items: [], next: null } }) },
      publications: { get: async () => (calls.push('publications'), { data: { items: [], next: null } }) },
    }),
  };
  const page = await loadSpacePage(
    client as any,
    new Request('https://site.example/en/spaces/atlas'),
    {},
    { address: 'atlas' },
    'anonymous',
  );
  expect(page.realm?.title).toBe('Atlas Readers');
  expect(calls.toSorted()).toEqual(['address', 'boards', 'publications', 'realm', 'space']);
});
