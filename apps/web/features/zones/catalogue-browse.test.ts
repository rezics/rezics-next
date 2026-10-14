import { expect, test } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RealmView } from '../realm/realm-page.tsx';
import type { readZoneBrowse } from '../realm/read.ts';
import { applyCatalogueYear, catalogueBrowseQuery, MEMBER_PAGES, YEAR_PAGES } from './catalogue-browse.tsx';
import type { BrowseModel } from './browse-view.ts';
import type { readPublicationYears } from './catalogue-facts.ts';
import { messages } from './messages.ts';

// More members than one request can read. Each publication-year page names one of them, so the
// 8-page bound stops the first screen while a cursor remains and every match is already shown.
const WORKS = YEAR_PAGES * 3 + 2;
const OTHER = 'https://rezics.com/id/other-zone';

function workId(index: number): string {
  return `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function card(id: string) {
  return {
    id, title: null, cover: null, types: [], tagline: null, completionStatus: null,
    chapterCount: null, wordCount: null, lastUpdatedAt: null, inZone: false as const, evidence: null,
  };
}

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
    if (index === 0) items.push({ id: OTHER, year: 1995, statement: 'https://rezics.com/id/statement-other' });
    pages.set(key, { items, nextCursor: index + 1 < WORKS ? `page-${index + 1}` : null });
  }
  const calls: { cursor: string | undefined; fromYear?: number; toYear?: number }[] = [];
  const publicationYears = (async (parameters, cursor) => {
    calls.push({ cursor, ...parameters });
    const page = pages.get(cursor ?? '');
    if (!page) return { ok: true as const, data: { items: [], nextCursor: null } };
    return { ok: true as const, data: page };
  }) as typeof readPublicationYears;
  const zoneBrowse = (async () => ({
    ok: true as const,
    data: { items: ids.map(card), nextCursor: null },
  })) as unknown as typeof readZoneBrowse;

  const seen: string[] = [];
  const readCursors: (string | undefined)[] = [];
  let search: Record<string, string> = { years: '1' };
  let ended = false;
  for (let step = 0; step < 10; step++) {
    const before = calls.length;
    const page = model();
    const result = await applyCatalogueYear({ view, search, model: page }, { publicationYears, zoneBrowse });
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

test('a screen whose read found only other Zones\' Works still links forward to this Zone\'s Works', async () => {
  // The year read is platform-wide, so whole screens can hold no member of this Zone.
  const ours = [workId(1), workId(2)];
  const others = YEAR_PAGES * 2;
  const keys = Array.from({ length: others + ours.length }, (_, index) => (index === 0 ? '' : `page-${index}`));
  const pages = new Map(keys.map((key, index) => [key, {
    items: [{ id: index < others ? `${OTHER}-${index}` : ours[index - others]!, year: 2001,
      statement: `https://rezics.com/id/statement-${index}` }],
    nextCursor: index + 1 < keys.length ? `page-${index + 1}` : null,
  }]));
  const publicationYears = (async (_parameters, cursor) =>
    ({ ok: true as const, data: pages.get(cursor ?? '') ?? { items: [], nextCursor: null } })) as typeof readPublicationYears;
  const zoneBrowse = (async () => ({ ok: true as const, data: { items: ours.map(card), nextCursor: null } })) as unknown as typeof readZoneBrowse;

  const seen: string[] = [];
  const screens: number[] = [];
  let search: Record<string, string> = { years: '1' };
  for (let step = 0; step < 6; step++) {
    const page = model();
    await applyCatalogueYear({ view, search, model: page }, { publicationYears, zoneBrowse });
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

test('the restored all-years directory retains its roster-bound notice', async () => {
  let pages = 0;
  const zoneBrowse = (async () => {
    pages += 1;
    return { ok: true as const, data: { items: [card(workId(pages))], nextCursor: `page-${pages}` } };
  }) as unknown as typeof readZoneBrowse;
  const publicationYears = (async () =>
    ({ ok: true as const, data: { items: [], nextCursor: null } })) as typeof readPublicationYears;
  const browseHeader = (props: { year?: { bounded: boolean; window: number } | null }): ReactNode =>
    props.year?.bounded
      ? createElement('p', null, `first ${props.year.window} Works in the current order, and may miss others`)
      : null;
  const capped = { ...view, pkg: { slots: { browseHeader } } } as unknown as RealmView;
  const result = await applyCatalogueYear(
    { view: capped, search: { years: '1' }, model: model() },
    { publicationYears, zoneBrowse });
  expect(pages).toBe(MEMBER_PAGES);
  expect(renderToStaticMarkup(result.header)).toContain(
    `first ${MEMBER_PAGES} Works in the current order, and may miss others`);
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
