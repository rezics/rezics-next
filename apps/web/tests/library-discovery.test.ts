import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { libraryNavigationEntries } from '../src/library/library-nav';
import { CollectionPreview, type CollectionBrowseRecord } from '../src/library/collection-browser';
import { loadMineCollectionsForOwner } from '../src/library/mine-collections';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const collection: CollectionBrowseRecord = {
  id: 'collection',
  title: 'My reading',
  curator: null,
  visibility: 'private',
  memberCount: 17,
  preview: {
    state: 'loaded',
    members: ['First', 'Second', 'Third', 'Fourth'].map((label, index) => ({
      id: `subject-${index}`,
      label,
      type: 'schema:Book',
      types: ['schema:Book'],
      cover: null,
    })),
  },
};

async function preview(record: CollectionBrowseRecord) {
  const root = createRootRoute({ component: () => createElement(CollectionPreview, { collection: record }) });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('Personal Library and Collection discovery use one useful navigation row and real bounded previews', async () => {
  const entries = libraryNavigationEntries(
    { collectionId: 'pinned' },
    {
      state: 'loaded',
      revision: 3,
      next: null,
      pins: [
        { collectionId: 'pinned', target: { id: 'pinned', title: 'A long personal reading list' } },
        { collectionId: 'hidden', target: null },
      ],
    },
    [
      { id: 'pinned', title: 'A long personal reading list' },
      { id: 'everything', title: null, membershipKind: 'dynamic', builtinKind: 'everything' },
      {
        id: 'reading',
        title: null,
        membershipKind: 'dynamic',
        builtinKind: 'state',
        builtinLabels: { en: 'Reading a particularly long collection of books' },
      },
      { id: 'other', title: 'Another Collection' },
    ],
    'en',
  );
  expect(entries.tabs.map((entry) => entry.id)).toEqual([
    'pinned',
    'hidden',
    'everything',
    'reading',
    'tracked',
    'continue',
    'collections',
  ]);
  expect(entries.tabs[0]?.current).toBe(true);
  expect(entries.tabs[1]?.href).toBeUndefined();
  expect(entries.overflow.map((entry) => entry.id)).toEqual(['other']);
  const html = await preview(collection);
  expect(html.match(/data-slot="cover-card"/g)).toHaveLength(3);
  expect(html.indexOf('>First</a>')).toBeLessThan(html.indexOf('>Second</a>'));
  expect(html.indexOf('>Second</a>')).toBeLessThan(html.indexOf('>Third</a>'));
  expect(html).not.toContain('Fourth');
  expect(html).toContain(m.library_collection_item_count({ count: 17 }));
  expect(html).toContain(m.library_visibility_private());
});

test('bounded owner discovery requests the agreed opt-in preview without a member or detail waterfall', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(new Request(input, init));
        return Response.json({ code: 'unavailable' }, { status: 503 });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  await expect(loadMineCollectionsForOwner(client, 'owner', 'Bearer viewer', { layout: 'previews' })).rejects.toThrow();
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0]!.url);
  expect(url.pathname).toBe('/v1/collections');
  expect(url.searchParams.get('curatorAccountId')).toBe('owner');
  expect(url.searchParams.get('view')).toBe('FULL');
  expect(url.searchParams.get('preview')).toBe('3');
  expect(url.searchParams.get('limit')).toBe('20');
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer viewer');
});

test('preparing, unavailable and unproven empty previews remain distinct from a proven empty Collection', async () => {
  for (const state of ['preparing', 'unavailable'] as const) {
    const html = await preview({ ...collection, preview: { state } });
    expect(html).toContain(
      state === 'preparing' ? m.library_collection_preview_preparing() : m.library_collection_preview_unavailable(),
    );
    expect(html).not.toContain(m.library_collection_empty());
  }
  const unproven = await preview({ ...collection, memberCount: undefined, preview: { state: 'loaded', members: [] } });
  expect(unproven).toContain(m.library_collection_preview_unavailable());
  const empty = await preview({ ...collection, memberCount: 0, preview: { state: 'loaded', members: [] } });
  expect(empty).toContain(m.library_collection_empty());
  expect(empty).not.toContain(m.library_collection_preview_unavailable());
});
