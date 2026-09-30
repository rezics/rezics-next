import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { statusShelfItems } from '../features/library/read.ts';
import { libraryHref, parseLibraryState, withSort } from '../features/library/state.ts';
import type { StatusShelfItem } from '../features/library/types.ts';

const feature = join(import.meta.dir, '../features/library');

/** Comments are not behavior. A sort mentioned in a comment must not keep the guard green. */
function source(name: string) {
  return readFileSync(join(feature, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('G-891 class guard: the library does not sort or slice Main’s shelf items', () => {
  test('the shelf feature no longer windows or reorders a Main page', () => {
    for (const name of ['read.ts', 'state.ts', 'library-page.tsx', 'library-list.tsx', 'fixtures.ts']) {
      const code = source(name);
      expect(code, name).not.toMatch(/\bsortLibrary\b|\bpageOf\b|\bPAGE_SIZE\b|\bMAX_SHELF_PAGES\b/);
      expect(code, name).not.toMatch(/\.slice\s*\(\s*0\b/);
    }
    // Followed authors are ordered by their newest Work in the page component.
    // That list is not a shelf page, so it is outside this guard.
    for (const name of ['read.ts', 'state.ts', 'fixtures.ts', 'library-list.tsx']) {
      expect(source(name), name).not.toMatch(/\.sort\s*\(/);
    }
  });

  test('a status page keeps Main’s order, including a placeholder where the card is missing', () => {
    const id = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix}`;
    const later = id('000000000002');
    const missing = id('000000000001');
    const earlier = id('000000000003');
    const card = (work: string, title: string) => ({ id: work, title: { value: title, language: 'en',
      direction: 'ltr' as const, basis: 'requested' as const }, cover: null, types: ['https://schema.org/Book'] });
    const row = (work: string, title: string | null): StatusShelfItem => ({ work, status: 'read', startedOn: null,
      finishedOn: null, version: 1, changedAt: '2026-01-02T00:00:00.000Z',
      card: title ? card(work, title) : null }) as StatusShelfItem;
    // Deliberately not title order and not identifier order.
    const items = statusShelfItems([row(later, 'Zebra'), row(missing, null), row(earlier, 'Aardvark')]);
    expect(items.map(item => item.work.id)).toEqual([later, missing, earlier]);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ available: true, work: { title: { value: 'Zebra' } } });
    expect(items[1]).toMatchObject({ available: false, status: 'read', work: { title: null } });
    expect(items[2]?.work.title?.value).toBe('Aardvark');
  });

  test('the address keeps Main’s cursor and sort, and a new sort starts over', () => {
    const read = parseLibraryState({ shelf: 'read', sort: 'title', cursor: 'page-2' });
    expect(libraryHref(read)).toBe('/library?shelf=read&sort=title&cursor=page-2');
    expect(libraryHref(read, withSort(read, 'rating'))).toBe('/library?shelf=read&sort=rating');
    expect(libraryHref(read, { cursor: 'page-3' })).toBe('/library?shelf=read&sort=title&cursor=page-3');
    expect(parseLibraryState({ shelf: 'read', cursor: 'page-2' }).cursor).toBe('page-2');
  });
});
