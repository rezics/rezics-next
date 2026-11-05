import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { Fact } from '../src/search/results';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { ConditionEditor } = await import('../src/search/condition-editor');
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import { hitCalendarDate, releaseDateText } from '../src/search/release-search-date';
const { ResultRow } = await import('../src/search/results');
import { listKeyFacts } from '../src/media/type-presentation';
const { parseDiscoveryPage, parseLegacySearchPage, readDiscovery } = await import('../src/search/discovery');
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  admittedReleaseSearchControls,
  admittedReleaseSearchTypes,
  type FilterRelease,
} from '@rezics/filter';
import {
  parseReleaseSearch,
  releaseSearchHref,
  releaseSearchRequest,
  type ReleaseSearchType,
} from '../src/search/release-search';
const releaseSearchQuery = await import('../src/search/release-search-query');
import { defaultParseSearch } from '@tanstack/react-router';
const { GLOBAL, QUESTION } = await import('../src/features/pages/subject-ratings');

type ChildReader = typeof releaseSearchQuery.readReleaseSearchChildren;
type ChildReaderInput = Parameters<ChildReader>[0];
type ChildReaderResult = Awaited<ReturnType<ChildReader>>;
type ChildCard = Extract<ChildReaderResult, { status: 'ready' }>['page']['children'][number];

let readChildren: ChildReader = releaseSearchQuery.readReleaseSearchChildren;
mock.module('../src/search/release-search-query', () => ({
  ...releaseSearchQuery,
  readReleaseSearchChildren: (...args: Parameters<ChildReader>) => readChildren(...args),
}));

const { parseReleaseSearchChildrenPage, parseReleaseSearchGroupsPage } = releaseSearchQuery;
const { ReleaseSearchPage } = await import('../src/search/release-search-page');
const { ReleaseSearchFormView } = await import('../src/search/release-criteria-form');
afterAll(() => mock.restore());

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
const platformId = '018f0000-0000-7000-8000-000000000002';
const developerId = '018f0000-0000-7000-8000-000000000003';
function releaseSearchTypes(release: FilterRelease): ReleaseSearchType[] {
  return admittedReleaseSearchTypes(release).map((id) => {
    const controls = admittedReleaseSearchControls(release, id)!;
    return {
      id,
      label: id,
      controls: {
        platform: controls.platform,
        language: controls.language,
        date: controls.date,
        ageRating: controls.ageRating,
        producers: controls.producers,
      },
    };
  });
}
const releaseTypes = releaseSearchTypes(bundledRelease);

