import { expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cover, coverRatio, parseListPresentation, type CoverSummary } from '@rezics/ui/cover';
import { CoverCard, CoverGrid } from '@rezics/ui/cover-card';
import { MemberListRow } from '@rezics/ui/list-presentation';
import { CoverList } from '../src/features/pages/cover-list';
import type { Item, RowValue } from '../src/features/pages/overview';
import { releasedListPresentation } from '../src/media/type-presentation';
import { ResultList, type Fact, type ResultHit } from '../src/search/results';
import { readSearchPage } from '../src/search/search-request';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cases = [
  ['schema:Book', '3:4'],
  ['bf:Instance', '3:4'],
  ['schema:ComicSeries', '3:4'],
  ['wd:Q21198342', '3:4'],
  ['schema:PublicationVolume', '3:4'],
  ['schema:Movie', '16:9'],
  ['schema:TVSeries', '16:9'],
  ['schema:TVSeason', '16:9'],
  ['schema:Episode', '16:9'],
  ['rezics:AnimeRelease', '16:9'],
  ['schema:MusicAlbum', '1:1'],
  ['schema:Recipe', '16:9'],
  ['type:Unknown', '1:1'],
] as const;
const hit = (type: string, n = 1): ResultHit => ({ id: id(n), type, labels: { en: `Member ${n}` } });
const image: CoverSummary = {
  media: id(900),
  width: 1600,
  height: 900,
  variants: [{ format: 'webp', width: 640 }],
  placeholder: { color: '#465c72', thumbhash: '' },
  focalPoint: { x: 0.2, y: 0.7 },
  credit: { rightsHolder: 'Fixture owner', via: { name: 'Fixture source', url: 'https://example.org' } },
};
const value: RowValue = {
  locale: 'en',
  link: ({ children, ...props }) => createElement('a', props, children),
  reader: { spoilerLevel: 0, suitability: 'blur' },
  labels: {
    spoilerShow: 'Show',
    documentSpoiler: 'Reveal',
    cover: { withheld: 'Sensitive cover', reveal: 'Show cover', credit: 'Cover credit', via: 'via' },
  },
  unlabelled: 'Unlabelled',
  spoilerShow: 'Show',
};
const item = (member: ResultHit): Item => ({
  id: member.id,
  type: member.type,
  label: { text: member.labels.en!, lang: 'en' },
  summary: member.summary,
  notes: [],
  gated: false,
});
const ratios = (html: string) => [...html.matchAll(/data-ratio="([^"]+)"/gu)].map((match) => match[1]);
const properties = (html: string) => [...html.matchAll(/data-property="([^"]+)"/gu)].map((match) => match[1]);
const renderResults = (hits: ResultHit[], extra: Partial<Parameters<typeof ResultList>[0]> = {}) =>
  renderToStaticMarkup(createElement(ResultList, { hits, locale: 'en', hitTypes: {}, yearProperties: [], ...extra }));

test('actual Search rows and cover-list cards use real member Types without a universal list frame', () => {
  const hits = cases.map(([type], index) => hit(type, index + 1));
  const rows = renderResults(hits, { hitTypes: { 'type:Unknown': { en: 'Book Movie Music Recipe' } } });
  expect(ratios(rows)).toEqual(cases.map(([, ratio]) => ratio));
  expect(rows.match(/data-slot="list-row"/gu)).toHaveLength(hits.length);
  expect(rows.match(/data-state="placeholder"/gu)).toHaveLength(hits.length);
  expect(rows).toContain('line-clamp-2');
  expect(rows).toContain('w-32 sm:w-48');
  for (const member of hits) expect(rows).toContain(`/en/subjects/${member.id}/`);

  const cards = renderToStaticMarkup(createElement(CoverList, { items: hits.map(item), value, label: 'Members' }));
  // Unknown cards use the composition fallback; the real known member geometry still wins.
  expect(ratios(cards).slice(0, -1)).toEqual(cases.slice(0, -1).map(([, ratio]) => ratio));
  expect(cards.match(/data-slot="cover-card"/gu)).toHaveLength(hits.length);
  expect(cards).not.toContain('Book Movie Music Recipe');
});

test('standalone Cover keeps legacy coverRatio and explicit ratio while member cards opt into list geometry', () => {
  const subject = { id: id(1), title: 'Book', types: ['schema:Book'] };
  const src = () => '/variant';
  expect(coverRatio(subject.types)).toBe('5:7');
  expect(ratios(renderToStaticMarkup(createElement(Cover, { subject, cover: null, src, size: 'md' })))).toEqual([
    '5:7',
  ]);
  expect(
    ratios(renderToStaticMarkup(createElement(Cover, { subject, cover: null, src, size: 'md', ratio: '2:3' }))),
  ).toEqual(['2:3']);
  const card = createElement(CoverCard, { title: 'Book', cover: { subject, cover: null, src } });
  expect(ratios(renderToStaticMarkup(createElement(CoverGrid, { ratio: '1:1', children: card })))).toEqual(['3:4']);
});

