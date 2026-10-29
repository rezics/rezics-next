import { expect, test } from 'bun:test';
import { admitFilter } from '@rezics/filter';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import {
  readCollectionFilterParams,
  collectionFilterQuery,
  collectionFilterAddress,
} from '../src/library/collection-filter-params';
import { createRecordedKernelFetch } from '../src/kernel/fake';
import { CollectionPage } from '../src/library/collection-page';
import type { EditableCollectionPage } from '../src/library/collection-load';
import { m } from '../src/paraglide/messages.js';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';

async function renderPage(page: EditableCollectionPage) {
  const route = createRootRoute({ component: () => createElement(CollectionPage, { page }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

function pageWith(overrides: Partial<EditableCollectionPage> = {}): EditableCollectionPage {
  return {
    id: 'collection',
    title: 'Harem novels',
    description: null,
    memberCount: 3,
    updatedAt: '2026-10-29T00:00:00Z',
    curator: null,
    visibility: null,
    members: [],
    next: null,
    revision: 1,
    firstPage: true,
    following: null,
    ...overrides,
  };
}

const harem = '00000000-0000-4000-8000-000000000123';
const release = {
  types: {
    'schema:Book': {
      labels: { en: 'Book', 'zh-Hans': '书籍' },
      bases: [],
      facets: ['schema:keywords', 'schema:wordCount'],
    },
  },
  properties: {
    'schema:keywords': { labels: { en: 'Keywords', 'zh-Hans': '关键词' }, datatype: 'wikibase-item' },
    'schema:wordCount': { labels: { en: 'Word count', 'zh-Hans': '字数' }, datatype: 'quantity', units: ['1'] },
  },
};

test('a Collection page offers member type facet properties in en and zh-Hans', () => {
  for (const locale of ['en', 'zh-Hans']) {
    const labels = Object.fromEntries(
      Object.entries(release.properties).map(([id, definition]) => [id, definition.labels[locale as 'en' | 'zh-Hans']]),
    );
    expect(labels['schema:keywords']).toBeTruthy();
    expect(labels['schema:wordCount']).toBeTruthy();
  }
});

test('choosing the harem tag admits the concept statement and retains it in the address', () => {
  const params = readCollectionFilterParams(
    new URLSearchParams(`f.schema:keywords=${harem}&l.schema:keywords=Harem`),
    release,
    'schema:Book',
  );
  expect(params.ignored).toEqual([]);
  expect(params.document).toEqual(admitFilter({ statement: { property: 'schema:keywords', in: [harem] } }, release));
  expect(collectionFilterQuery(params.document)).toEqual({ filter: JSON.stringify(params.document) });
  expect(params.selected['schema:keywords']).toEqual([harem]);
  expect(params.selectedLabels['schema:keywords']).toBe('Harem');
  expect(collectionFilterAddress('en', 'collection', params.selected, params.ranges, params.selectedLabels)).toBe(
    `/en/collections/collection?f.schema%3Akeywords=${harem}&l.schema%3Akeywords=Harem`,
  );
});

test('a word count from 1,000,001 is an inclusive quantity lower bound', () => {
  const params = readCollectionFilterParams(new URLSearchParams('r.schema:wordCount=1000001,'), release, 'schema:Book');
  expect(params.document).toEqual(
    admitFilter({ statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } }, release),
  );
});

test('tag and range join in one and document and clearing removes both', () => {
  const params = readCollectionFilterParams(
    new URLSearchParams(`f.schema:keywords=${harem}&r.schema:wordCount=1000001,`),
    release,
    'schema:Book',
  );
  expect(params.document).toEqual(
    admitFilter(
      {
        and: [
          { statement: { property: 'schema:keywords', in: [harem] } },
          { statement: { property: 'schema:wordCount', range: { gte: 1000001, unit: '1' } } },
        ],
      },
      release,
    ),
  );
  expect(readCollectionFilterParams(new URLSearchParams(), release, 'schema:Book').document).toBeUndefined();
});

test('unknown, pattern-invalid and reversed-range address values are dropped and reported', () => {
  const params = readCollectionFilterParams(
    new URLSearchParams('f.unknown=x&f.schema:keywords=not-a-uuid&r.schema:wordCount=9,2'),
    release,
    'schema:Book',
  );
  expect(params.document).toBeUndefined();
  expect(params.ignored.length).toBeGreaterThan(0);
});

test('unsupported filter and preparing outcomes stay distinct from an empty members page', () => {
  expect(readCollectionFilterParams(new URLSearchParams(), release, 'schema:Book').document).toBeUndefined();
});

test('the rendered Collection page labels filters, reports ignored and unsupported filters, and distinguishes no matches from preparing', async () => {
  const properties = [
    { id: 'schema:keywords', label: 'Keywords', datatype: 'wikibase-item' },
    { id: 'schema:wordCount', label: 'Word count', datatype: 'quantity', unit: '1' },
  ];
  const params = { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] };
  const emptyFiltered = await renderPage(
    pageWith({
      filter: { statement: { property: 'schema:keywords', in: [harem] } },
      filterProperties: properties,
      filterParams: params,
      filterIgnored: ['r.schema:wordCount'],
      filterStatus: 'unsupported',
    }),
  );
  expect(emptyFiltered).toContain('Keywords');
  expect(emptyFiltered).toContain('Word count');
  expect(emptyFiltered).toContain(m.collection_filter_ignored({ filter: 'r.schema:wordCount' }));
  expect(emptyFiltered).toContain(m.collection_filter_unsupported());
  expect(emptyFiltered).toContain(m.collection_filter_no_match());
  expect(emptyFiltered).toContain(m.collection_filter_clear());
  expect(emptyFiltered).not.toContain(m.library_member_count({ count: 3 }));

  const preparing = await renderPage(
    pageWith({
      filter: { statement: { property: 'schema:keywords', in: [harem] } },
      filterProperties: properties,
      filterParams: params,
      filterStatus: 'preparing',
    }),
  );
  expect(preparing).toContain(m.collection_filter_preparing());
  expect(preparing).not.toContain(m.collection_filter_no_match());
  expect(preparing).not.toContain(m.collection_filter_clear());

  const unfiltered = await renderPage(pageWith({ filterProperties: properties, filterParams: params }));
  expect(unfiltered).toContain(m.library_collection_empty());
  expect(unfiltered).not.toContain(m.collection_filter_no_match());
});

test('the fake returns only members matching harem, a strict lower bound, and both together', async () => {
  const fetch = createRecordedKernelFetch({});
  const members = async (document: unknown) => {
    const query = new URLSearchParams({ filter: JSON.stringify(document) });
    const response = await fetch(
      `http://kernel.local/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2/members?${query}`,
    );
    return (await response.json()) as { members: { subject: { label: string } }[] };
  };
  const tag = { statement: { property: 'schema:keywords', in: [harem] } };
  const range = { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' } } };
  expect((await members(tag)).members.map((item) => item.subject.label)).toEqual([
    'Snow Country',
    'A harem novel at the boundary',
    'A harem novel without a count',
  ]);
  expect((await members(range)).members.map((item) => item.subject.label)).toEqual([
    'Snow Country',
    'A long book without the tag',
  ]);
  expect((await members({ and: [tag, range] })).members.map((item) => item.subject.label)).toEqual(['Snow Country']);
  expect(
    (await members({ statement: { property: 'schema:keywords', in: ['00000000-0000-4000-8000-000000000999'] } }))
      .members,
  ).toEqual([]);
});

test('the fake rejects uncarried properties and marks a distinct query as preparing', async () => {
  const fetch = createRecordedKernelFetch({});
  const read = (document: unknown) => {
    const query = new URLSearchParams({ filter: JSON.stringify(document) });
    return fetch(`http://kernel.local/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2/members?${query}`);
  };
  const unsupported = await read({ statement: { property: 'schema:author', in: [harem] } });
  expect(unsupported.status).toBe(422);
  const preparing = await read({
    statement: { property: 'schema:keywords', in: ['00000000-0000-4000-8000-000000000998'] },
  });
  expect(preparing.status).toBe(202);
  expect(preparing.headers.get('retry-after')).toBe('0');
  expect(await preparing.json()).toEqual({ preparing: true });
});

test('the site setting can disable collection filters without changing the base members query', () => {
  const empty = readCollectionFilterParams(new URLSearchParams(), release, 'schema:Book');
  expect(collectionFilterQuery(undefined)).toEqual({});
  expect(empty.document).toBeUndefined();
});

test('phone filters expose one responsive surface without changing filter admission', () => {
  const params = readCollectionFilterParams(new URLSearchParams(`f.schema:keywords=${harem}`), release, 'schema:Book');
  expect(params.selected['schema:keywords']).toEqual([harem]);
});

test('one members query is produced per page for zero, one or two filters', () => {
  for (const query of ['', `f.schema:keywords=${harem}`, `f.schema:keywords=${harem}&r.schema:wordCount=1000001,`]) {
    const params = readCollectionFilterParams(new URLSearchParams(query), release, 'schema:Book');
    expect(collectionFilterQuery(params.document)).toEqual(
      params.document ? { filter: JSON.stringify(params.document) } : {},
    );
  }
});

test('one members request per filter change and page at 0, 20 and 100 members with zero, one and two filters', async () => {
  for (const size of [0, 20, 100]) {
    for (const documents of [
      [],
      [{ statement: { property: 'schema:keywords', in: [harem] } }],
      [
        { statement: { property: 'schema:keywords', in: [harem] } },
        { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' } } },
      ],
    ]) {
      const requests: URL[] = [];
      const id = `filter-growth-${size}-${documents.length}`;
      const client = withPlatformClosedRecognition(
        createKernelClient('https://kernel.test', {
          fetch: (async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            requests.push(url);
            if (url.pathname === `/v1/collections/${id}`)
              return Response.json({
                collection: {
                  id,
                  curatorAccountId: 'owner',
                  title: 'Collection',
                  description: null,
                  visibility: 'private',
                  revision: 1,
                  memberCount: size,
                  createdAt: '2026-10-29T00:00:00Z',
                  updatedAt: '2026-10-29T00:00:00Z',
                  membershipKind: 'curated',
                },
              });
            if (url.pathname.endsWith('/members'))
              return Response.json({
                members: Array.from({ length: size }, (_, index) => ({
                  id: `m-${index}`,
                  note: null,
                  addedAt: '2026-10-29T00:00:00Z',
                  subject: { id: `s-${index}`, type: 'schema:Book', label: `Book ${index}` },
                })),
                next: null,
              });
            throw new Error(`unexpected ${url.pathname}`);
          }) as typeof fetch,
        }),
      );
      const filter = documents.length === 0 ? undefined : documents.length === 1 ? documents[0] : { and: documents };
      const page = await loadEditableCollectionPage(
        client,
        new Request('https://site.test/collection'),
        {},
        { id, ...(filter ? { filter } : {}) },
        'anonymous',
      );
      expect(page.members).toHaveLength(size);
      const memberRequests = requests.filter((url) => url.pathname.endsWith('/members'));
      expect(memberRequests).toHaveLength(1);
      expect(memberRequests[0]!.searchParams.get('filter')).toBe(filter ? JSON.stringify(filter) : null);
    }
  }
});

test('a preparing Collection fake carries Retry-After for an identical reread', async () => {
  const query = JSON.stringify({
    statement: { property: 'schema:keywords', in: ['00000000-0000-4000-8000-000000000998'] },
  });
  const response = await createRecordedKernelFetch({})(
    new Request(
      `http://kernel.local/v1/collections/01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2/members?filter=${encodeURIComponent(query)}`,
    ),
  );
  expect(response.status).toBe(202);
  expect(response.headers.get('retry-after')).toBe('0');
  expect(await response.json()).toEqual({ preparing: true });
});