async function mountReleaseCriteria(locale = 'en') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test/${locale}/search/releases` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    window,
    render: (
      parsed: ReturnType<typeof parseReleaseSearch>,
      selections?: Parameters<typeof ReleaseSearchFormView>[0]['selections'],
    ) =>
      act(async () =>
        root.render(
          createElement(ReleaseSearchFormView, {
            parsed,
            types: releaseTypes,
            locale,
            ...(selections ? { selections } : {}),
          }),
        ),
      ),
    async close() {
      await act(async () => root.unmount());
      window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
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

function groupedCard(date: object, id = releaseId, type = releaseType, title = 'Edition') {
  const summary = {
    id,
    type,
    types: [type],
    label: null,
    creativeWork: type === 'schema:CreativeWork',
    cover: null,
  };
  const label = { value: title, language: 'en' };
  return {
    id,
    type,
    kind: type,
    base: {
      id,
      kind: type,
      kindLabel: label,
      title: label,
      image: null,
      url: { id, label },
    },
    labels: { en: title },
    summary,
    facts: { 'schema:datePublished': [{ kind: 'time', ...date }] },
    figure: {
      questionId: QUESTION,
      populationId: GLOBAL,
      scale: { min: 0, max: 10, displayStep: 1 },
      count: 0,
      state: 'insufficient_data',
      mean: null,
      score: null,
    },
  };
}

function groupedPage(date: object, next: string | null = null) {
  return {
    status: 'ready',
    groups: [{ kind: 'release', id: releaseId, release: groupedCard(date), workLink: 'missing' }],
    next,
    as_of: '2026-11-04T00:00:00Z',
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
    expect(parseReleaseSearch({ subtype: releaseType, sort: 'rating' }, bundledRelease, locale).invalid).toContain(
      'sort',
    );
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
    expect(request.representation).toBe('release-groups-v1');
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
    const restored = parseReleaseSearch(defaultParseSearch(nextUrl.search), bundledRelease, locale);
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
        types: releaseSearchTypes(release),
        state: { status: 'invalid' },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('data-slot="release-search-results"');
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
          types: releaseTypes,
          state,
        }),
      );
    const loading = render({ status: 'loading' });
    expect(loading).toContain(m.release_search_heading({}, { locale }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('value="2024-02-29"');
    expect(loading).toContain(m.condition_languages_label({}, { locale }));
    expect(loading).toContain('name="language" value="ja"');
    expect(loading).toContain('name="language" value="en"');
    expect(loading).toContain(m.release_search_age_help({}, { locale }));
    expect(loading).toContain(m.condition_calendar_day({}, { locale }));
    expect(loading).toContain(m.condition_calendar_help({}, { locale }));
    expect(loading).toContain('<label');
    expect(render({ status: 'unavailable' })).toContain('role="alert"');
    const preparing = render({
      status: 'preparing',
      page: { status: 'preparing', groups: [], next: 'resume', as_of: '2026-11-04T00:00:00Z' },
    });
    expect(preparing).toContain(m.discovery_preparing({}, { locale }));
    expect(preparing).not.toContain(m.release_search_page_empty({}, { locale }));
    expect(preparing).toContain('aria-live="polite"');
    const withCursor = parseReleaseSearch({ subtype: releaseType, cursor: 'group-cursor' }, bundledRelease, locale);
    const restart = renderToStaticMarkup(
      createElement(ReleaseSearchPage, {
        locale,
        parsed: withCursor,
        state: { status: 'restart' },
      }),
    );
    expect(restart).toContain(m.discovery_restart_action({}, { locale }));
    expect(restart).not.toContain('cursor=');
    const empty = { status: 'ready' as const, groups: [], next: null, as_of: '2026-11-04T00:00:00Z' };
    expect(render({ status: 'ready', page: empty })).not.toContain(m.release_search_continue({}, { locale }));
    const continuing = render({ status: 'ready', page: { ...empty, next: 'next+page' } });
    expect(continuing).toContain(m.release_search_page_empty({}, { locale }));
    expect(continuing).toContain('cursor=next%2Bpage');
    const page = parseReleaseSearchGroupsPage(groupedPage({ year: 2024, month: 2, day: 29 }))!;
    const terminal = render({ status: 'ready', page });
    expect(terminal).toContain(`>${releaseDateText({ year: 2024, month: 2, day: 29 }, locale)}</span>`);
    expect(terminal).toContain(m.release_search_terminal({}, { locale }));
  }
});

test('platform and producer operands use contextual selections while URLs retain their subject IDs', () => {
  for (const locale of locales) {
    const parsed = parseReleaseSearch(
      { subtype: releaseType, platform: releaseId, developer: releaseId },
      bundledRelease,
      locale,
    );
    const html = renderToStaticMarkup(
      createElement(ReleaseSearchPage, {
        locale,
        parsed,
        types: releaseTypes,
        selections: {
          platform: { id: releaseId, label: 'Nintendo Switch', type: 'schema:GamePlatform' },
          developer: { id: releaseId, label: 'Example Studio', type: 'schema:Organization' },
        },
        state: { status: 'loading' },
      }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain(m.release_search_subject_help({}, { locale }));
    expect(html).toContain('Nintendo Switch');
    expect(html).toContain('Example Studio');
    expect(html).toContain(`<input type="hidden" name="platform" value="${releaseId}"/>`);
    expect(html).toContain(`<input type="hidden" name="developer" value="${releaseId}"/>`);
    expect(html).not.toContain(
      `type="search" autoComplete="off" placeholder="${m.search_placeholder({}, { locale })}" value="${releaseId}"`,
    );
  }
});

test('release criteria update on subtype change, retain repairs, and apply an ordered cursor-free request', async () => {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL) => {
      const query = new URL(String(input), 'https://site.test').searchParams.get('q');
      const subject =
        query === 'Nintendo'
          ? { id: platformId, type: 'schema:GamePlatform', labels: { en: 'Nintendo Switch' } }
          : { id: developerId, type: 'schema:Organization', labels: { en: 'Example Studio' } };
      const type = subject.type;
      return new Response(
        JSON.stringify({
          subjects: [{ ...subject, summary: null }],
          types: { [type]: { en: type } },
          as_of: '2026-11-05T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const mounted = await mountReleaseCriteria();
  const condition = JSON.stringify({ not: { statement: { property: 'schema:inLanguage', in: ['de'] } } });
  const original = parseReleaseSearch(
    {
      subtype: releaseType,
      q: 'Edition',
      language: ['fr', 'ja'],
      gte: '2024-02',
      lte: '2024-03',
      ageGte: '1.25',
      ageLte: '3.5',
      ageUnit: 'http://www.wikidata.org/entity/Q577',
      sort: 'relevance',
      threshold: '2',
      condition,
      cursor: 'old-result-cursor',
    },
    bundledRelease,
    'en',
  );
  const input = (id: string) => mounted.host.querySelector<HTMLInputElement>(`#release-search-${id}`)!;
  const changeValue = (id: string, value: string) => {
    const field = mounted.host.querySelector<HTMLInputElement | HTMLSelectElement>(`#release-search-${id}`)!;
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set?.call(field, value);
    field.dispatchEvent(new mounted.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  };
  const choose = async (id: string, query: string) => {
    await act(async () => {
      changeValue(id, query);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      mounted.host.querySelector<HTMLElement>('[role="option"]')!.click();
    });
  };
  try {
    await mounted.render(original);
    await choose('platform', 'Nintendo');
    await choose('developer', 'Studio');
    expect(mounted.host.textContent).toContain('Nintendo Switch');
    expect(mounted.host.textContent).toContain('Example Studio');
    expect(mounted.host.textContent).toContain('schema:GamePlatform');
    expect(mounted.host.textContent).toContain('schema:Organization');
    expect(mounted.host.textContent).toContain(m.release_search_subject_help({}, { locale: 'en' }));
    expect(mounted.host.textContent).toContain(m.release_search_draft_notice({}, { locale: 'en' }));

    await act(async () => {
      changeValue('releaseLanguage', 'ja, en');
    });
    const moveJapaneseUp = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === m.condition_languages_move_up({ language: 'ja' }, { locale: 'en' }),
    )!;
    await act(async () => moveJapaneseUp.click());

    await act(async () => {
      changeValue('subtype', 'rezics:AnimeRelease');
    });
    expect(mounted.host.querySelector('[data-criteria-field="platform"]')).not.toBeNull();
    expect(input('platform').getAttribute('aria-invalid')).toBe('true');
    expect(input('developer').getAttribute('aria-invalid')).toBe('true');
    expect(input('ageGte').value).toBe('1.25');
    expect(input('ageUnit').value).toBe('http://www.wikidata.org/entity/Q577');
    expect(input('releaseLanguage').getAttribute('aria-invalid')).toBe('true');
    expect(mounted.host.querySelector('#release-search-errors a[href="#release-search-platform"]')).not.toBeNull();
    const form = mounted.host.querySelector('form')!;
    await act(async () => {
      expect(form.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }))).toBe(false);
    });
    expect(mounted.window.document.activeElement?.id).toBe('release-search-errors');

    await act(async () => {
      changeValue('subtype', releaseType);
      changeValue('releaseLanguage', 'ja, en');
    });
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    const params = new URLSearchParams();
    for (const [key, value] of new mounted.window.FormData(form)) if (typeof value === 'string') params.append(key, value);
    expect(params.getAll('language')).toEqual(['ja', 'fr']);
    expect(params.has('cursor')).toBe(false);
    expect(params.get('condition')).toBe(condition);
    expect(params.get('threshold')).toBe('2');
    expect(params.get('sort')).toBe('relevance');

    const reopened = parseReleaseSearch(defaultParseSearch(`?${params}`), bundledRelease, 'en');
    expect(reopened.invalid).toEqual([]);
    expect(reopened.search.cursor).toBeUndefined();
    const request = releaseSearchRequest(reopened.search, bundledRelease);
    const expected = parseReleaseSearch(
      {
        ...reopened.form,
        platform: platformId,
        releaseLanguage: 'ja, en',
        developer: developerId,
      },
      bundledRelease,
      'en',
    );
    expect(request).toEqual(releaseSearchRequest(expected.search, bundledRelease));
    await mounted.render(reopened, {
      platform: { id: platformId, label: 'Nintendo Switch', type: 'schema:GamePlatform' },
      developer: { id: developerId, label: 'Example Studio', type: 'schema:Organization' },
    });
    expect(input('gte').value).toBe('2024-02');
    expect(input('lte').value).toBe('2024-03');
    expect(input('ageGte').value).toBe('1.25');
    expect(input('ageLte').value).toBe('3.5');
    expect(input('ageUnit').value).toBe('http://www.wikidata.org/entity/Q577');
    expect(mounted.host.textContent).toContain('Nintendo Switch');
    expect(mounted.host.textContent).toContain('Example Studio');
  } finally {
    await mounted.close();
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
});

