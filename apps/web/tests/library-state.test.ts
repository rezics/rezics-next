import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { mainLibraryApi } from '../features/library/api.ts';
import { libraryItems, storyAgent } from '../features/library/fixtures.ts';
import { dayText, formatDay, formatDayRange, momentText } from '../features/library/format.ts';
import { libraryHref, PAGE_SIZE, pageOf, parseLibraryState, sortLibrary, sortsFor, withSort }
  from '../features/library/state.ts';
import type { LibraryItem } from '../features/library/types.ts';
import { isPublicPagePath, localizedPath } from '../i18n/locale.ts';

const shelfId = '00000062-5a1b-4c2d-8e3f-a0b1c2d3e4f5';
const titles = (items: readonly LibraryItem[]) => items.map(item => item.work.title?.value.split(/[;:]/)[0]);

describe('library addresses', () => {
  test('a bare address is All, newest first, as a list on the first page', () => {
    expect(parseLibraryState({})).toEqual({ shelf: { kind: 'all' }, sort: 'added', order: 'desc', layout: 'list',
      page: 1 });
    expect(libraryHref(parseLibraryState({}))).toBe('/library');
  });

  test('unknown values fall back rather than fail', () => {
    expect(parseLibraryState({ shelf: 'to-read', sort: 'author', order: 'up', view: 'table', page: '-2' }))
      .toEqual(parseLibraryState({}));
    expect(parseLibraryState({ page: ['2', '3'] }).page).toBe(1);
    expect(parseLibraryState({ shelf: 'not-a-uuid' }).shelf).toEqual({ kind: 'all' });
  });

  test('Date finished is offered only where Read Works are; a custom shelf keeps its own order', () => {
    expect(sortsFor({ kind: 'all' })).toContain('finished');
    expect(sortsFor({ kind: 'status', status: 'read' })).toContain('finished');
    expect(sortsFor({ kind: 'status', status: 'reading' })).not.toContain('finished');
    expect(sortsFor({ kind: 'custom', id: shelfId })).toEqual([]);
    expect(parseLibraryState({ shelf: 'reading', sort: 'finished' }).sort).toBe('added');
    expect(libraryHref(parseLibraryState({ shelf: shelfId, sort: 'title', order: 'asc' })))
      .toBe(`/library?shelf=${shelfId}`);
  });

  test('each sort starts in its own direction and only a reversed one is written', () => {
    const read = parseLibraryState({ shelf: 'read' });
    expect(libraryHref(read, withSort(read, 'title'))).toBe('/library?shelf=read&sort=title');
    expect(libraryHref(read, { ...withSort(read, 'title'), order: 'desc' }))
      .toBe('/library?shelf=read&sort=title&order=desc');
    expect(parseLibraryState({ sort: 'title' }).order).toBe('asc');
    expect(parseLibraryState({ sort: 'rating', order: 'asc' }).order).toBe('asc');
  });

  test('a new shelf, sort or order starts at the first page; a new layout keeps the page', () => {
    const third = parseLibraryState({ shelf: 'read', page: '3' });
    expect(libraryHref(third, { layout: 'grid' })).toBe('/library?shelf=read&view=grid&page=3');
    expect(libraryHref(third, { shelf: { kind: 'status', status: 'reading' } })).toBe('/library?shelf=reading');
    expect(libraryHref(third, withSort(third, 'rating'))).toBe('/library?shelf=read&sort=rating');
    expect(libraryHref(third, { page: 4 })).toBe('/library?shelf=read&page=4');
  });

  test('Library is a page: locale-prefixed and redirected from the bare path', () => {
    expect(isPublicPagePath('/library')).toBe(true);
    expect(isPublicPagePath('/zh-Hans/library')).toBe(true);
    expect(localizedPath('/library?shelf=read', 'zh-Hans')).toBe('/zh-Hans/library?shelf=read');
  });
});

