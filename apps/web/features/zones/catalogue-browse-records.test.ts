import { expect, test } from 'bun:test';
import type { ZoneContext } from '@rezics/zone-sdk';
import { BFF_PREFIX, browserMainApi } from '../api/browser.ts';
import type { ZoneBrowsePage } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';
import { catalogueLabels, cataloguePersonas, catalogueRecords, missingCatalogueStates } from './catalogue-browse-fixtures.ts';
import { catalogueRequest, catalogueSample, readCatalogueStory } from './catalogue-browse-records.ts';
import { catalogueBrowseQuery, applyCatalogueYear } from './catalogue-browse.tsx';
import { catalogueYearCondition } from './catalogue-year.ts';
import { zoneMessagesFor } from './fixtures.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import { uiLocales } from '../../i18n/define.ts';
import { presetTokens } from './presentation.ts';

const zone = (realm: string): ZoneContext => ({
  slug: null, realm: `https://rezics.com/id/${realm}`, name: { value: 'Catalogue', lang: 'en', dir: 'ltr' },
  description: null, icon: null, hero: null, locale: 'en',
  tokens: presetTokens.editorial,
  links: { home: '/z/catalogue', browse: '/z/catalogue/browse', works: '/z/catalogue/browse',
    discussions: '/r/catalogue/discussions', decisions: '/r/catalogue/decisions', about: '/r/catalogue/about' },
});

for (const slug of ['books', 'visual-novels', 'manga'] as const) {
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
        expect(page.data.notes).toContain(`Catalogue as of change ${answer.sourcePosition.sequence}`);
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

test('freshness and minimum-count copy exists in all eight interface locales', () => {
  for (const locale of uiLocales) {
    const messages = zoneMessagesFor(locale);
    expect(messages.catalogueIncomplete.length).toBeGreaterThan(0);
    expect(messages.catalogueFreshness).toBeDefined();
    if (locale !== 'en') expect(messages.catalogueIncomplete).not.toBe(zoneMessagesFor('en').catalogueIncomplete);
  }
});

test('a year range stays on all generated links without fabricating card dates', async () => {
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
    const year = await applyCatalogueYear({ model: page.data, search: request.search,
      view: { kind: 'view', zone: context, context: { locale: 'en' }, pkg: null,
        zoneMessages: zoneMessagesFor('en') } as unknown as Extract<RealmView, { kind: 'view' }> });
    expect(year.publicationYears.size).toBe(0);
    expect(page.data.kept).toContainEqual({ name: 'year', value: request.query.publicationYear! });
    for (const link of [...page.data.sorts, ...page.data.views, ...page.data.chosen]) {
      expect(new URL(link.href, 'https://story.invalid').searchParams.get('year')).toBe(request.query.publicationYear!);
    }
  } finally { replay.dispose(); }
});