test('withdrawn subtype and invalid URL language stay visible until focused correction', async () => {
  const mounted = await mountReleaseCriteria();
  try {
    const parsed = parseReleaseSearch({ subtype: 'local:Withdrawn', language: ['??', 'ja'] }, bundledRelease, 'en');
    await mounted.render(parsed);
    const subtype = mounted.host.querySelector<HTMLSelectElement>('#release-search-subtype')!;
    expect(subtype.value).toBe('local:Withdrawn');
    expect(subtype.querySelector('option[value="local:Withdrawn"]')).not.toBeNull();
    expect(subtype.getAttribute('aria-describedby')).toContain('release-search-subtype-error');
    expect(mounted.host.querySelector('#release-search-language')?.getAttribute('aria-invalid')).toBe('true');
    expect(mounted.host.textContent).toContain('??');

    const form = mounted.host.querySelector('form')!;
    await act(async () => {
      expect(form.dispatchEvent(new mounted.window.Event('submit', { bubbles: true, cancelable: true }))).toBe(false);
    });
    expect(mounted.window.document.activeElement?.id).toBe('release-search-errors');
    await act(async () => {
      const changeValue = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(subtype), 'value')?.set;
      changeValue?.call(subtype, releaseType);
      subtype.dispatchEvent(new mounted.window.Event('change', { bubbles: true }));
    });
    const removeInvalidTag = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.getAttribute('aria-label') === m.condition_languages_remove({ language: '??' }, { locale: 'en' }),
    )!;
    await act(async () => removeInvalidTag.click());
    expect(mounted.host.querySelector('[role="alert"]')).toBeNull();
    const data = new mounted.window.FormData(form);
    expect(data.getAll('language')).toEqual(['ja']);
    expect(data.has('cursor')).toBe(false);
  } finally {
    await mounted.close();
  }
});

