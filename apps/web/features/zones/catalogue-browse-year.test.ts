import { replaceModule } from '../../tests/support/module-replacement.ts';
import { afterAll, expect, test } from 'bun:test';
import '../../tests/support/official-package-fixture.ts';
import { createElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowseSearch, ZoneBrowse } from './browse.tsx';
import { fictionZone } from './fixtures.ts';
import type { BrowseModel } from './browse-view.ts';
import type { RealmView } from '../realm/realm-page.tsx';
import { applyCatalogueYear, catalogueBrowseQuery } from './catalogue-browse.tsx';
import { browseModel } from './browse-view.ts';
import { chosenCount, parseBrowseState } from './browse-state.ts';
import { messages } from './messages.ts';
import { readPublicationYearWorks } from './catalogue-facts.ts';

const view = {
  kind: 'view',
  zone: { links: { browse: '/browse' } },
  context: { locale: 'en', ref: 'anime' },
  zoneMessages: messages,
  pkg: null,
} as unknown as Extract<RealmView, { kind: 'view' }>;

test.each(['1995', '1995-2001'])('%s Conditions survive the composed catalogue model', async year => {
  const search = { year, q: 'Lantern title', status: ['completed', 'ongoing'], length: '0-99999',
    sort: 'updated', view: 'grid', cursor: 'opaque/+ cursor=%2F==' };
  const state = parseBrowseState(search);
  const model = browseModel({ base: '/browse', zoneName: 'Manga', state, locale: 'en', messages,
    admitted: new Map(), page: { items: [], facets: { type: [], concept: [],
      status: [{ value: 'completed', count: 2 }, { value: 'ongoing', count: 1 }],
      length: [{ value: '0-99999', count: 2 }] },
    matches: { value: 3, kind: 'exact' }, window: { scanned: 3, complete: true },
    tags: 'current', nextCursor: 'next/+ cursor=%3D==', sort: 'updated' } });
  await applyCatalogueYear({ view, search, model });
  const fromHref = (href: string) => {
    const params = new URL(href, 'https://rezics.local').searchParams;
    return parseBrowseState(Object.fromEntries([...params.keys()].map(key => [key, params.getAll(key)])));
  };

  expect(model.action).toBe('/browse');
  expect(model.kept.filter(item => item.name === 'year')).toEqual([{ name: 'year', value: year }]);
  const form = renderToStaticMarkup(createElement(BrowseSearch, { action: model.action,
    label: model.searchLabel, placeholder: model.placeholder, value: state.text, kept: model.kept,
    submit: messages.search }));
  expect(form.match(/name="year"/g)).toHaveLength(1);
  const submitted = new URLSearchParams(model.kept.map(item => [item.name, item.value]));
  submitted.set('q', 'Another title');
  expect(fromHref(`${model.action}?${submitted}`)).toEqual({ ...state, text: 'Another title', sort: null, cursor: null });

  const removeYear = model.chosen.find(item => item.key === 'publicationYear')!;
  const { publicationYear: _year, ...withoutYear } = state;
  expect(fromHref(removeYear.href)).toEqual({ ...withoutYear, cursor: null });
  for (const condition of model.chosen.filter(item => item.key !== 'publicationYear')) {
    const removed = fromHref(condition.href);
    expect(removed).toMatchObject({ publicationYear: year, text: state.text, sort: state.sort,
      view: state.view, cursor: null });
    expect(chosenCount(removed)).toBe(chosenCount(state) - 1);
  }
  expect(fromHref(model.clearHref!)).toEqual({ text: state.text, sort: state.sort, view: state.view,
    filter: {}, cursor: null });
  expect(fromHref(model.next!)).toEqual({ ...state, cursor: 'next/+ cursor=%3D==' });
  expect(fromHref(model.first!)).toEqual({ ...state, cursor: null });
  for (const group of model.groups) for (const value of group.values) {
    expect(fromHref(value.href)).toMatchObject({ publicationYear: year, cursor: null });
    if (value.excludeHref) expect(fromHref(value.excludeHref)).toMatchObject({ publicationYear: year, cursor: null });
  }
  for (const sort of model.sorts) expect(fromHref(sort.href)).toEqual({ ...state, sort: sort.sort, cursor: null });
  for (const layout of model.views) expect(fromHref(layout.href)).toEqual({ ...state, view: layout.view });
});