describe('library order', () => {
  test('date added is newest first, and reversed oldest first', () => {
    const newest = sortLibrary(libraryItems, 'added', 'desc', 'en');
    expect(newest[0]!.work.title?.value).toBe('Little Women');
    expect(sortLibrary(libraryItems, 'added', 'asc', 'en')[0]!.work.title?.value).toBe('Frankenstein; or, The Modern Prometheus');
  });

  test('titles sort by the reader’s language, Latin and CJK alike', () => {
    const read = libraryItems.filter(item => item.status === 'read');
    expect(titles(sortLibrary(read, 'title', 'asc', 'en')))
      .toEqual(['Frankenstein', 'Pride and Prejudice', '红楼梦', '西游记']);
    // Chinese collation puts Han titles first, in pinyin order: hóng before xī.
    expect(titles(sortLibrary(read, 'title', 'asc', 'zh-Hans')))
      .toEqual(['红楼梦', '西游记', 'Frankenstein', 'Pride and Prejudice']);
  });

  test('Works with nothing to sort by come last in either direction', () => {
    for (const order of ['asc', 'desc'] as const) {
      const rated = sortLibrary(libraryItems, 'rating', order, 'en');
      const firstUnrated = rated.findIndex(item => item.rating === null);
      expect(rated.slice(firstUnrated).every(item => item.rating === null)).toBe(true);
      const read = sortLibrary(libraryItems, 'last-read', order, 'en');
      expect(read.at(-1)!.lastReadAt).toBeNull();
    }
    expect(sortLibrary(libraryItems, 'rating', 'desc', 'en').slice(0, 3).map(item => item.rating)).toEqual([5, 5, 4]);
    // Equal stars keep the most recently shelved first.
    expect(titles(sortLibrary(libraryItems, 'rating', 'desc', 'en').slice(0, 2))).toEqual(['Pride and Prejudice', '红楼梦']);
  });

  test('date finished orders only Read Works, newest first', () => {
    const finished = sortLibrary(libraryItems, 'finished', 'desc', 'en');
    expect(titles(finished.slice(0, 2))).toEqual(['红楼梦', 'Pride and Prejudice']);
    expect(finished.slice(2).every(item => item.status !== 'read' || item.finishedOn === null)).toBe(true);
  });

  test('pages hold one reader-state batch and a page past the end shows the last', () => {
    const many = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, index) => index);
    expect(pageOf(many, 1)).toMatchObject({ page: 1, pages: 3 });
    expect(pageOf(many, 3).items).toEqual([48, 49, 50]);
    expect(pageOf(many, 9).page).toBe(3);
    expect(pageOf([], 4)).toEqual({ items: [], page: 1, pages: 1 });
  });
});

describe('reading dates', () => {
  test('calendar days print as the reader wrote them, in any time zone', () => {
    expect(formatDay('2026-01-02', 'en')).toBe('Jan 2, 2026');
    expect(formatDay('2026-01-02T23:30:00Z', 'en')).toBe('Jan 2, 2026');
    expect(formatDayRange('2026-01-02', '2026-01-12', 'en')).toBe('Jan 2 – 12, 2026');
    // Each runtime's ICU words a Chinese range its own way; both days are always there.
    expect(formatDayRange('2026-01-02', '2026-01-12', 'zh-Hans')).toMatch(/2026\D+1\D+2\D+(?:.*\D)?12/);
    expect(formatDayRange(null, '2026-02-14', 'en')).toBe('Feb 14, 2026');
    expect(formatDayRange(null, null, 'en')).toBeNull();
  });

  test('Main’s dates arrive as Eden’s Dates or Postgres text and leave as the strings the types promise', () => {
    // Eden revives `YYYY-MM-DD` as UTC midnight.
    expect(dayText(new Date('2026-01-02'))).toBe('2026-01-02');
    expect(dayText('2026-01-02')).toBe('2026-01-02');
    expect(dayText(null)).toBeNull();
    expect(dayText(new Date(Number.NaN))).toBeNull();
    expect(momentText('2026-09-28 01:48:53.719795+00')).toBe('2026-09-28T01:48:53.719Z');
    expect(momentText('2026-09-28 09:48:53+08')).toBe('2026-09-28T01:48:53.000Z');
    expect(momentText(new Date('2026-09-28T01:48:53Z'))).toBe('2026-09-28T01:48:53.000Z');
    expect(momentText('yesterday')).toBeNull();
    expect(momentText(undefined)).toBeNull();
  });
});