test('grouped responses retain current cards and render independent work expansions in every locale', () => {
  const workId = '018f0000-0000-7000-8000-000000000002';
  const otherWorkId = '018f0000-0000-7000-8000-000000000003';
  const otherReleaseId = '018f0000-0000-7000-8000-000000000004';
  const response = {
    status: 'ready',
    groups: [
      {
        kind: 'work',
        id: workId,
        work: groupedCard({ year: 2024 }, workId, 'schema:CreativeWork', 'Work'),
        releases: [groupedCard({ year: 2024 })],
        next: 'child-one',
      },
      {
        kind: 'work',
        id: otherWorkId,
        work: groupedCard({ year: 2024 }, otherWorkId, 'schema:CreativeWork', 'Other work'),
        releases: [groupedCard({ year: 2023 }, otherReleaseId, releaseType, 'Other edition')],
        next: 'child-two',
      },
    ],
    next: null,
    as_of: '2026-11-04T00:00:00Z',
  };
  const page = parseReleaseSearchGroupsPage(response);
  expect(page).toBeDefined();
  expect(
    parseReleaseSearchGroupsPage({ ...response, groups: [...response.groups, response.groups[0]] }),
  ).toBeUndefined();
  expect(parseReleaseSearchGroupsPage({ ...response, status: 'preparing' })).toBeUndefined();
  expect(
    parseReleaseSearchChildrenPage({
      status: 'preparing',
      children: [],
      next: null,
      as_of: '2026-11-04T00:00:00Z',
    }),
  ).toBeUndefined();
  for (const locale of locales) {
    const parsed = parseReleaseSearch({ subtype: releaseType }, bundledRelease, locale);
    const html = renderToStaticMarkup(
      createElement(ReleaseSearchPage, { locale, parsed, state: { status: 'ready', page: page! } }),
    );
    expect(html.match(/<details(?:\s|>)/g)).toHaveLength(2);
    expect(html).toContain(`data-release-work="${workId}"`);
    expect(html).toContain(`data-release-work="${otherWorkId}"`);
    expect(html).toContain(m.release_search_related_releases({}, { locale }));
    expect(html).toContain(m.release_search_continue({}, { locale }));
  }
});