test('the optional adapter consumes effective whole objects, clears facts and rejects invalid annotations', () => {
  const releaseTypes = {
    'schema:Book': {
      properties: ['schema:author'],
      listPresentation: { imageAspect: 'portrait', keyFacts: ['schema:author'] },
    },
    // This is an effective compiled child object, not an authoring inheritance candidate.
    'bf:Instance': {
      bases: ['schema:Book'],
      properties: ['schema:author'],
      listPresentation: { imageAspect: 'square', keyFacts: [] },
    },
  };
  expect(releasedListPresentation(['bf:Instance', 'schema:Book'], releaseTypes)).toEqual({
    imageAspect: 'square',
    keyFacts: [],
  });
  expect(releasedListPresentation(['schema:Book'], { 'schema:Book': { properties: [] } })).toBeUndefined();
  expect(
    releasedListPresentation(['type:Child'], { 'type:Child': { bases: ['schema:Book'] }, ...releaseTypes }),
  ).toBeUndefined();
  for (const annotation of [
    { imageAspect: 'wide', keyFacts: [] },
    { imageAspect: 'portrait', keyFacts: ['schema:author', 'schema:author'] },
    { imageAspect: 'portrait', keyFacts: ['author'] },
    { imageAspect: 'portrait', keyFacts: Array.from({ length: 5 }, (_, n) => `schema:p${n}`) },
    { imageAspect: 'portrait', keyFacts: [], coverRatio: '3:4' },
  ])
    expect(parseListPresentation(annotation)).toBeUndefined();
  expect(
    releasedListPresentation(['schema:Book'], {
      'schema:Book': {
        properties: ['schema:author'],
        listPresentation: { imageAspect: 'portrait', keyFacts: ['schema:duration'] },
      },
    }),
  ).toBeUndefined();
});

test('both actual callers honor supplied released geometry and ordered facts, without inventing unsupplied data', () => {
  const configured = ['schema:genre', 'schema:duration', 'schema:author', 'schema:datePublished'];
  const releaseTypes = {
    'schema:Movie': { properties: configured, listPresentation: { imageAspect: 'square', keyFacts: configured } },
  };
  const listPresentationFor = (types: readonly string[]) => releasedListPresentation(types, releaseTypes);
  const facts: Record<string, Fact[]> = {
    'schema:datePublished': [{ kind: 'time', year: 2020 }],
    'schema:author': [{ kind: 'item', id: id(100), labels: { ja: '作者' } }],
    'schema:duration': [{ kind: 'quantity', amount: 90, unit: 'min' }],
    'schema:genre': [{ kind: 'code', value: 'Fable' }],
    'schema:unselected': [{ kind: 'code', value: 'Do not disclose this value' }],
  };
  const member = { ...hit('schema:Movie'), facts };
  for (const html of [
    renderResults([member], { listPresentationFor }),
    renderToStaticMarkup(
      createElement(CoverList, {
        items: [{ ...item(member), notes: ['Related work'] }],
        value,
        label: 'Members',
        listPresentationFor,
        memberFacts: { [member.id]: facts },
      }),
    ),
  ]) {
    expect(ratios(html)).toEqual(['1:1']);
    expect(properties(html)).toEqual(configured);
    for (const text of ['Fable', '90 min', '作者', '2020']) expect(html).toContain(text);
    expect(html).toContain('lang="ja"');
    expect(html).not.toContain('Do not disclose this value');
  }
  expect(renderResults([hit('schema:Movie')], { listPresentationFor })).not.toContain(
    'data-slot="member-list-row-facts"',
  );
  expect(
    renderResults([{ ...member, listPresentation: { imageAspect: 'landscape', keyFacts: [] } }], {
      listPresentationFor,
    }),
  ).not.toContain('Fable');
});

