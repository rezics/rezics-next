import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { locales } from '../src/paraglide/runtime.js';
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

function collectionCard(id: string, title: string, description: string | null) {
  return {
    kind: 'collection' as const,
    id,
    destination: `/collections/${id}`,
    title,
    description,
    visibility: 'public' as const,
    revision: 1,
    presentationKind: null,
    presentationKindSource: 'owner' as const,
    cover: {
      media: id,
      width: 600,
      height: 900,
      placeholder: { thumbhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', color: '#225577' },
      variants: [{ format: 'webp' as const, width: 320 }],
      focalPoint: null,
      credit: {
        rightsHolder: 'Mira',
        via: { name: 'Mira', url: 'https://example.test' },
        license: 'CC BY',
        obligations: [],
      },
    },
    coverSource: 'owner' as const,
    membershipKind: 'curated' as const,
    memberCount: 7,
    orderEpoch: 2,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
  };
}

function mixedPage(): DiscoveryPage {
  const page = structuredClone(discoveryExample);
  const sameId = page.hits[0]!.key.id;
  const subjectId = page.hits[3]!.key.id;
  page.hits[3] = {
    ...page.hits[3]!,
    descriptions: { en: 'A current description for this release.' },
    facts: { 'schema:genre': [{ kind: 'item', id: subjectId, labels: { en: 'Fantasy' } }] },
    figure: {
      questionId: '00000000-0000-7000-8000-000000000001',
      populationId: '00000000-0000-8000-8000-000000000000',
      scale: { min: 0, max: 100, displayStep: 1 },
      count: 12,
      state: 'ready',
      mean: 8,
      score: 7.8,
    },
    listPresentation: { imageAspect: 'landscape', keyFacts: ['schema:genre'] },
  };
  page.hits.push(
    {
      key: { owner: 'library', kind: 'collection', route: 3, id: sameId },
      summary: {
        kind: 'collection',
        value: {
          id: sameId,
          title: 'Mira’s public shelf',
          description: 'A current public collection.',
          card: collectionCard(sameId, 'Mira’s public shelf', 'A current public collection.'),
        },
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
  const subjects = page.hits.filter((hit) => hit.summary.kind === 'subject');
  page.viewerFacts = {
    state: 'current',
    question: {
      id: '00000000-0000-7000-8000-000000000001',
      revision: 1,
      grain: 'work',
      scale: { min: 0, max: 100, displayStep: 1 },
      meaning: 'Standard rating',
    },
    rows: subjects.map((hit, index) => ({
      rowKey: discoveryKey(hit),
      subjectId: hit.key.id,
      entry:
        index === 0
          ? { state: 'present' as const, incarnationId: hit.key.id, entryState: 'in_progress', revision: 1 }
          : { state: 'absent' as const },
      vote:
        index === 0
          ? {
              state: 'present' as const,
              questionId: '00000000-0000-7000-8000-000000000001',
              questionRevision: 1,
              units: 0,
              revision: 1,
            }
          : {
              state: 'absent' as const,
              questionId: '00000000-0000-7000-8000-000000000001',
              questionRevision: 1,
            },
    })),
  };
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
  expect(html).toContain('A current description for this release.');
  expect(html).toContain('Fantasy');
  expect(html).toContain('data-slot="public-rating-figure"');
  expect(html).toContain('7 items');
  expect(html).toContain('Your rating: 0');
  expect(html).toContain('In progress');
  expect(html).toContain('Not rated');
  expect(html).toContain('Not in your Library.');
  expect(html).toContain('A supplied current excerpt.');
  expect(html).toContain('Mira’s Atlas');
  expect(html).toContain('Public Reading');
  expect(html.indexOf('data-discovery-collection')).toBeLessThan(html.indexOf('data-discovery-review'));
  expect(html.indexOf('data-discovery-review')).toBeLessThan(html.indexOf('data-discovery-space'));
  expect(calls).toEqual([request]);
  expect(html).not.toMatch(/rule|privateVote|realmRank|ratingFigure/i);
});

test('an unavailable private envelope hides prior viewer rows but keeps public results and a localized notice', async () => {
  const page = mixedPage();
  page.viewerFacts = { state: 'unavailable', reason: 'currentness', retryable: true };
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page }, locale: 'en' }),
  );
  expect(html).toContain('Your Library and rating details are unavailable.');
  expect(html).toContain('A current public collection.');
  expect(html).not.toContain('Your rating:');
});

test('current viewer state and its unavailable notice render in every supported locale', () => {
  const current = mixedPage();
  const unavailable = structuredClone(current);
  unavailable.viewerFacts = { state: 'unavailable', reason: 'identity', retryable: true };
  for (const locale of locales) {
    const currentHtml = renderToStaticMarkup(
      createElement(DiscoveryResults, { state: { status: 'ready', page: current }, locale }),
    );
    const unavailableHtml = renderToStaticMarkup(
      createElement(DiscoveryResults, { state: { status: 'ready', page: unavailable }, locale }),
    );
    expect(currentHtml).toContain('data-slot="discovery-viewer-facts"');
    expect(unavailableHtml).toContain('role="status"');
    expect(currentHtml + unavailableHtml).not.toContain('undefined');
  }
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
