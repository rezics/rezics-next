import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { Release } from '../src/subject/definitions';
import { collectionFilterAddress } from '../src/library/collection-filter-params';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/en/collections/mixed'),
  setResponseHeader() {},
  setResponseStatus() {},
}));
mock.module('cloudflare:workers', () => ({ env: { COLLECTION_FILTERS: true } }));
const transport = await import('../src/kernel/client');
const definitions = await import('../src/subject/definitions');
const { CollectionMemberOccurrenceDetails } = await import('../src/library/collection-member-details');
const { readCollectionPage } = await import('../src/library/collection-queries');
const types = ['example:VN', 'example:Anime', 'schema:Book'];
const properties = ['example:playTime', 'example:episodes', 'schema:wordCount'];
const release: Release = {
  digest: 'mixed-release',
  types: Object.fromEntries(types.map((type, index) => [type, { facets: [properties[index]!] }])),
  properties: Object.fromEntries(properties.map((property) => [property, { datatype: 'quantity', units: ['1'] }])),
};
const id = '0192f3a0-6c1e-7b2a-9d4e-000000000004';
const rows = types.map((type, index) => ({
  kind: 'dynamic',
  subjectId: `original-${index}`,
  subject: { id: `subject-${index}`, type, label: `Title ${index}` },
  facts: { [properties[index]!]: [{ kind: 'quantity', amount: index + 10, unit: '1' }] },
}));
const reads: URL[] = [];
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const url = new URL(new Request(input, init).url);
    reads.push(url);
    return Response.json(
      url.pathname.endsWith('/members')
        ? { members: rows, next: null }
        : {
            collection: {
              id,
              title: 'Mixed',
              membershipKind: 'curated',
              curatorAccountId: 'curator',
              visibility: 'public',
              revision: 1,
              memberCount: 3,
              description: null,
              presentationKind: null,
              presentationKindSource: 'mixed',
              updatedAt: '2026-11-01T00:00:00Z',
            },
          },
    );
  },
});
const spies = [
  spyOn(transport, 'kernelClient').mockReturnValue(client),
  spyOn(definitions, 'readRelease').mockResolvedValue(release),
  spyOn(definitions, 'nameSubjectTypes').mockImplementation(async (subjects) => {
    for (const subject of subjects) if (subject) subject.typeLabel = subject.type;
  }),
];
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
  mock.restore();
});

test('mixed range filters reopen without a Book profile and name every returned member Type', async () => {
  const search = { 'r.example:episodes': '12,' };
  const page = await readCollectionPage({ data: { id, search } });
  if ('preparing' in page) throw new Error('Expected curated Collection');
  expect(page.filterStatus).toBeUndefined();
  expect(page.filterType).toBeUndefined();
  expect(page.presentationKind).toBeNull();
  expect(page.filterProperties?.map((property) => property.id)).toEqual(properties);
  expect(page.filteredMembers?.map((member) => member.subject?.typeLabel)).toEqual(types);
  const member = page.filteredMembers![1]!;
  const html = renderToStaticMarkup(
    createElement(CollectionMemberOccurrenceDetails, {
      member,
      position: 2,
      scope: 'filtered-first',
      pageKey: 'mixed',
      noteStateKey: 'anime',
      noteExpanded: false,
      onNoteExpandedChange() {},
    }),
  );
  expect(html).toContain(types[1]!);
  expect(html).toContain('example:episodes');
  expect(html).not.toContain('data-collection-type-state="unavailable"');
  const address = collectionFilterAddress(
    'en',
    id,
    {},
    { 'example:episodes': { from: 12 } },
    {},
    undefined,
    new URLSearchParams({ ...search, layout: 'grid', cursor: 'same-page' }),
  );
  const params = new URL(address, 'https://site.test').searchParams;
  expect(params.has('type')).toBe(false);
  expect(params.get('cursor')).toBe('same-page');
  const reopened = await readCollectionPage({ data: { id, search: Object.fromEntries(params) } });
  expect(reopened.filter).toEqual(page.filter);
  const cleared = new URL(collectionFilterAddress('en', id, {}, {}, {}, undefined, params), 'https://site.test');
  expect([...cleared.searchParams]).toEqual([['layout', 'grid']]);
  expect(
    reads.filter((url) => url.pathname.endsWith('/members')).map((url) => JSON.parse(url.searchParams.get('filter')!)),
  ).toEqual([page.filter, page.filter]);
});