test('work expansions keep independent child progress and resume their own response cursors', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search/releases' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    FormData: window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const firstWork = '018f0000-0000-7000-8000-000000000012';
  const secondWork = '018f0000-0000-7000-8000-000000000013';
  const firstRelease = '018f0000-0000-7000-8000-000000000014';
  const secondRelease = '018f0000-0000-7000-8000-000000000015';
  const parsed = parseReleaseSearch({ subtype: releaseType }, bundledRelease, 'en');
  const page = parseReleaseSearchGroupsPage({
    status: 'ready',
    groups: [
      {
        kind: 'work',
        id: firstWork,
        work: groupedCard({ year: 2024 }, firstWork, 'schema:CreativeWork', 'First work'),
        releases: [groupedCard({ year: 2022 }, `${firstRelease}-preview`, releaseType, 'First preview')],
        next: 'preview-one',
      },
      {
        kind: 'work',
        id: secondWork,
        work: groupedCard({ year: 2024 }, secondWork, 'schema:CreativeWork', 'Second work'),
        releases: [groupedCard({ year: 2022 }, `${secondRelease}-preview`, releaseType, 'Second preview')],
        next: 'preview-two',
      },
    ],
    next: null,
    as_of: '2026-11-04T00:00:00Z',
  });
  if (!page) throw new Error('Expected a grouped release page');
  const calls: ChildReaderInput['data'][] = [];
  let completeFirst!: (result: ChildReaderResult) => void;
  const firstPending = new Promise<ChildReaderResult>((resolve) => {
    completeFirst = resolve;
  });
  const asOf = '2026-11-04T00:00:00Z';
  const card = (date: object, id: string, title: string): ChildCard =>
    groupedCard(date, id, releaseType, title) as unknown as ChildCard;
  const ready = (children: ChildCard[], next: string | null): ChildReaderResult => ({
    status: 'ready',
    page: { status: 'ready', children, next, as_of: asOf },
  });
  const preparing = (next: string): ChildReaderResult => ({
    status: 'preparing',
    page: { status: 'preparing', children: [], next, as_of: asOf },
  });
  let firstFailure = true;
  readChildren = ({ data }) => {
    calls.push(data);
    if (data.work === firstWork && data.cursor === 'preview-one') return firstPending;
    if (data.work === firstWork && data.cursor === 'resume-one')
      return Promise.resolve(ready([card({ year: 2024 }, firstRelease, 'First edition')], 'first-next'));
    if (data.work === firstWork && data.cursor === 'first-next') {
      if (firstFailure) {
        firstFailure = false;
        return Promise.resolve({ status: 'unavailable' });
      }
      return Promise.resolve(ready([card({ year: 2025 }, `${firstRelease}-later`, 'First later edition')], null));
    }
    if (data.work === secondWork && data.cursor === 'preview-two')
      return Promise.resolve(ready([card({ year: 2023 }, secondRelease, 'Second edition')], 'second-next'));
    if (data.work === secondWork && data.cursor === 'second-next')
      return Promise.resolve(ready([card({ year: 2024 }, `${secondRelease}-later`, 'Second later edition')], null));
    throw new Error('Unexpected child continuation');
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const work = (id: string) => host.querySelector(`[data-release-work="${id}"]`)!;
  const expand = (id: string) => work(id).querySelector('summary')!.click();
  const continueButton = (id: string) => work(id).querySelector('button') as HTMLButtonElement;
  try {
    await act(async () =>
      root.render(
        createElement(ReleaseSearchPage, {
          locale: 'en',
          parsed,
          state: { status: 'ready', page },
        }),
      ),
    );
    expect(calls).toHaveLength(0);
    await act(async () => expand(firstWork));
    expect(work(firstWork).querySelector('details')!.open).toBe(true);
    expect(work(secondWork).querySelector('details')!.open).toBe(false);
    await act(async () => expand(secondWork));
    expect(work(firstWork).querySelector('details')!.open).toBe(true);
    expect(work(secondWork).querySelector('details')!.open).toBe(true);

    await act(async () => {
      continueButton(firstWork).click();
      continueButton(firstWork).click();
    });
    expect(calls).toHaveLength(1);
    expect(continueButton(firstWork).disabled).toBe(true);
    expect(continueButton(secondWork).disabled).toBe(false);
    await act(async () => continueButton(secondWork).click());
    expect(work(secondWork).textContent).toContain('Second edition');
    expect(continueButton(firstWork).disabled).toBe(true);

    await act(async () => {
      completeFirst(preparing('resume-one'));
      await firstPending;
    });
    expect(work(firstWork).textContent).toContain(m.discovery_preparing({}, { locale: 'en' }));
    expect(work(firstWork).querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
    expect(continueButton(firstWork).disabled).toBe(false);

    await act(async () => continueButton(firstWork).click());
    expect(calls.map(({ work, cursor }) => [work, cursor])).toEqual([
      [firstWork, 'preview-one'],
      [secondWork, 'preview-two'],
      [firstWork, 'resume-one'],
    ]);
    expect(work(firstWork).textContent).toContain('First edition');
    expect(work(firstWork).textContent).not.toContain('First preview');
    expect(work(secondWork).textContent).toContain('Second edition');

    await act(async () => continueButton(secondWork).click());
    continueButton(firstWork).focus();
    await act(async () => continueButton(firstWork).click());
    expect(work(firstWork).textContent).toContain('First edition');
    expect(continueButton(firstWork).textContent).toBe(m.search_facet_retry({}, { locale: 'en' }));
    expect(window.document.activeElement).toBe(continueButton(firstWork));
    await act(async () => continueButton(firstWork).click());
    expect(calls.map(({ work, cursor }) => [work, cursor])).toEqual([
      [firstWork, 'preview-one'],
      [secondWork, 'preview-two'],
      [firstWork, 'resume-one'],
      [secondWork, 'second-next'],
      [firstWork, 'first-next'],
      [firstWork, 'first-next'],
    ]);
    expect(work(firstWork).textContent).toContain('First later edition');
    expect(work(secondWork).textContent).toContain('Second later edition');
    expect(work(firstWork).textContent).not.toContain('First edition');
    expect(work(secondWork).textContent).not.toContain('Second edition');
    expect(continueButton(firstWork)).toBeNull();
    expect(work(firstWork).textContent).toContain(m.release_search_terminal({}, { locale: 'en' }));
    expect(window.document.activeElement).toBe(work(firstWork).querySelector('details'));
    expect(work(firstWork).querySelector('a')?.getAttribute('href')).toContain(firstRelease + '-later');
  } finally {
    readChildren = releaseSearchQuery.readReleaseSearchChildren;
    await act(async () => root.unmount());
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('current release visits retire pending windows and bound cursor progress without reviving prior visits', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const { browserObservation, addressLease } = await import('../src/session');
  const { useReaderResponseOrigin } = await import('../src/session/reader');
  const { sessionQueryKey } = await import('../src/session/browser-state');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search/releases' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const client = new QueryClient();
  client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'one' });
  const observation = browserObservation(client);
  const stop = observation.subscribe(() => {});
  const makeReader = () => {
    const snapshot = observation.getSnapshot();
    const lease = addressLease(() => observation.getSnapshot() === snapshot);
    return { lifetime: {}, isCurrent: lease.current };
  };
  let reader = makeReader();
  const parsed = parseReleaseSearch(
    { subtype: releaseType, language: 'ja, en', gte: '2024-02', threshold: '1' },
    bundledRelease,
    'en',
  );
  const workId = '018f0000-0000-7000-8000-000000000032';
  const page = parseReleaseSearchGroupsPage({
    status: 'ready',
    groups: [
      {
        kind: 'work',
        id: workId,
        work: groupedCard({ year: 2024 }, workId, 'schema:CreativeWork', 'Window work'),
        releases: [groupedCard({ year: 2024 }, releaseId, releaseType, 'Preview edition')],
        next: 'initial',
      },
    ],
    next: 'group-next',
    as_of: '2026-11-04T00:00:00Z',
  })!;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  let locale = 'en';
  let currentParsed = parsed;
  let currentPage = page;
  const groupKey = ['release-child-checkpoint'];
  client.setQueryData(groupKey, { checkpoint: page.as_of });
  function ReadingPage() {
    const responseCurrent = useReaderResponseOrigin(client, groupKey, () => true);
    const parent = reader;
    const ref = useRef<{ parent: typeof reader; origin: typeof reader } | null>(null);
    if (!ref.current || ref.current.parent !== parent || !ref.current.origin.isCurrent()) {
      ref.current = { parent, origin: { lifetime: {}, isCurrent: () => parent.isCurrent() && responseCurrent() } };
    }
    return createElement(ReleaseSearchPage, {
      locale,
      parsed: currentParsed,
      reader: ref.current.origin,
      state: { status: 'ready', page: currentPage },
    });
  }
  const render = () => act(async () => root.render(createElement(ReadingPage)));
  const group = () => host.querySelector(`[data-release-work="${workId}"]`)!;
  const button = () => group().querySelector('button') as HTMLButtonElement | null;
  const open = async () =>
    act(async () => {
      group().querySelector('summary')!.click();
    });
  const click = async () =>
    act(async () => {
      button()!.click();
    });
  const deferred: { resolve: (result: ChildReaderResult) => void; signal: AbortSignal | undefined }[] = [];
  const calls: ChildReaderInput[] = [];
  readChildren = (input) => {
    calls.push(input);
    return new Promise((resolve) => deferred.push({ resolve, signal: input.signal }));
  };
  const ready = (next: string | null, count = 1): ChildReaderResult => ({
    status: 'ready',
    page: {
      status: 'ready',
      children: Array.from(
        { length: count },
        (_, i) =>
          groupedCard(
            { year: 2024 },
            `${releaseId}-window-${i}`,
            releaseType,
            `Current edition ${i}`,
          ) as unknown as ChildCard,
      ),
      next,
      as_of: page.as_of,
    },
  });
  const complete = async (result: ChildReaderResult) =>
    act(async () => {
      deferred.at(-1)!.resolve(result);
    });
  try {
    await render();
    await open();
    await click();
    await complete(ready('second', 20));
    expect(group().querySelectorAll('ul > li')).toHaveLength(20);
    expect(group().textContent).not.toContain('Preview edition');
    currentParsed = structuredClone(parsed);
    currentPage = structuredClone(page);
    await render(); // Equivalent values keep the same deliberate expansion and accepted window.
    expect(group().querySelector('details')!.open).toBe(true);
    expect(group().querySelectorAll('ul > li')).toHaveLength(20);
    button()!.focus();
    await click();
    button()!.blur(); // Loading can move browser focus to the body without a new visitor intent.
    await complete(ready('recover', 20));
    expect(window.document.activeElement).toBe(button());
    await click();
    const elsewhere = host.querySelector('[name="q"]') as HTMLInputElement;
    elsewhere.focus();
    await complete(ready('after-focus', 20));
    expect(window.document.activeElement).toBe(elsewhere);
    for (const replace of [
      () => {
        currentParsed = parseReleaseSearch({ ...parsed.form, q: 'B' }, bundledRelease, locale);
      },
      () => {
        currentParsed = parsed;
      }, // A/B/A cannot revive A's prior window.
      () => {
        locale = 'ja';
      },
      () => {
        currentPage = { ...page, as_of: '2026-11-05T00:00:00Z' };
      },
      () => {
        client.setQueryData(groupKey, { checkpoint: page.as_of });
      }, // A new native response, even with equal data.
      () => {
        client.setQueryData(sessionQueryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'two' });
        expect(reader.isCurrent()).toBe(false); // Same principal, actual Web observation replacement.
        reader = makeReader();
      },
    ]) {
      await click();
      const pending = deferred.at(-1)!;
      await act(async () => {
        replace();
      });
      await render();
      expect(pending.signal?.aborted).toBe(true);
      expect(group().textContent).not.toContain('Current edition');
      expect(group().querySelector('details')!.open).toBe(false);
      await complete(ready('stale'));
      expect(group().textContent).not.toContain('Current edition');
      await open();
      await click();
      await complete(ready('second'));
    }
    expect(JSON.parse(calls.at(-1)!.data.rawJson).language).toBe('ja, en');
    expect(JSON.parse(calls.at(-1)!.data.rawJson).gte).toBe('2024-02');
    expect(JSON.parse(calls.at(-1)!.data.rawJson).threshold).toBe('1');
    await click();
    await complete(ready('second', 0)); // A ready repeated token is not preparing or EOF.
    expect(button()).toBeNull();
    expect(group().textContent).toContain(m.release_search_child_window({ count: 0 }, { locale: 'ja' }));
    expect(group().textContent).toContain(m.release_search_child_restart_needed({}, { locale: 'ja' }));
    expect(group().textContent).not.toContain(m.release_search_terminal({}, { locale: 'ja' }));
    expect(group().querySelector('a')!.getAttribute('href')).not.toContain('cursor=');

    currentPage = { ...currentPage, as_of: '2026-11-06T00:00:00Z' };
    await render();
    await open();
    await click();
    await complete({
      status: 'preparing',
      page: { status: 'preparing', children: [], next: 'initial', as_of: page.as_of },
    });
    expect(button()).not.toBeNull(); // Native preparing can retry its own token deliberately.
    expect(group().textContent).toContain('Preview edition');
    for (let i = 1; i <= 12; i++) {
      await click();
      await complete(ready(`progress-${i}`));
    }
    expect(button()).toBeNull();
    expect(group().textContent).toContain(m.release_search_child_restart_needed({}, { locale: 'ja' }));
    expect(group().querySelectorAll('ul > li')).toHaveLength(1);

    for (const status of ['restart', 'denied', 'invalid', 'unavailable'] as const) {
      currentPage = { ...currentPage, as_of: new Date(Date.parse(currentPage.as_of) + 86400000).toISOString() };
      await render();
      await open();
      await click();
      await complete(ready('refusal'));
      await click();
      await complete({ status });
      expect(group().textContent?.includes('Current edition')).toBe(status === 'unavailable');
      expect(button() !== null).toBe(status === 'unavailable');
    }
    let immediateCalls = 0;
    readChildren = async () => {
      immediateCalls++;
      return ready('immediate');
    };
    await act(async () => {
      button()!.click();
      await Promise.resolve();
      button()?.click();
    });
    expect(immediateCalls).toBe(1);
    readChildren = (input) => new Promise((resolve) => deferred.push({ resolve, signal: input.signal }));
    await click();
    const pending = deferred.at(-1)!;
    await act(async () => root.unmount());
    expect(pending.signal?.aborted).toBe(true);
    await complete(ready(null)); // Ignored cancellation must not apply after disposal.
    expect(host.textContent).toBe('');
  } finally {
    readChildren = releaseSearchQuery.readReleaseSearchChildren;
    await act(async () => root.unmount());
    stop();
    client.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
