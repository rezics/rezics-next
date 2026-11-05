import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { communityPageHead } from '../src/community/space-head-data';

const app = join(import.meta.dir, '..');
const route = (path: string) => readFile(join(app, 'src/routes', path), 'utf8');

test('Space metadata is built from its rendered localized data with one WebPage and breadcrumb graph', async () => {
  const source = await route('spaces/$address.tsx');
  expect(source).toContain('spacePageHead(');
  const page = {
    space: { id: 'space-1', title: 'Atlas Readers', summary: 'A reading room in English' },
    realm: {
      id: 'realm-1',
      title: 'Atlas Readers Realm',
      visibility: 'public' as const,
      boards: [],
      published: [],
      viewer: null,
    },
  };
  const head = communityPageHead(page, 'https://rezics.test', 'en', '/spaces/atlas');
  expect(head.meta).toContainEqual({ title: 'Atlas Readers – REZICS' });
  expect(head.meta).toContainEqual({ name: 'description', content: 'A reading room in English' });
  expect(head.meta).toContainEqual({ property: 'og:image', content: 'https://rezics.test/cards/default.png' });
  expect(head.meta).toContainEqual({ property: 'og:type', content: 'website' });
  expect(head.scripts).toHaveLength(1);
  const graph = JSON.parse(head.scripts[0]!.children);
  expect(graph['@graph'].map((node: { '@type': string }) => node['@type'])).toEqual(['WebPage', 'BreadcrumbList']);
  expect(graph['@graph'][0]).toEqual({
    '@type': 'WebPage',
    name: 'Atlas Readers',
    description: 'A reading room in English',
    url: 'https://rezics.test/en/spaces/atlas',
    inLanguage: 'en',
  });
  expect(graph['@graph'][1].itemListElement).toHaveLength(3);
});

test('protected Realm and its Space are noindex and do not expose protected metadata', async () => {
  const source = await route('spaces/$address.tsx');
  expect(source).toContain('spacePageHead(');
  const page = {
    space: { id: 'space-1', title: 'Visible Space', summary: 'Visible summary' },
    realm: {
      id: 'realm-1',
      title: 'Private realm title',
      visibility: 'protected' as const,
      boards: [],
      published: [],
      viewer: null,
    },
  };
  const head = communityPageHead(page, 'https://rezics.test', 'en', '/spaces/visible');
  expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex, follow' });
  const serialized = JSON.stringify(head);
  expect(serialized).not.toContain('Private realm title');
  expect(serialized).toContain('Visible Space');
});

test('Space membership is a browser personalRead and the server route does not reread session', async () => {
  const [spaceRoute, query, membership] = await Promise.all([
    route('spaces/$address.tsx'),
    readFile(join(app, 'src/community/realm-membership-queries.ts'), 'utf8'),
    readFile(join(app, 'src/community/realm-membership.tsx'), 'utf8'),
  ]);
  expect(spaceRoute).not.toContain('sessionReread');
  expect(query).toContain('personalRead');
  expect(membership).toContain('useQuery');
  expect(membership).toContain('realmMembershipQuery');
});

test('Realm redirect keeps 307 and Realm without a Space uses the shared page head', async () => {
  const [realm, space] = await Promise.all([route('realms/$id.tsx'), route('spaces/$address.tsx')]);
  expect(realm).toContain('statusCode: 307');
  expect(realm).toContain('spacePageHead(');
  expect(space).toContain('spacePageHead(');
});
