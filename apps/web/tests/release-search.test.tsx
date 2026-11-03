import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConditionEditor } from '../src/search/condition-editor';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import { hitCalendarDate, releaseDateText } from '../src/search/release-search-date';
import { ResultRow, type Fact } from '../src/search/results';
import { listKeyFacts } from '../src/media/type-presentation';
import { parseDiscoveryPage, parseLegacySearchPage, readDiscovery } from '../src/search/discovery';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { FilterRelease } from '@rezics/filter';
import { parseReleaseSearch, releaseSearchHref, releaseSearchRequest } from '../src/search/release-search';
import { ReleaseSearchPage } from '../src/search/release-search-page';

test('the universal editor preserves precise endpoints instead of rendering numeric year inputs', () => {
  const locale = 'ja';
  const html = renderToStaticMarkup(
    createElement(ConditionEditor, {
      value: {
        statement: { property: 'schema:datePublished', range: { type: 'time', gte: '2024-02-29', lte: '2024-03' } },
      },
      metadata: {
        types: { 'schema:Release': { facets: ['schema:datePublished'] } },
        properties: { 'schema:datePublished': { datatype: 'time' } },
      },
      locale,
      languages: ['ja'],
      onChange() {},
      onLanguages() {},
    }),
  );
  expect(html).toContain('value="2024-02-29"');
  expect(html).toContain('value="2024-03"');
  expect(html).toContain(m.refinement_lower({}, { locale }));
  expect(html).not.toContain(m.refinement_year_hint({}, { locale }));
});

test('all eight locales retain recorded date precision in actual result metadata and list facts', () => {
  const property = 'schema:datePublished';
  const dates: Fact[] = [
    { kind: 'time', year: 2024 },
    { kind: 'time', year: 2024, month: 2 },
    { kind: 'time', year: 2024, month: 2, day: 29 },
  ];
  expect(locales).toHaveLength(8);
  for (const locale of locales) {
    const texts = dates.map((date) => {
      if (date.kind !== 'time') throw new Error('Expected a time fact');
      const facts = { [property]: [date] };
      const text = releaseDateText(date, locale)!;
      const html = renderToStaticMarkup(
        createElement(ResultRow, {
          hit: { id: '018f0000-0000-7000-8000-000000000001', type: 'wd:Q20631656', labels: { en: 'Edition' }, facts },
          locale,
          hitTypes: {},
          yearProperties: [property],
        }),
      );
      expect(html).toContain(`>${text}</span>`);
      expect(listKeyFacts(facts, [property], [], locale)).toEqual([{ property, text }]);
      expect(hitCalendarDate(facts)).toEqual({
        year: date.year,
        ...(date.month === undefined ? {} : { month: date.month }),
        ...(date.day === undefined ? {} : { day: date.day }),
      });
      return text;
    });
    expect(new Set(texts).size).toBe(3);
  }
  expect(releaseDateText({ year: 2024, month: 2 }, 'en')).toBe('February 2024');
  expect(releaseDateText({ year: 2024, month: 2, day: 29 }, 'en')).toBe('February 29, 2024');
});

