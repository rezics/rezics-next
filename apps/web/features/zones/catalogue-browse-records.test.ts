import { expect, test } from 'bun:test';
import type { ZoneContext } from '@rezics/zone-sdk';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { catalogueContractSample, catalogueLabels, cataloguePersonas, catalogueRecords, missingCatalogueStates } from './catalogue-browse-fixtures.ts';
import { catalogueRequest, catalogueSample, readCatalogueStory } from './catalogue-browse-records.ts';
import { catalogueBrowseQuery, applyCatalogueYear } from './catalogue-browse.tsx';
import { catalogueYearCondition } from './catalogue-year.ts';
import { zoneMessagesFor } from './fixtures.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import { uiLocales } from '../../i18n/define.ts';
import { presetTokens } from './presentation.ts';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZoneBrowse } from './browse.tsx';
import { direction } from '@rezics/main/language';
import { realmHref, siteHref } from '../realm/route.ts';
import { browseHref } from './browse-state.ts';

const zone = (realm: string): ZoneContext => ({
  slug: null, realm: `https://rezics.com/id/${realm}`, name: { value: 'Catalogue', lang: 'en', dir: direction('en', 'Catalogue') },
  description: null, icon: null, hero: null, locale: 'en',
  tokens: presetTokens.editorial,
  links: { home: siteHref('en', realm, []), browse: siteHref('en', realm, ['browse']), works: siteHref('en', realm, ['browse']),
    discussions: realmHref('en', realm, 'discussions'), decisions: realmHref('en', realm, 'decisions'), about: realmHref('en', realm, 'about') },
});

for (const slug of ['books', 'visual-novels', 'manga', 'anime'] as const) {
  for (const persona of cataloguePersonas) {
    test(`${slug}/${persona}: the typed reader preserves this persona's inventory, credits, counts and continuation`, async () => {
      const record = catalogueRecords[slug]!;
      const before = JSON.stringify(record);
      const labels = catalogueLabels[slug];
      const label = labels.populated;
      const sample = catalogueSample(record, persona, label);
      const request = catalogueRequest(sample.path);
      const facets = record.personas[persona].find(item => item.path === '/v1/facets');
      const replay = recordedFetch(record, persona, [{ label, state: 'populated' },
        ...(facets ? [{ label: facets.label, state: 'populated' as const }] : [])], { pathPrefix: BFF_PREFIX });
      try {
        const main = browserMainApi('https://recorded.invalid', { anonymous: persona === 'visitor', fetcher: replay.fetcher });
        const page = await readCatalogueStory(main, sample.path, zone(request.realm), 'en', zoneMessagesFor('en'), !!facets);
        expect(page.ok).toBe(true);
        if (!page.ok) throw new Error(`Recorded read failed: ${page.failure}`);
        const answer = sample.answer as ZoneBrowsePage;
        expect(page.data.items.map(item => item.id)).toEqual(answer.items.map(item => item.id));
        expect(page.data.items.map(item => item.title?.value)).toEqual(answer.items.map(item => item.title.value));
        expect(page.data.items.map(item => item.author?.value ?? null))
          .toEqual(answer.items.map(item => item.primaryCredits?.[0]?.displayName ?? null));
        expect(page.data.basis).toEqual({ sourcePosition: answer.sourcePosition,
          tags: answer.tags, window: answer.window, matches: answer.matches });
        if (answer.nextCursor) expect(new URL(page.data.next!, 'https://story.invalid').searchParams.get('cursor')).toBe(answer.nextCursor);
        else expect(page.data.next).toBeNull();
        expect(page.data.notes).not.toContain(`Catalogue as of change ${answer.sourcePosition.sequence}`);
        expect(JSON.stringify(record)).toBe(before);
      } finally { replay.dispose(); }
    });
  }
}

test('every recorded Manga Condition, direct year and opaque continuation survives the request adapter', () => {
  for (const persona of cataloguePersonas) {
    for (const sample of catalogueRecords.manga!.personas[persona].filter(item => item.path.includes('/modules/browse'))) {
      const parsed = catalogueRequest(sample.path);
      const wire = new URL(sample.path, 'https://story.invalid').searchParams;
      expect(parsed.query.publicationYear).toBe(wire.get('publicationYear') ?? undefined);
      expect(parsed.query.cursor).toBe(wire.get('cursor') ?? undefined);
      expect(parsed.query.q).toBe(wire.get('q') ?? undefined);
      if (wire.has('concept')) expect(parsed.query.concept).toEqual(wire.getAll('concept'));
      if (wire.has('status')) expect(parsed.query.status).toEqual(wire.getAll('status'));
      if (wire.has('publicationYear')) expect(catalogueBrowseQuery(parsed.search).publicationYear).toBe(parsed.query.publicationYear);
    }
  }
});

