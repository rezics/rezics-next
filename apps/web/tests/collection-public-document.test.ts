import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadEditableCollectionPage } from '../src/library/collection-load';
import { collectionPublicDocument, collectionPublicItemList } from '../src/library/collection-public-document';
import { locales } from '../src/paraglide/runtime.js';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.com' } }));
const { collectionPageHead } = await import('../src/library/collection-page');
const context = { origin: 'https://rezics.com', locale: 'en', path: '/collections/public-list' } as const;

async function publicPage() {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.has('authorization')).toBe(false);
      return Response.json(new URL(request.url).pathname.endsWith('/members') ? members : collection);
    },
  });
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://rezics.com/en/collections/public-list'),
    {},
    { id: collection.collection.id },
    'anonymous',
  );
  if ('preparing' in page) throw new Error('Expected a curated page');
  return page;
}

test('Only the actual complete first unfiltered public curated view exports the same safe schema.org ItemList already permitted in its head', async () => {
  const page = await publicPage();
  for (const locale of locales) {
    const localized = { ...context, locale };
    const head = JSON.parse(collectionPageHead(page, localized).scripts![0]!.children!);
    const file = collectionPublicDocument(page, localized)!;
    const { '@context': schemaContext, ...exported } = JSON.parse(file.text);
    expect(schemaContext).toBe('https://schema.org');
    expect(exported).toEqual(head['@graph'][0].mainEntity);
    expect(file.mediaType).toBe('application/ld+json');
    expect(file.filename).toBe(`collection-${page.id}.jsonld`);
    expect(Object.keys(exported)).toEqual(['@type', 'numberOfItems', 'itemListOrder', 'itemListElement']);
    expect(exported.itemListElement[0]).toEqual({
      '@type': 'ListItem',
      position: 1,
      url: `https://rezics.com/${locale}/subjects/01a17a3b-6c01-77c8-94fd-810a3ae73369/snow-country`,
    });
    expect(file.text).not.toMatch(
      /curator|revision|note|visibility|@graph|BreadcrumbList|CollectionPage|Read it first/,
    );
  }
});

test('missing evidence, owner/private, unlisted, filtered, later, pending and dynamic payloads fail closed', async () => {
  const page = await publicPage();
  const missing = (
    key: 'memberState' | 'publicExport' | 'firstPage' | 'next' | 'disclosedVisibility' | 'visibility',
  ) => {
    const copy = { ...page } as Partial<typeof page>;
    delete copy[key];
    return { ...copy, id: page.id, members: page.members };
  };
  const variants = [
    ...(['memberState', 'publicExport', 'firstPage', 'next', 'disclosedVisibility', 'visibility'] as const).map(
      missing,
    ),
    { ...page, visibility: 'public' as const },
    { ...page, visibility: 'private' as const },
    { ...page, disclosedVisibility: 'unlisted' as const },
    { ...page, publicExport: false, memberCount: null },
    { ...page, publicExport: false, members: [] },
    { ...page, firstPage: false },
    { ...page, next: 'next-page' },
    { ...page, cursor: 'later-page' },
    { ...page, memberState: 'preparing' as const },
    { ...page, memberState: 'unavailable' as const },
    { ...page, filterActive: true },
    { ...page, filter: { and: [] } },
    { ...page, filterIgnored: ['ignored'] },
    { ...page, filterStatus: 'unsupported' as const },
    { ...page, filterStatus: 'preparing' as const },
    { ...page, filterStatus: 'failed' as const },
    { ...page, preparing: false },
  ];
  for (const variant of variants) {
    expect(collectionPublicDocument(variant, context)).toBeNull();
    const headPage = { ...variant, title: page.title, description: page.description, curator: page.curator };
    expect(JSON.stringify(collectionPageHead(headPage, context).scripts)).not.toContain('ItemList');
  }
  expect(collectionPublicDocument(page, context, true)).toBeNull();
  // An unknown native total supplies no completeness evidence; an explicit certificate still suffices.
  const unknownCount = { ...page, memberCount: null };
  expect(collectionPublicItemList(unknownCount, context)?.numberOfItems).toBe(4);
  expect(collectionPublicItemList({ ...page, members: [] }, context)?.numberOfItems).toBe(0);
});

test('only disclosed subject URLs and original occurrence positions survive, with no private fields or native total', async () => {
  const page = await publicPage();
  const safe = page.members[0]!;
  const payload = {
    ...page,
    memberCount: 987654,
    curatorAccountId: 'private-account',
    source: 'private-source',
    transaction: 'private-transaction',
    pins: ['private-pin'],
    members: [safe, { ...safe, id: 'hidden-occurrence', subject: null, note: 'hidden-note' }, safe],
  };
  const file = collectionPublicDocument(payload, context)!;
  const exported = JSON.parse(file.text);
  expect(exported.numberOfItems).toBe(2);
  expect(exported.itemListElement).toEqual([
    {
      '@type': 'ListItem',
      position: 1,
      url: 'https://rezics.com/en/subjects/01a17a3b-6c01-77c8-94fd-810a3ae73369/snow-country',
    },
    {
      '@type': 'ListItem',
      position: 3,
      url: 'https://rezics.com/en/subjects/01a17a3b-6c01-77c8-94fd-810a3ae73369/snow-country',
    },
  ]);
  expect(file.text).not.toMatch(/987654|private|hidden|note|revision|source|transaction|pins/);
  const current = collectionPublicDocument({ ...page, members: page.members.slice(1) }, context)!;
  expect(current.text).not.toContain('snow-country');
});

test('filenames stay bounded and URLs require the same canonical HTTP origin', async () => {
  const page = await publicPage();
  const file = collectionPublicDocument({ ...page, id: '../<script>\\'.repeat(100) }, context)!;
  expect(file.filename).toMatch(/^collection-[a-zA-Z0-9_-]{1,80}\.jsonld$/);
  expect(file.text).not.toContain('<');
  for (const origin of [
    'javascript:alert(1)',
    'https://rezics.com/path',
    'https://user:pass@rezics.com',
    '//evil.test',
  ]) {
    expect(() => collectionPublicDocument(page, { ...context, origin })).toThrow('PUBLIC_ORIGIN');
  }
});