type Answer = { data: unknown; error: { status: number; value: unknown } | null };
const ok = (data: unknown): Answer => ({ data, error: null });
const conflict: Answer = { data: null, error: { status: 409, value: null } };

/** A stand-in for Main's Eden client: the calls Library makes, answered in order. */
function fakeMain(answers: Record<string, Answer[]>) {
  const calls: { name: string; body?: unknown; key?: string }[] = [];
  const answer = (name: string) => (body?: unknown, options?: { headers?: Record<string, string> }) => {
    calls.push({ name, body, key: options?.headers?.['idempotency-key'] });
    const next = answers[name]?.shift();
    if (!next) throw new Error(`Unexpected ${name}`);
    return Promise.resolve(next);
  };
  const works = () => ({ 'reader-status': { put: answer('reader-status') },
    'reader-state': { get: answer('reader-state') }, get: answer('work') });
  const collections = Object.assign(() => ({ get: answer('collection'), changes: { post: answer('changes') } }),
    { post: answer('create') });
  const main = { v1: { works, collections } } as unknown as MainClient;
  return { main: () => main, calls };
}

describe('library writes', () => {
  const work = libraryItems[3]!.work.id;

  test('dates compare and set; after another tab’s change they are written once more on the new version', async () => {
    const { main, calls } = fakeMain({
      'reader-status': [conflict, ok({ version: 9 })],
      'reader-state': [ok({ status: { status: 'read', version: 8 } })],
    });
    const written = await mainLibraryApi(storyAgent, main).setDates(work, 3,
      { startedOn: '2026-01-02', finishedOn: '2026-01-12' });
    expect(written).toEqual({ ok: true, data: { version: 9 } });
    expect(calls.map(call => [call.name, (call.body as { expectedVersion?: number } | undefined)?.expectedVersion]))
      .toEqual([['reader-status', 3], ['reader-state', undefined], ['reader-status', 8]]);
    // Each attempt is its own command.
    expect(new Set(calls.filter(call => call.key).map(call => call.key)).size).toBe(2);
  });

  test('dates are not forced onto a Work another tab moved off Read', async () => {
    const { main } = fakeMain({
      'reader-status': [conflict],
      'reader-state': [ok({ status: { status: 'reading', version: 8 } })],
    });
    expect(await mainLibraryApi(storyAgent, main).setDates(work, 3, { startedOn: null, finishedOn: '2026-01-12' }))
      .toEqual({ ok: false, failure: 'moved' });
  });

  test('adding to a shelf goes in Main’s batches of sixteen, each on the head the last one left', async () => {
    const works = Array.from({ length: 20 }, (_, index) => `https://rezics.com/id/${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`);
    const head = (revision: string) => ok({ revision, structure: 'https://rezics.com/id/structure' });
    const { main, calls } = fakeMain({
      collection: [head('r0'), head('r0'), head('r1'), head('r2')],
      changes: [ok({}), conflict, ok({})],
    });
    expect(await mainLibraryApi(storyAgent, main).addToShelf('https://rezics.com/id/shelf', works))
      .toEqual({ ok: true, data: null });
    const changes = calls.filter(call => call.name === 'changes')
      .map(call => call.body as { expectedHead: string; operations: Record<string, unknown>[] });
    expect(changes.map(change => [change.expectedHead, change.operations.length])).toEqual([['r0', 16], ['r1', 4],
      ['r2', 4]]);
    expect(changes[0]!.operations[0]).toEqual({ op: 'insert', parent: 'https://rezics.com/id/structure',
      position: 'last', role: 'member', target: works[0] });
  });
});
