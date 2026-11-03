import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import {
  discoveryKey,
  parseDiscoveryPage,
  readDiscovery,
  type DiscoveryPage,
  type DiscoveryRequest,
} from '../src/search/discovery';

const request: DiscoveryRequest = { representation: 'discovery-v1', text: 'Mira', limit: 100, languages: ['en'] };

function mixedPage(): DiscoveryPage {
  const page = structuredClone(discoveryExample);
  const sameId = page.hits[0]!.key.id;
  const subjectId = page.hits[3]!.key.id;
  page.hits.push(
    {
      key: { owner: 'library', kind: 'collection', route: 3, id: sameId },
      summary: {
        kind: 'collection',
        value: { id: sameId, title: 'Mira’s public shelf', description: 'A current public collection.' },
      },
    },
    {
      key: { owner: 'content', kind: 'review', route: 4, id: sameId },
      summary: {
        kind: 'review',
        value: {
          id: sameId,
          kind: 'review',
          title: 'Notes on the atlas',
          author: { displayName: 'Mira Reader', handle: 'mira-reader' },
          excerpt: 'A supplied current excerpt.',
          subject: { id: subjectId, title: 'Mira’s Atlas' },
        },
      },
    },
    {
      key: { owner: 'community', kind: 'space', route: 5, id: sameId },
      summary: {
        kind: 'space',
        value: {
          id: sameId,
          title: 'Mira Reading Room',
          address: 'mira-reading-room',
          summary: 'A supplied Space summary.',
          realm: { id: subjectId, title: 'Public Reading' },
        },
      },
    },
  );
  page.kinds.values.push(
    {
      id: 'collection',
      labels: { en: 'Collection' },
      icon: 'collection',
      count: { kind: 'collection', value: 8, exact: true },
    },
    { id: 'review', labels: { en: 'Review' }, icon: 'review', count: { kind: 'review', value: 12, exact: false } },
    { id: 'space', labels: { en: 'Space' }, icon: 'space', count: { kind: 'space', unavailable: true } },
  );
  return page;
}

test('one mixed native page renders the five kinds in order with current summaries and canonical owner routes', async () => {
  const page = mixedPage();
  const calls: DiscoveryRequest[] = [];
  const { discovery } = await readDiscovery(request, async (body) => {
    calls.push(body);
    return { status: 200, data: page };
  });
  expect(discovery.status).toBe('ready');
  if (discovery.status !== 'ready') throw new Error('Mixed Search page was unavailable');

  const keys = discovery.page.hits.map(discoveryKey);
  expect(new Set(keys).size).toBe(7);
  expect(keys[0]).toBe(JSON.stringify(['semantic', 'schema:Person', 0, page.hits[0]!.key.id]));
  expect(keys[4]).toBe(JSON.stringify(['library', 'collection', 3, page.hits[0]!.key.id]));
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { state: discovery, locale: 'en' }));
  expect(html.match(/data-slot="list-row"/g)).toHaveLength(7);
  expect(html).toContain('/en/collections/00000000-0000-4000-8000-000000000811');
  expect(html).toContain('/en/threads/00000000-0000-4000-8000-000000000811/notes-on-the-atlas');
  expect(html).toContain('/en/subjects/00000000-0000-4000-8000-000000000813/');
  expect(html).toContain('/en/spaces/mira-reading-room');
  expect(html).toContain('A current public collection.');
  expect(html).toContain('A supplied current excerpt.');
  expect(html).toContain('Mira’s Atlas');
  expect(html).toContain('Public Reading');
  expect(html.indexOf('data-discovery-collection')).toBeLessThan(html.indexOf('data-discovery-review'));
  expect(html.indexOf('data-discovery-review')).toBeLessThan(html.indexOf('data-discovery-space'));
  expect(calls).toEqual([request]);
  expect(html).not.toMatch(/rule|privateVote|realmRank|ratingFigure/i);
});

test('unknown kinds, owner or summary mismatches, malformed pages and missing hydration fail the whole page', async () => {
  const page = mixedPage();
  const collection = page.hits.find((hit) => hit.summary.kind === 'collection');
  if (!collection || collection.summary.kind !== 'collection') throw new Error('Expected a Collection hit');
  const invalidPages: unknown[] = [
    {
      ...page,
      hits: [
        ...page.hits.slice(0, 4),
        { ...collection, summary: { kind: 'future-kind', value: {} } },
        ...page.hits.slice(5),
      ],
    },
    {
      ...page,
      hits: [
        ...page.hits.slice(0, 4),
        { ...collection, key: { ...collection.key, owner: 'content' } },
        ...page.hits.slice(5),
      ],
    },
    { hits: 'not-a-page', kinds: page.kinds, next: page.next, as_of: page.as_of },
    { ...page, hits: [...page.hits.slice(0, 4), { ...collection, summary: null }, ...page.hits.slice(5)] },
    {
      ...page,
      hits: [
        ...page.hits.slice(0, 4),
        {
          ...collection,
          summary: { ...collection.summary, value: { ...collection.summary.value, rule: { private: true } } },
        },
        ...page.hits.slice(5),
      ],
    },
  ];
  for (const malformed of invalidPages) {
    expect(parseDiscoveryPage(malformed)).toBeUndefined();
    const { discovery } = await readDiscovery(request, async () => ({ status: 200, data: malformed }));
    expect(discovery.status).toBe('unavailable');
    const html = renderToStaticMarkup(createElement(DiscoveryResults, { state: discovery, locale: 'en' }));
    expect(html).not.toContain('Mira’s public shelf');
    expect(html).not.toContain('data-slot="list-row"');
  }
  const failedHydration = await readDiscovery(request, async () => ({ status: 503, error: { code: 'unavailable' } }));
  expect(failedHydration.discovery.status).toBe('unavailable');
});

test('sparse and empty pages retain native continuation and supplied kind-count evidence', async () => {
  const page = mixedPage();
  const sparse = { ...page, hits: [page.hits[4]!], next: 'native-next-page' };
  const sparseRead = await readDiscovery(request, async () => ({ status: 200, data: sparse }));
  expect(sparseRead.discovery.status).toBe('ready');
  if (sparseRead.discovery.status !== 'ready') throw new Error('Sparse Search page was unavailable');
  expect(sparseRead.discovery.page.next).toBe('native-next-page');
  expect(sparseRead.discovery.page.kinds.values.map(({ id, count }) => [id, count])).toEqual(
    page.kinds.values.map(({ id, count }) => [id, count]),
  );

  const empty = { ...page, hits: [], next: 'native-empty-continuation' };
  const emptyRead = await readDiscovery(request, async () => ({ status: 200, data: empty }));
  expect(emptyRead.discovery.status).toBe('ready');
  if (emptyRead.discovery.status !== 'ready') throw new Error('Empty Search page was unavailable');
  expect(emptyRead.discovery.page.hits).toEqual([]);
  expect(emptyRead.discovery.page.next).toBe('native-empty-continuation');
  expect(emptyRead.discovery.page.kinds.values[3]?.count).toEqual({ kind: 'collection', value: 8, exact: true });
  const html = renderToStaticMarkup(createElement(DiscoveryResults, { state: emptyRead.discovery, locale: 'en' }));
  expect(html).not.toContain('data-slot="list-row"');
});
