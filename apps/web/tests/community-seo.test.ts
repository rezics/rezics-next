import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pageHead } from '../src/shell/head';

const app = join(import.meta.dir, '..');
const route = (path: string) => readFile(join(app, 'src/routes', path), 'utf8');

test('Space metadata is built from its rendered localized data with one WebPage and breadcrumb graph', async () => {
  const source = await route('spaces/$address.tsx');
  expect(source).toContain('pageHead(');
  const head = pageHead(
    {
      title: 'Atlas Readers',
      description: 'A reading room in English',
      image: '/media/atlas-card.jpg',
      type: 'website',
      jsonLd: {
        '@context': 'https://schema.org',
        '@graph': [
          { '@type': 'WebPage', name: 'Atlas Readers', description: 'A reading room in English', url: 'https://rezics.test/en/spaces/atlas', inLanguage: 'en' },
          { '@type': 'BreadcrumbList', itemListElement: [] },
        ],
      },
    },
    { origin: 'https://rezics.test', locale: 'en', path: '/spaces/atlas' },
  );
  expect(head.scripts).toHaveLength(1);
  const graph = JSON.parse(head.scripts[0]!.children);
  expect(graph['@graph'].map((node: { '@type': string }) => node['@type'])).toEqual(['WebPage', 'BreadcrumbList']);
});

test('protected Realm and its Space are noindex and do not expose protected metadata', async () => {
  const source = await route('spaces/$address.tsx');
  expect(source).toContain("robots: 'noindex, follow'");
  expect(source).toContain('visibility');
  expect(source).toContain('pageHead(');
});

test('Space membership is a browser personalRead and the server route does not reread session', async () => {
  const [spaceRoute, query, membership] = await Promise.all([
    route('spaces/$address.tsx'),
    readFile(join(app, 'src/community/space-queries.ts'), 'utf8'),
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
  expect(realm).toContain('pageHead(');
  expect(space).toContain('pageHead(');
});