test('an empty title is the same browse; valid year ranges stay exact and invalid ranges are not guessed', () => {
  expect(catalogueBrowseQuery({ q: '' })).toEqual(catalogueBrowseQuery({}));
  expect(catalogueBrowseQuery({ q: '   ' })).toEqual(catalogueBrowseQuery({}));
  expect(catalogueBrowseQuery({ year: '1995-2001', status: 'completed', concept: '00000000-0000-4000-8000-000000000003' }))
    .toMatchObject({ publicationYear: '1995-2001', status: ['completed'],
      concept: ['https://rezics.com/id/00000000-0000-4000-8000-000000000003'] });
  for (const invalid of ['2001-1995', '0-2001', '1995-', '1995-2001-2005', '01995', '10000', '1995–2001']) {
    expect(catalogueYearCondition(invalid)).toBeNull();
  }
  expect(catalogueYearCondition(['1995', '2001'])).toBeNull();
});

test('missing contract states declare exact requests; lag stays lower-bound and a 503 is never pending', () => {
  expect(missingCatalogueStates).toHaveLength(10);
  for (const sample of missingCatalogueStates) {
    expect(sample.source).toBe('contract');
    expect(catalogueRequest(sample.path).query.type).toHaveLength(1);
    if (sample.state === 'lagging') expect(sample.answer).toMatchObject({ items: [],
      matches: { kind: 'lower-bound', value: 0 }, window: { complete: false },
      sourcePosition: { sequence: '12' }, nextCursor: null });
    if (sample.state === 'error') expect(sample.status).toBe(503);
  }
});

test('minimum-count copy exists in all eight interface locales', () => {
  for (const locale of uiLocales) {
    const messages = zoneMessagesFor(locale);
    expect(messages.catalogueIncomplete.length).toBeGreaterThan(0);
    if (locale !== 'en') expect(messages.catalogueIncomplete).not.toBe(zoneMessagesFor('en').catalogueIncomplete);
  }
});

test('an empty incomplete answer never claims that the catalogue has no matches', async () => {
  const sample = catalogueContractSample('games', 'lagging');
  const request = catalogueRequest(sample.path);
  const main = browserMainApi('https://fixture.invalid', { anonymous: true,
    fetcher: (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(sample.answer), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  const messages = zoneMessagesFor('en');
  const page = await readCatalogueStory(main, sample.path, zone(request.realm), 'en', messages, false);
  if (!page.ok) throw new Error('The incomplete answer did not build');
  const html = renderToStaticMarkup(createElement(ZoneBrowse, { model: page.data, messages, card: () => null }));
  expect(html).toContain(messages.browseIncompleteTitle);
  expect(html).toContain(messages.catalogueIncomplete);
  expect(html).toContain('0+ results');
  expect(html).not.toContain(messages.browseEmptyTitle);
});

test('a year range can be removed while other Conditions keep it, without fabricating card dates', async () => {
  const record = catalogueRecords.manga!;
  const label = 'publication-year-range-and-format';
  const sample = catalogueSample(record, 'visitor', label);
  const request = catalogueRequest(sample.path);
  const replay = recordedFetch(record, 'visitor', [{ label, state: 'populated' }], { pathPrefix: BFF_PREFIX });
  try {
    const context = zone(request.realm);
    const page = await readCatalogueStory(browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: replay.fetcher }),
      sample.path, context, 'en', zoneMessagesFor('en'), false);
    if (!page.ok) throw new Error('Range fixture did not build');
    const yearCondition = page.data.chosen.find(item => item.key === 'publicationYear');
    expect(yearCondition).toBeDefined();
    // The recorded presentation declares no year control; its chosen Conditions come from the shared model.
    const removed = new URL(yearCondition!.href, 'https://story.invalid');
    const expected = new URL(browseHref(context.links.browse, { ...page.data.state, cursor: null }), 'https://story.invalid');
    expected.searchParams.delete('year');
    expect(removed.pathname).toBe(expected.pathname);
    expect([...removed.searchParams]).toEqual([...expected.searchParams]);
    expect(removed.searchParams.has('year')).toBe(false);
    expect(removed.searchParams.has('cursor')).toBe(false);
    const year = await applyCatalogueYear({ model: page.data, search: { ...request.search, q: 'Lantern title', sort: 'updated' },
      view: { kind: 'view', zone: context, context: { locale: 'en' }, pkg: { slots: { browseHeader: () => null } },
        zoneMessages: zoneMessagesFor('en') } as unknown as Extract<RealmView, { kind: 'view' }> });
    if (!isValidElement<{ year: { kept: { name: string; value: string }[] } }>(year.header)) throw new Error('Missing year form');
    expect(year.header.props.year.kept).toContainEqual({ name: 'q', value: 'Lantern title' });
    expect(year.header.props.year.kept).toContainEqual({ name: 'sort', value: 'updated' });
    expect(year.publicationYears.size).toBe(0);
    expect(page.data.kept).toContainEqual({ name: 'year', value: request.query.publicationYear! });
    for (const link of [...page.data.sorts, ...page.data.views,
      ...page.data.chosen.filter(item => item.key !== 'publicationYear')]) {
      expect(new URL(link.href, 'https://story.invalid').searchParams.get('year')).toBe(request.query.publicationYear!);
    }
  } finally { replay.dispose(); }
});