test('a year view preserves the API second page, response counts and year-filtered Facets', async () => {
  // These members would be beyond the former ten 20-item member pages.
  const works = [201, 202].map((index) => ({ id: `https://rezics.com/id/${index}` }));
  const read = (query: ReturnType<typeof catalogueBrowseQuery>) => {
    expect(query.publicationYear).toBe('1995');
    return {
      items: query.cursor ? [works[1]!] : [works[0]!],
      facets: {
        type: [],
        concept: [],
        length: [],
        status: [
          { value: 'completed', count: 7 },
          { value: 'ongoing', count: 3 },
        ],
      },
      matches: {
        value: query.cursor ? 42 : 21,
        kind: query.cursor ? ('exact' as const) : ('lower-bound' as const),
      },
      window: { scanned: 64, complete: Boolean(query.cursor) },
      tags: 'current' as const,
      nextCursor: query.cursor ? null : 'api-page-two',
      sort: 'newest' as const,
    };
  };
  let search: Record<string, string> = { year: '1995', status: 'completed', view: 'grid' };
  const seen: string[] = [];
  for (let step = 0; step < 2; step++) {
    const response = read(catalogueBrowseQuery(search));
    const model = browseModel({
      base: '/browse',
      zoneName: 'Anime',
      state: parseBrowseState(search),
      admitted: new Map(),
      locale: 'en',
      messages,
      page: { ...response, items: response.items as never },
    });
    const counts = structuredClone(model.groups);
    const result = await applyCatalogueYear({ view, search, model });
    expect(result.failure).toBeNull();
    expect(model.groups.map((group) => group.values.map((value) => value.count))).toEqual(
      counts.map((group) => group.values.map((value) => value.count)),
    );
    expect(model.results).toBe(step === 0 ? '21+ results' : '42 results');
    expect(result.publicationYears.get(model.items[0]!.id)).toEqual([1995]);
    seen.push(...model.items.map((work) => work.id));
    expect(
      model.groups
        .flatMap((group) => group.values)
        .every((value) => value.href.includes('year=1995')),
    ).toBe(true);
    if (step === 0) {
      const url = new URL(model.next!, 'https://rezics.local');
      expect(url.searchParams.get('cursor')).toBe('api-page-two');
      expect(url.searchParams.has('yearCursor')).toBe(false);
      search = Object.fromEntries(url.searchParams);
    } else {
      expect(model.next).toBeNull();
      expect(model.first).toContain('year=1995');
    }
  }
  expect(seen).toEqual(works.map((work) => work.id));
});

// Keep RealmBrowseRoute and readZoneBrowse real. Only the Main transport is
// supplied here, so dropping the route's year query cannot pass this test.
const mainExports = { ...(await import('../api/main.ts')) };
const calls: { realm: string; query: Record<string, unknown> }[] = [];
let transport: (query: Record<string, unknown>) => unknown;
const directoryCalls: Record<string, unknown>[] = [];
let directoryTransport: (body: Record<string, unknown>) => unknown;
let creditCursor: string | null = null;
const restoreMainExports = replaceModule(import.meta.resolve('../api/main.ts'), mainExports, {
  mainApiWithToken: () => ({
    v1: {
      realms: ({ realm }: { realm: string }) => ({
        modules: {
          browse: {
            get: async ({ query }: { query: Record<string, unknown> }) => {
              calls.push({ realm, query });
              return { data: transport(query), error: null };
            },
          },
        },
      }),
      facets: { get: async () => ({ data: { facets: [] }, error: null }) },
      resources: { summaries: { post: async ({ resources }: { resources: string[] }) => ({
        data: { summaries: resources.map(reference => ({ reference, status: 'available', type: 'work',
          address: null })) }, error: null,
      }) } },
      works: ({ id }: { id: string }) => ({ get: async () => ({
        data: rawWork(Number(id.slice(-12))), error: null,
      }) }),
      query: {
        post: async (body: Record<string, unknown>) => {
          if (body.query === 'https://rezics.com/query/work-credits') return {
            data: { result: { profile: 'template-result-v1', query: body.query, items: [], nextCursor: creditCursor } }, error: null,
          };
          directoryCalls.push(body);
          return { data: { result: directoryTransport(body) }, error: null };
        },
      },
    },
  }),
});
afterAll(async () => {
  restoreMainExports();
});
const { RealmBrowseRoute } = await import('../realm/routes.tsx');

