import { expect, test } from 'bun:test';
import type { RealmView } from '../realm/realm-page.tsx';
import { applyCatalogueYear, catalogueBrowseQuery, YEAR_PAGES } from './catalogue-browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import type { readPublicationYears, readPublicationYearWorks } from './catalogue-facts.ts';
import { messages } from './messages.ts';

// More members than one request can read. Each publication-year page names one of them, so the
// 8-page bound stops the first screen while a cursor remains and every match is already shown.
const WORKS = YEAR_PAGES * 3 + 2;
const OTHER = 'https://rezics.com/id/other-zone';

function workId(index: number): string {
  return `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

const works: typeof readPublicationYearWorks = async resources => ({ ok: true,
  data: new Map(resources.map(reference => [reference, {
    id: reference, title: null, cover: null, types: ['https://schema.org/TVSeries'], tagline: null,
    completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
  } as never])) });

function model(): BrowseModel {
  return {
    title: '', searchLabel: '', placeholder: '', action: '/browse', kept: [],
    state: { text: null, sort: null, view: 'list', filter: {}, cursor: null },
    groups: [], chosen: [], filtersLabel: '', clearHref: null, sorts: [], views: [],
    results: '', notes: [], items: [], next: null, first: null,
  };
}

const view = {
  kind: 'view',
  zone: { links: { browse: '/browse' } },
  context: { locale: 'en', ref: 'anime', realm: 'https://rezics.com/id/realm' },
  zoneMessages: messages,
  pkg: null,
} as unknown as RealmView;

test('the restored all-years directory pages the publication-year template in its existing order', async () => {
  const ids = Array.from({ length: WORKS }, (_, index) => workId(index));
  const pages = new Map<string, { items: { id: string; year: number; statement: string }[]; nextCursor: string | null }>();
  for (let index = 0; index < WORKS; index++) {
    const key = index === 0 ? '' : `page-${index}`;
    const items = [{ id: ids[index]!, year: 1995, statement: `https://rezics.com/id/statement-${index}` }];
    pages.set(key, { items, nextCursor: index + 1 < WORKS ? `page-${index + 1}` : null });
  }
  const calls: { cursor: string | undefined; fromYear?: number; toYear?: number }[] = [];
  const publicationYears = (async (parameters, cursor) => {
    calls.push({ cursor, ...parameters });
    const page = pages.get(cursor ?? '');
    if (!page) return { ok: true as const, data: { items: [], nextCursor: null } };
    return { ok: true as const, data: page };
  }) as typeof readPublicationYears;

  const seen: string[] = [];
  const readCursors: (string | undefined)[] = [];
  let search: Record<string, string> = { years: '1' };
  let ended = false;
  for (let step = 0; step < 10; step++) {
    const before = calls.length;
    const page = model();
    const result = await applyCatalogueYear({ view, search, model: page }, { publicationYears, works });
    const requested = calls.slice(before);
    expect(result.failure).toBeNull();
    expect(page.complete).toBe(page.next === null);
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThanOrEqual(YEAR_PAGES);
    expect(requested.every(call => call.fromYear === undefined && call.toYear === undefined)).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.some(item => item.id === OTHER)).toBe(false);
    for (const item of page.items) {
      expect(seen).not.toContain(item.id);
      seen.push(item.id);
    }
    for (const call of requested) {
      expect(readCursors).not.toContain(call.cursor);
      readCursors.push(call.cursor);
    }
    expect(requested[0]?.cursor).toBe(search.yearCursor);
    if (!page.next) {
      ended = true;
      break;
    }
    const next = new URL(page.next, 'https://rezics.local');
    expect(next.searchParams.has('yearOffset')).toBe(false);
    expect(next.searchParams.get('years')).toBe('1');
    const yearCursor = next.searchParams.get('yearCursor');
    expect(yearCursor).toBeTruthy();
    expect(yearCursor).not.toBe(search.yearCursor ?? null);
    search = { years: '1', yearCursor: yearCursor! };
  }

  expect(ended).toBe(true);
  expect(seen).toEqual(ids);
  expect(search.yearCursor).toBe(`page-${YEAR_PAGES * 3}`);
});