test('date display keeps astronomical years and rejects malformed facts without inventing a year', () => {
  for (const year of [0, -400, 99, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
    const yearText = new Intl.NumberFormat('en', { useGrouping: false }).format(year);
    expect(releaseDateText({ year, month: 2, day: 29 }, 'en')).toBe(
      year % 4 === 0 ? `February 29, ${yearText}` : undefined,
    );
    expect(releaseDateText({ year, month: 2 }, 'en')).toBe(`February ${yearText}`);
  }
  for (const date of [
    { year: 2023, month: 2, day: 29 },
    { year: 2024, day: 3 },
    { year: 2024, month: 13 },
  ]) {
    expect(releaseDateText(date, 'en')).toBeUndefined();
    expect(hitCalendarDate({ date: [{ kind: 'time', ...date }] })).toBeUndefined();
  }
  expect(hitCalendarDate({ date: [null, null, null, { kind: 'time', year: 2024 }] })).toBeUndefined();
});

const releaseId = '018f0000-0000-7000-8000-000000000001';
const releaseType = 'wd:Q20631656';
function releasePages(date: object) {
  const summary = {
    id: releaseId,
    type: releaseType,
    types: [releaseType],
    label: null,
    creativeWork: false,
    cover: null,
  };
  const fields = { labels: { en: 'Edition' }, facts: { 'schema:datePublished': [{ kind: 'time', ...date }] } };
  return {
    discovery: {
      hits: [
        {
          key: { owner: 'semantic', kind: releaseType, route: 0, id: releaseId },
          summary: { kind: 'subject', value: summary },
          ...fields,
        },
      ],
      kinds: { values: [], next: null },
      next: null,
      as_of: '2026-11-04T00:00:00Z',
    },
    legacy: {
      subjects: [{ id: releaseId, type: releaseType, summary, ...fields }],
      next: null,
      as_of: '2026-11-04T00:00:00Z',
    },
  };
}

test('both public response readers preserve recorded precision through localized result cards', () => {
  for (const date of [
    { year: 2024 },
    { year: 2024, month: 2 },
    { year: 2024, month: 2, day: 29 },
    { year: 0, month: 2, day: 29 },
    { year: -400, month: 2 },
    { year: Number.MAX_SAFE_INTEGER },
  ]) {
    const pages = releasePages(date);
    const hit = parseDiscoveryPage(pages.discovery)!.hits[0]!;
    if (hit.summary.kind !== 'subject') throw new Error('Expected a subject');
    const legacy = parseLegacySearchPage(pages.legacy)!.subjects[0]!;
    for (const facts of [hit.facts, legacy.facts]) {
      expect(facts).toEqual(pages.legacy.subjects[0]!.facts);
      for (const locale of locales) {
        const html = renderToStaticMarkup(
          createElement(ResultRow, {
            hit: { id: releaseId, type: releaseType, labels: { en: 'Edition' }, facts },
            locale,
            hitTypes: {},
            yearProperties: ['schema:datePublished'],
          }),
        );
        expect(html).toContain(`>${releaseDateText(date, locale)}</span>`);
      }
    }
  }
});

test('malformed wire dates make the response unavailable instead of silently becoming year-only', async () => {
  for (const date of [
    { year: 2023, month: 2, day: 29 },
    { year: 2024, day: 1 },
    { year: 2024, month: 13 },
    { year: 2024, month: null },
    { year: 2024, month: 2, day: 0 },
    { year: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const pages = releasePages(date);
    expect(parseDiscoveryPage(pages.discovery)).toBeUndefined();
    expect(parseLegacySearchPage(pages.legacy)).toBeUndefined();
    const response = await readDiscovery({ representation: 'discovery-v1', languages: ['en'] }, async () => ({
      status: 200,
      data: pages.discovery,
    }));
    expect(response.discovery.status).toBe('unavailable');
  }
});

test('release URLs round-trip ordered display and same-platform languages, exact dates and independent credits', () => {
  for (const locale of locales) {
    const raw = {
      subtype: releaseType,
      q: 'Edition',
      platform: releaseId,
      releaseLanguage: ['ja', 'en'],
      language: ['fr', 'ja'],
      gte: '2024-02-29',
      lte: '2024-03',
      developer: releaseId,
      publisher: releaseId,
      sort: 'name',
      threshold: '2',
      cursor: 'opaque+next/==',
      condition: JSON.stringify({ not: { statement: { property: 'schema:inLanguage', in: ['de'] } } }),
    };
    const parsed = parseReleaseSearch(raw, bundledRelease, locale);
    expect(parsed.invalid).toEqual([]);
    const request = releaseSearchRequest(parsed.search, bundledRelease);
    expect(request.languages).toEqual(['fr', 'ja']);
    expect(request.spoilerThreshold).toBe(2);
    expect(request.cursor).toBe(raw.cursor);
    expect(JSON.stringify(request.filter)).toContain(
      JSON.stringify({
        statement: {
          property: 'schema:gamePlatform',
          in: [releaseId],
          qualifiers: [{ property: 'schema:inLanguage', in: ['ja', 'en'] }],
        },
      }),
    );
    expect(JSON.stringify(request.filter)).toContain('2024-02-29');
    expect(JSON.stringify(request.filter)).toContain('wdt:P178');
    expect(JSON.stringify(request.filter)).toContain('schema:publisher');
    const nextUrl = new URL(releaseSearchHref(locale, parsed.form, raw.cursor), 'https://example.test');
    const restored = parseReleaseSearch(Object.fromEntries(nextUrl.searchParams), bundledRelease, locale);
    expect(releaseSearchRequest(restored.search, bundledRelease)).toEqual(request);
    expect(new URL(releaseSearchHref(locale, parsed.form), nextUrl).searchParams.has('cursor')).toBe(false);
    const displayOnly = parseReleaseSearch({ subtype: releaseType, language: ['fr', 'ja'] }, bundledRelease, locale);
    expect(JSON.stringify(releaseSearchRequest(displayOnly.search, bundledRelease).filter)).not.toContain(
      'schema:inLanguage',
    );
  }
});

test('withdrawn controls and malformed URL operands remain repairable without broadening the search', () => {
  const release: FilterRelease = structuredClone(bundledRelease);
  release.types[releaseType]!.facets = release.types[releaseType]!.facets!.filter(
    (property) => property !== 'schema:publisher',
  );
  for (const [raw, field] of [
    [{ publisher: releaseId }, 'publisher'],
    [{ subtype: 'local:Missing' }, 'subtype'],
    [{ platform: 'bad-id' }, 'platform'],
    [{ gte: '2023-02-29' }, 'gte'],
    [{ gte: '2025', lte: '2024' }, 'lte'],
    [{ language: ['ja', 'ja'] }, 'language'],
    [{ language: [] }, 'language'],
    [{ releaseLanguage: '??' }, 'releaseLanguage'],
    [{ sort: 'relevance' }, 'sort'],
    [{ threshold: '3' }, 'threshold'],
    [{ condition: '{broken' }, 'condition'],
    [{ cursor: '' }, 'cursor'],
    [{ q: ['one', 'two'] }, 'q'],
    [{ ageGte: ' ' }, 'ageGte'],
  ] as const) {
    const parsed = parseReleaseSearch({ subtype: releaseType, ...raw }, release, 'en');
    expect(parsed.invalid).toContain(field);
    const html = renderToStaticMarkup(
      createElement(ReleaseSearchPage, {
        locale: 'en',
        parsed,
        types: [{ id: releaseType, label: 'Release' }],
        state: { status: 'invalid' },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-slot="discovery-results"');
    if (field !== 'cursor') expect(html).toContain('aria-invalid="true"');
  }
  const typed = parseReleaseSearch({ subtype: releaseType, threshold: 1, gte: 2024, ageGte: 0 }, release, 'en');
  expect(typed.form.threshold).toBe('1');
  expect(typed.form.gte).toBe('2024');
  expect(typed.form.ageGte).toBe('0');
});

test('the release page localizes controls and distinguishes loading, unavailable, empty continuation and terminal cards', () => {
  for (const locale of locales) {
    const parsed = parseReleaseSearch(
      { subtype: releaseType, gte: '2024-02-29', language: ['ja', 'en'] },
      bundledRelease,
      locale,
    );
    const render = (state: Parameters<typeof ReleaseSearchPage>[0]['state']) =>
      renderToStaticMarkup(
        createElement(ReleaseSearchPage, {
          locale,
          parsed,
          types: [{ id: releaseType, label: 'Released subtype' }],
          state,
        }),
      );
    const loading = render({ status: 'loading' });
    expect(loading).toContain(m.release_search_heading({}, { locale }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('value="2024-02-29"');
    expect(loading).toContain('value="ja, en"');
    expect(loading).toContain('<label');
    expect(render({ status: 'unavailable' })).toContain('role="alert"');
    const empty = { hits: [], kinds: { values: [], next: null }, next: null, as_of: 'now' };
    expect(render({ status: 'ready', page: empty })).not.toContain(m.release_search_continue({}, { locale }));
    const continuing = render({ status: 'ready', page: { ...empty, next: 'next+page' } });
    expect(continuing).toContain(m.release_search_page_empty({}, { locale }));
    expect(continuing).toContain('cursor=next%2Bpage');
    const page = parseDiscoveryPage(releasePages({ year: 2024, month: 2, day: 29 }).discovery)!;
    const terminal = render({ status: 'ready', page });
    expect(terminal).toContain(`>${releaseDateText({ year: 2024, month: 2, day: 29 }, locale)}</span>`);
    expect(terminal).toContain(m.release_search_terminal({}, { locale }));
  }
});