test('supplied facts retain the four-value and three-per-property bounds and factual guards', () => {
  const member: ResultHit = {
    ...hit('schema:Movie'),
    listPresentation: { imageAspect: 'landscape', keyFacts: ['schema:genre', 'schema:duration'] },
    facts: {
      'schema:genre': ['First', 'Second', 'Third', 'Fourth must stay hidden'].map((value) => ({ kind: 'code', value })),
      'schema:duration': [
        { kind: 'quantity', amount: 90, unit: 'min' },
        { kind: 'quantity', amount: 91, unit: 'min' },
      ],
    },
  };
  const html = renderResults([member]);
  expect(properties(html)).toEqual(['schema:genre', 'schema:genre', 'schema:genre', 'schema:duration']);
  expect(html).not.toContain('Fourth must stay hidden');
  expect(html).not.toContain('91 min');
  const invalid = renderResults([
    {
      ...member,
      publicRating: { score: NaN },
      facts: { 'schema:duration': [{ kind: 'quantity', amount: Infinity, unit: 'min' }] },
    },
  ]);
  expect(invalid).not.toContain('Infinity');
  expect(invalid).not.toContain('NaN');
  expect(invalid).not.toContain('data-slot="member-list-row-facts"');

  const series = renderResults([
    {
      ...hit('schema:TVSeries'),
      facts: {
        'schema:numberOfEpisodes': [{ kind: 'quantity', amount: 12, unit: '' }],
        'schema:duration': [{ kind: 'quantity', amount: 24, unit: 'min' }],
      },
    },
  ]);
  expect(properties(series)).toEqual(['schema:numberOfEpisodes']);
  expect(series).not.toContain('24 min');
  const absent = renderResults([hit('schema:TVSeries')]);
  expect(absent).not.toContain('data-property');
  expect(absent).not.toContain('data-slot="year"');
});

test('missing and suitability-withheld images retain their Type frame without requesting image bytes', () => {
  const src = mock(() => '/private-image-variant');
  const subject = { id: id(1), title: 'Movie', types: ['schema:Movie'] };
  for (const cover of [null, { ...image, withheld: 'suitability' as const }]) {
    const html = renderToStaticMarkup(
      createElement(MemberListRow, { href: '/movie', subject, cover, src, title: 'Movie', titleLang: 'en' }),
    );
    expect(ratios(html)).toEqual(['16:9']);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<source');
    expect(html).not.toContain('/private-image-variant');
    expect(html).toContain('lang="en"');
    expect(html).toContain(cover ? 'Show cover' : 'data-state="placeholder"');
  }
  expect(src).not.toHaveBeenCalled();
  const member = {
    ...hit('schema:Movie'),
    summary: { id: id(1), type: 'schema:Movie', cover: { ...image, withheld: 'suitability' as const } },
  };
  expect(renderResults([member])).not.toContain('<img');
  expect(
    renderToStaticMarkup(createElement(CoverList, { items: [item(member)], value, label: 'Members' })),
  ).not.toContain('<img');
});

test('list frames preserve fitting, focal point, decorative alt and the original credit descriptor', () => {
  const subject = { id: id(1), title: 'Book', types: ['schema:Book'] };
  const html = renderToStaticMarkup(
    createElement(MemberListRow, { href: '/book', subject, cover: image, src: () => '/variant', title: 'Book' }),
  );
  expect(html).toContain('data-fit="contain"');
  expect(html).toContain('object-position:20% 70%');
  expect(html).toContain('alt=""');
  expect(html).toContain('loading="lazy"');
  expect(image.credit?.rightsHolder).toBe('Fixture owner');
  const unknown = { id: id(2), title: 'Unknown', types: ['type:Unknown'] };
  expect(
    ratios(
      renderToStaticMarkup(
        createElement(MemberListRow, {
          href: '/unknown',
          subject: unknown,
          cover: null,
          src: () => '',
          title: 'Unknown',
          ratio: '2:3',
        }),
      ),
    ),
  ).toEqual(['2:3']);
});

test('current-page rendering retains the page cap and adds zero reads at growing catalogue sizes', async () => {
  const enrichmentReads = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
  try {
    for (const catalogueSize of [1, 100, 10_000]) {
      const page = Array.from({ length: Math.min(catalogueSize, 100) }, (_, n) =>
        hit(cases[n % cases.length]![0], n + 1),
      );
      const send = mock(async (request: { limit: number }) => {
        expect(request.limit).toBe(100);
        return { status: 200, hits: page, next: catalogueSize > 100 ? 'opaque-cursor' : null };
      });
      const { response } = await readSearchPage({ limit: 100, sort: 'relevance' }, send);
      const html = renderResults(response.hits);
      const cards = renderToStaticMarkup(
        createElement(CoverList, { items: response.hits.map(item), value, label: 'Current page' }),
      );
      expect(send).toHaveBeenCalledTimes(1);
      expect(html.match(/data-slot="list-row"/gu)).toHaveLength(page.length);
      expect(cards.match(/data-slot="cover-card"/gu)).toHaveLength(page.length);
      expect(html).not.toContain('opaque-cursor');
    }
    expect(enrichmentReads).not.toHaveBeenCalled();
  } finally {
    enrichmentReads.mockRestore();
  }
});