test('an empty scoped year window still links forward to a later matching Work', async () => {
  // The year owner may need bounded windows before a matching Condition appears.
  const ours = [workId(1), workId(2)];
  const others = YEAR_PAGES * 2;
  const keys = Array.from({ length: others + ours.length }, (_, index) => (index === 0 ? '' : `page-${index}`));
  const pages = new Map(keys.map((key, index) => [key, {
    items: index < others ? [] : [{ id: ours[index - others]!, year: 2001,
      statement: `https://rezics.com/id/statement-${index}` }],
    nextCursor: index + 1 < keys.length ? `page-${index + 1}` : null,
  }]));
  const publicationYears = (async (_parameters, cursor) =>
    ({ ok: true as const, data: pages.get(cursor ?? '') ?? { items: [], nextCursor: null } })) as typeof readPublicationYears;


  const seen: string[] = [];
  const screens: number[] = [];
  let search: Record<string, string> = { years: '1' };
  for (let step = 0; step < 6; step++) {
    const page = model();
    await applyCatalogueYear({ view, search, model: page }, { publicationYears, works });
    screens.push(page.items.length);
    seen.push(...page.items.map(item => item.id));
    if (!page.next) break;
    const yearCursor = new URL(page.next, 'https://rezics.local').searchParams.get('yearCursor');
    expect(yearCursor).toBeTruthy();
    expect(yearCursor).not.toBe(search.yearCursor ?? null);
    search = { years: '1', yearCursor: yearCursor! };
  }
  expect(screens[0]).toBe(0);
  expect(seen).toEqual(ours);
});

test('the directory hydrates returned IDs beyond the former roster and preserves the year owner scope', async () => {
  const beyond = workId(1001);
  let scope: unknown;
  let hydrated: readonly string[] = [];
  const publicationYears: typeof readPublicationYears = async parameters => {
    scope = parameters;
    return { ok: true, data: { items: [{ id: beyond, year: 1995, statement: workId(99) }], nextCursor: null } };
  };
  const hydrate: typeof readPublicationYearWorks = async (ids, realm) => {
    hydrated = ids;
    expect(realm).toBe(view.context.realm);
    return works(ids, realm);
  };
  const page = model();
  const result = await applyCatalogueYear({ view, search: { years: '1', q: 'orbital',
    type: 'schema:TVSeries', status: 'completed' }, model: page }, { publicationYears, works: hydrate });
  expect(scope).toEqual({ realm: view.context.realm, text: 'orbital', filter: { all: [
    { facet: 'type', any: ['https://schema.org/TVSeries'] }, { facet: 'status', any: ['completed'] },
  ] } });
  expect(hydrated).toEqual([beyond]);
  expect(page.items.map(item => item.id)).toEqual([beyond]);
  expect(result.publicationYears.get(beyond)).toEqual([1995]);
  expect(result.failure).toBeNull();
});

test('the selected year and existing Conditions go together to Zone browse', () => {
  expect(catalogueBrowseQuery({ year: '1995', cursor: 'api-page-two', q: 'story',
    status: 'completed', type: 'schema:Book', sort: 'updated' })).toEqual({
    publicationYear: '1995', cursor: 'api-page-two', q: 'story', status: ['completed'],
    type: ['https://schema.org/Book'], sort: 'updated',
  });
});

test('the all-years flag leaves the previous directory source unchanged; a selected year wins', () => {
  expect(catalogueBrowseQuery({ years: '1' })).toEqual({});
  expect(catalogueBrowseQuery({ year: '2001', years: '1' })).toEqual({ publicationYear: '2001' });
  expect(catalogueBrowseQuery({ year: '10000' })).toEqual({});
  expect(catalogueBrowseQuery({})).toEqual({});
});