const native = (index: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const englishRecord = fictionZone('en').name;
const rawWork = (index: number) => ({
  id: native(index),
  title: {
    value: `Story ${index}`,
    language: englishRecord.lang,
    direction: englishRecord.dir,
    basis: 'requested',
  },
  cover: null,
  types: ['https://schema.org/Book'],
  tagline: null,
  completionStatus: null,
  chapterCount: null,
  wordCount: null,
  lastUpdatedAt: null,
  inZone: false,
  evidence: native(900),
  primaryCredits: [],
});
const apiPage = (
  items: ReturnType<typeof rawWork>[],
  value: number,
  nextCursor: string | null,
) => ({
  profile: 'zone-browse-v1',
  realm: native(999),
  items,
  nextCursor,
  query: { sort: 'newest' },
  facets: { type: [], concept: [], status: [], length: [] },
  matches: { value, kind: nextCursor ? 'lower-bound' : 'exact' },
  window: { scanned: 256, complete: !nextCursor },
  tags: 'current',
});
const routeView = {
  ...view,
  zone: fictionZone('en'),
  context: { locale: 'en', ref: 'anime', realm: native(999) },
  reader: { avatarQuery: '' },
  pkg: { catalogue: { count: 'episodes', formatNames: [] }, slots: {} },
} as unknown as Extract<RealmView, { kind: 'view' }>;

function browseElement(node: ReactNode): ReactElement<{ model: BrowseModel }> | null {
  if (Array.isArray(node)) return node.map(browseElement).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  return node.type === ZoneBrowse
    ? (node as ReactElement<{ model: BrowseModel }>)
    : browseElement(node.props.children);
}
async function routeModel(search: Record<string, string>) {
  const rendered = await RealmBrowseRoute(
    {
      params: Promise.resolve({ locale: 'en', realm: 'anime' }),
      searchParams: Promise.resolve(search),
    },
    async () => routeView,
  );
  const element = browseElement(rendered);
  if (!element) throw new Error('The real browse route did not render its browse view');
  return element.props.model;
}

test('the real route sends year on both API reads and preserves Next on an empty budget page', async () => {
  calls.length = 0;
  transport = (query) =>
    query.cursor ? apiPage([rawWork(300)], 1, null) : apiPage([], 0, 'api-member-256');
  const first = await routeModel({ year: '1995' });
  expect(first.items).toEqual([]);
  expect(first.results).toBe('0+ results');
  expect(first.next).toBeTruthy();
  const html = renderToStaticMarkup(
    createElement(ZoneBrowse, { model: first, messages, card: () => null }),
  );
  expect(html).toContain('Next');
  expect(html).toContain('cursor=api-member-256');
  const next = new URL(first.next!, 'https://rezics.local');
  const second = await routeModel(Object.fromEntries(next.searchParams));
  expect(second.items.map((item) => item.id)).toEqual([native(300)]);
  expect(second.results).toBe('1 result');
  expect(second.next).toBeNull();
  expect(calls).toEqual([
    { realm: native(999), query: { publicationYear: '1995' } },
    { realm: native(999), query: { publicationYear: '1995', cursor: 'api-member-256' } },
  ]);
});

test('the fallback route preserves combined format, status, title, sort and year on its opaque continuation', async () => {
  calls.length = 0;
  const pkg = routeView.pkg;
  routeView.pkg = null;
  transport = query => query.cursor ? apiPage([rawWork(301)], 2, null) : apiPage([rawWork(300)], 1, 'opaque-filtered-page');
  try {
    const first = await routeModel({ year: '2004', concept: native(42).slice(-36), status: 'completed',
      q: 'Original animation', sort: 'updated' });
    const next = new URL(first.next!, 'https://rezics.local');
    expect(next.searchParams.get('year')).toBe('2004');
    expect(next.searchParams.get('concept')).toBe(native(42).slice(-36));
    expect(next.searchParams.get('status')).toBe('completed');
    expect(next.searchParams.get('q')).toBe('Original animation');
    expect(next.searchParams.get('sort')).toBe('updated');
    const second = await routeModel(Object.fromEntries(next.searchParams));
    expect(second.items.map(work => work.id)).toEqual([native(301)]);
    expect(calls.map(call => call.query)).toEqual([
      { publicationYear: '2004', concept: [native(42)], status: ['completed'], q: 'Original animation', sort: 'updated' },
      { publicationYear: '2004', concept: [native(42)], status: ['completed'], q: 'Original animation', sort: 'updated', cursor: 'opaque-filtered-page' },
    ]);
  } finally { routeView.pkg = pkg; }
});

test('the real all-years route retains the previous publication-year template and ordering', async () => {
  calls.length = 0;
  directoryCalls.length = 0;
  const newestAdoption = rawWork(1995),
    olderAdoption = rawWork(2024);
  transport = () => apiPage([newestAdoption, olderAdoption], 2, null);
  directoryTransport = () => ({
    profile: 'template-result-v1',
    query: 'https://rezics.com/query/work-publication-years',
    items: [
      { id: olderAdoption.id, year: 2024, statement: native(801) },
      { id: newestAdoption.id, year: 1995, statement: native(802) },
    ],
    nextCursor: null,
  });
  const model = await routeModel({ years: '1' });
  expect(model.items.map((item) => item.id)).toEqual([olderAdoption.id, newestAdoption.id]);
  expect(calls).toEqual([
    { realm: native(999), query: {} },
  ]);
  expect(directoryCalls).toEqual([
    {
      profile: 'template-query-v1',
      query: 'https://rezics.com/query/work-publication-years',
      revision: 1,
      parameters: { realm: native(999), filter: { all: [] } },
      limit: 20,
    },
  ]);
});

// A bounded credit read may refuse a card; it must never publish a partial author list.
test('year cards refuse incomplete credits instead of presenting partial authorship', async () => {
  creditCursor = 'more-authors';
  try {
    expect(await readPublicationYearWorks([native(201)], native(999)))
      .toEqual({ ok: false, failure: 'unavailable' });
  } finally { creditCursor = null; }
  const complete = await readPublicationYearWorks([native(201)], native(999));
  expect(complete.ok).toBe(true);
  if (complete.ok) expect(complete.data.get(native(201))?.primaryCredits).toEqual([]);
});
