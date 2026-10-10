import { expect, test } from 'bun:test';
import type { RealmView } from '../realm/realm-page.tsx';
import type { readZoneBrowse } from '../realm/read.ts';
import { applyCatalogueYear, YEAR_PAGES } from './catalogue-browse.tsx';
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

test('paging a year past one read reaches every Work once and never links an empty page', async () => {
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
  let search: Record<string, string> = { year: '1995' };
  let ended = false;
  for (let step = 0; step < 10; step++) {
    const before = calls.length;
    const page = model();
    const result = await applyCatalogueYear({ view, search, model: page }, { publicationYears, zoneBrowse });
    const requested = calls.slice(before);
    expect(result.failure).toBeNull();
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.length).toBeLessThanOrEqual(YEAR_PAGES);
    expect(requested.every(call => call.fromYear === 1995 && call.toYear === 1995)).toBe(true);
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
    expect(next.searchParams.get('year')).toBe('1995');
    const yearCursor = next.searchParams.get('yearCursor');
    expect(yearCursor).toBeTruthy();
    expect(yearCursor).not.toBe(search.yearCursor ?? null);
    search = { year: '1995', yearCursor: yearCursor! };
  }

  expect(ended).toBe(true);
  expect(seen).toEqual(ids);
  expect(search.yearCursor).toBe(`page-${YEAR_PAGES * 3}`);
});
