import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.com' } }));
const { CollectionPage, collectionPageHead } = await import('../src/library/collection-page');
const { Route } = await import('../src/routes/collections/$id');
const { collectionPageQuery, personalCollectionPageQuery } = await import('../src/library/collection-queries');

test('public collection head describes its locale, card, members and breadcrumb graph', () => {
  const head = collectionPageHead(
    {
      id: 'collection-1',
      title: 'Night reading',
      description: 'Stories after dark',
      memberCount: 2,
      updatedAt: '',
      visibility: null,
      next: null,
      curator: { handle: 'ada', displayName: 'Ada' },
      members: [
        {
          id: 'member-1',
          note: null,
          addedAt: '',
          subject: {
            id: 'subject-1',
            label: 'Alpha',
            type: 'book',
            types: ['book'],
            cover: {
              media: 'media-1',
              width: 600,
              height: 900,
              withheld: false,
              variants: [{ width: 1200, format: 'webp' }],
            },
          },
        },
        {
          id: 'member-2',
          note: null,
          addedAt: '',
          subject: { id: 'subject-2', label: 'Beta', type: 'book', types: ['book'], cover: null },
        },
      ],
    },
    { origin: 'https://rezics.com', locale: 'en', path: '/collections/collection-1' },
  );
  expect(head.meta).toContainEqual({ title: 'Night reading – REZICS' });
  expect(head.meta).toContainEqual({ name: 'description', content: 'Stories after dark' });
  expect(head.meta).toContainEqual(
    expect.objectContaining({ property: 'og:image', content: expect.stringContaining('/media/media-1/webp-1200') }),
  );
  const graph = JSON.parse(head.scripts![0]!.children!);
  expect(graph['@graph'].map((item: { '@type': string }) => item['@type'])).toEqual([
    'CollectionPage',
    'BreadcrumbList',
  ]);
  const collectionPage = graph['@graph'][0];
  expect(collectionPage.mainEntity).toMatchObject({
    '@type': 'ItemList',
    numberOfItems: 2,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
  });
  expect(collectionPage.mainEntity.itemListElement).toEqual([
    { '@type': 'ListItem', position: 1, url: 'https://rezics.com/en/subjects/subject-1/alpha' },
    { '@type': 'ListItem', position: 2, url: 'https://rezics.com/en/subjects/subject-2/beta' },
  ]);
  expect(graph['@graph'][1].itemListElement).toEqual([
    { '@type': 'ListItem', position: 1, name: 'REZICS', item: 'https://rezics.com' },
    { '@type': 'ListItem', position: 2, name: 'Ada', item: 'https://rezics.com/en/@ada' },
    { '@type': 'ListItem', position: 3, name: 'Night reading', item: 'https://rezics.com/en/collections/collection-1' },
  ]);
});

test('cursor search is validated and passed to an anonymous collection loader', async () => {
  const head = collectionPageHead(
    {
      id: 'c',
      title: 'T',
      description: null,
      memberCount: 0,
      updatedAt: '',
      visibility: null,
      next: null,
      curator: null,
      members: [],
    },
    { origin: 'https://rezics.com', locale: 'en', path: '/collections/c' },
    true,
  );
  expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex, follow' });

  const options = (
    Route as unknown as {
      options: {
        validateSearch: (search: Record<string, unknown>) => {
          cursor?: string;
          filters?: Record<string, string | string[]>;
        };
        loaderDeps: (input: { search: { cursor?: string; filters?: Record<string, string | string[]> } }) => unknown;
        loader: (input: unknown) => Promise<unknown>;
        staticData?: Record<string, unknown>;
      };
    }
  ).options;
  const search = options.validateSearch({ cursor: 'page-two', 'f.schema:genre': 'fantasy', ignored: 'drop' });
  expect(search).toEqual({ cursor: 'page-two', filters: { 'f.schema:genre': 'fantasy' } });
  expect(options.validateSearch({ cursor: '' })).toEqual({});
  const deps = options.loaderDeps({ search });
  expect(deps).toEqual({ cursor: 'page-two', filters: { 'f.schema:genre': 'fantasy' } });
  expect(options.staticData?.sessionReread).toBeUndefined();

  const reads: { queryKey: readonly unknown[] }[] = [];
  const page = { id: 'collection-1' };
  const loaded = await options.loader({
    params: { id: 'collection-1' },
    deps,
    context: {
      credentialMode: 'anonymous',
      queryClient: {
        ensureQueryData: async (query: { queryKey: readonly unknown[] }) => {
          reads.push(query);
          return page;
        },
      },
    },
  });
  expect(loaded).toBe(page);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.queryKey).toContain('anonymous');
  expect(reads[0]!.queryKey).toContain('page-two');
});

test('the anonymous head uses the default card and private collections are noindex', () => {
  const page = {
    id: 'private-one',
    title: 'Private',
    description: null,
    memberCount: 0,
    visibility: 'private' as const,
    curator: { handle: 'ada', displayName: 'Ada' },
    members: [],
  };
  const head = collectionPageHead(page, {
    origin: 'https://rezics.com',
    locale: 'zh-Hans',
    path: '/collections/private-one',
  });
  expect(head.meta).toContainEqual(
    expect.objectContaining({ property: 'og:image', content: 'https://rezics.com/cards/default.png' }),
  );
  expect(head.meta).toContainEqual({ name: 'robots', content: 'noindex, follow' });
});

test('the public loader and curator query use separate read modes, with no controls in server markup', async () => {
  const publicQuery = collectionPageQuery('collection-1', undefined, 'anonymous');
  const personalQuery = personalCollectionPageQuery('collection-1');
  expect(publicQuery.queryKey).toContain('anonymous');
  expect(personalQuery.queryKey).toContain('session');
  expect(personalQuery.staleTime).toBe(0);
  expect(personalQuery.enabled).toBe(false);

  const page = {
    id: 'collection-1',
    title: 'Night reading',
    description: null,
    memberCount: 0,
    updatedAt: '2026-04-02T15:04:05.000Z',
    visibility: null,
    curator: { handle: 'ada', displayName: 'Ada' },
    members: [],
    next: null,
    revision: 1,
    firstPage: true,
    following: null,
  };
  const queryClient = new QueryClient();
  const root = createRootRoute({
    component: () =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(CollectionPage, { page, cursor: undefined }),
      ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const html = renderToString(createElement(RouterProvider, { router }));
  expect(html).not.toContain('data-visibility=');
  expect(html).not.toContain('More actions');
});
