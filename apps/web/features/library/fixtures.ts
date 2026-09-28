import type { UiLocale } from '../../i18n/define.ts';
import { chinese, classics, memoryReaderActions } from '../catalogue/fixtures.ts';
import type { ReaderWorkState } from '../catalogue/reader-actions.tsx';
import type { CatalogueWork } from '../catalogue/work.ts';
import type { LibraryApi } from './api.ts';
import type { ShelfView } from './read.ts';
import { type LibraryState, pageOf, parseLibraryState, sortLibrary, statusShelves } from './state.ts';
import type { CustomShelf, LibraryItem, LibraryOverview, LibraryRow, Loaded, Review, ShelfStatus } from './types.ts';

// Story data shaped as Main answers it, and a Library API that keeps its
// state in memory, standing in for Main's reader library, reviews and
// Collections (G-285, G-294, G-302, G-315).

export const storyAgent = 'https://rezics.com/id/00000077-7c1d-4e2f-9a3b-5c6d7e8f9a0b';
export const storyContext = 'https://rezics.com/id/00000500-7c1d-4e2f-9a3b-5c6d7e8f9a0b';
/** The stories' clock: 28 September 2026, noon UTC. */
export const storyNow = Date.UTC(2026, 8, 28, 12);
const hoursAgo = (hours: number) => new Date(storyNow - hours * 3_600_000).toISOString();

const shelf = (n: number, name: string, disclosure: 'public' | 'private'): CustomShelf => ({
  id: `https://rezics.com/id/${String(n).padStart(8, '0')}-5a1b-4c2d-8e3f-a0b1c2d3e4f5`, revision: storyAgent,
  name, kind: 'static', disclosure, structure: storyAgent, changedSequence: String(n) });
export const bookClub = shelf(61, 'Book club · 读书会', 'public');
export const comfortReads = shelf(62, 'Comfort reads', 'private');
export const customShelves = [bookClub, comfortReads];

const byTitle = (works: CatalogueWork[], title: string) => works.find(work => work.title?.value.startsWith(title))!;
const serial = byTitle(chinese, '雨夜书店');

function item(work: CatalogueWork, status: ShelfStatus | null, shelved: number, extra: Partial<LibraryRow> = {}):
  LibraryRow {
  return { work: { ...work, rating: null, tagline: null }, status, version: 3, shelvedAt: hoursAgo(shelved),
    startedOn: null, finishedOn: null, rating: null, lastReadAt: null, customShelves: [], ...extra };
}

function review(work: CatalogueWork, text: string, language: string, rating: number, spoiler = false): Loaded<Review> {
  return { ok: true, data: { id: `${work.id.slice(-36, -12)}aaaaaaaaaaaa`, work: work.id, context: storyContext,
    realm: null, author: storyAgent, rating, ratingObservation: storyContext, ratingRevision: storyContext, language,
    text, spoiler, spoilerWithheld: false, startedOn: null, finishedOn: null, helpfulCount: 3, viewerHelpful: false,
    viewerVoteRevision: null, revision: `${work.id.slice(-36, -12)}bbbbbbbbbbbb`, createdAt: hoursAgo(300),
    updatedAt: hoursAgo(300) } };
}

/** A reader part-way through three Works, with a read history of four and five more to read. */
export const libraryItems: LibraryRow[] = [
  item(serial, 'reading', 20, { lastReadAt: hoursAgo(3), customShelves: [bookClub],
    progress: { next: { title: '第十章 · 雨停之前', href: `/w/${serial.id.slice(-36)}/read/chapter-10` },
      left: { value: 3, kind: 'exact' }, chapters: { read: 9, total: 12 } } }),
  item(byTitle(classics, 'Middlemarch'), 'reading', 200, { lastReadAt: hoursAgo(50),
    progress: { next: { title: 'Book II: Old and Young', href: '/w/middlemarch/read/book-2' },
      left: { value: 20, kind: 'lower-bound' }, chapters: null } }),
  item(byTitle(classics, 'Jane Eyre'), 'reading', 400, { progress: null }),
  item(byTitle(classics, 'Pride and Prejudice'), 'read', 900, { startedOn: '2026-01-02', finishedOn: '2026-01-12',
    rating: 5, lastReadAt: hoursAgo(6000), customShelves: [bookClub, comfortReads],
    review: review(byTitle(classics, 'Pride and Prejudice'), 'Funnier than I remembered. Elizabeth’s letters to Jane are '
      + 'the heart of it; the second proposal lands because the first one failed so badly.', 'en', 5) }),
  item(byTitle(chinese, '西游记'), 'read', 1200, { startedOn: '2026-03-01', finishedOn: null, rating: 4,
    review: { ok: true, data: null } }),
  item(byTitle(chinese, '红楼梦'), 'read', 2000, { startedOn: '2025-11-20', finishedOn: '2026-02-14', rating: 5,
    review: review(byTitle(chinese, '红楼梦'), '读到黛玉焚稿那一回，才明白前面所有的诗社和宴席都是在为这一刻铺垫。', 'zh-Hans', 5,
      true) }),
  item(byTitle(classics, 'Frankenstein'), 'read', 3000, { review: { ok: true, data: null } }),
  item(byTitle(classics, 'Little Women'), 'want-to-read', 10),
  item(byTitle(classics, 'Wuthering Heights'), 'want-to-read', 100, { customShelves: [bookClub] }),
  item(byTitle(chinese, '聊斋志异'), 'want-to-read', 500),
  item(byTitle(classics, 'Great Expectations'), 'want-to-read', 800),
  item(byTitle(chinese, '三国演义'), 'want-to-read', 1500, { customShelves: [comfortReads] }),
];

export function storyOverview(items: readonly LibraryItem[] = libraryItems, extra: Partial<LibraryOverview> = {}):
  LibraryOverview {
  const counts = Object.fromEntries(statusShelves.map(status => [status,
    items.filter(row => row.status === status).length])) as Record<ShelfStatus, number>;
  return { agent: storyAgent, counts, customShelves, ratingContext: storyContext,
    visibility: { ok: true, data: { visibility: 'public', version: 2, changedAt: hoursAgo(1000) } }, ...extra };
}

/** A shelf as the route reads it: filtered, sorted and paged by the same functions, from `items`. */
export function storyView(state: LibraryState, items: readonly LibraryRow[] = libraryItems,
  locale: UiLocale = 'en'): ShelfView {
  const custom = state.shelf.kind === 'custom' ? customShelves.find(item => item.id.endsWith((state.shelf as {
    id: string }).id)) ?? null : null;
  const chosen = state.shelf.kind === 'all' ? items
    : state.shelf.kind === 'status' ? items.filter(row => row.status === (state.shelf as { status: ShelfStatus }).status)
      : items.filter(row => row.customShelves.some(item => item.id === custom?.id))
        .map((row, index) => ({ ...row, occurrence: `${custom!.id.slice(0, -4)}${String(index).padStart(4, '0')}` }));
  const sorted = state.shelf.kind === 'custom' ? chosen : sortLibrary(chosen, state.sort, state.order, locale);
  const page = pageOf(sorted, state.page);
  // The route reads reviews only for the list.
  const rows: LibraryRow[] = page.items.map(row => (state.layout === 'grid' ? { ...row, review: undefined } : row));
  return { shelf: state.shelf, custom, total: sorted.length, rows, page: page.page, pages: page.pages,
    truncated: false, seed: {} };
}

export const readingRows = libraryItems.filter(row => row.status === 'reading');

export const libraryState = (params: Record<string, string> = {}) => parseLibraryState(params);

/** Reader actions seeded with the library's statuses and stars, so shelf buttons show them. */
export function storyReaderActions(items: readonly LibraryItem[] = libraryItems, options: { fail?: boolean } = {}) {
  return memoryReaderActions(Object.fromEntries(items.map(row => [row.work.id,
    { status: row.status, rating: row.rating } satisfies Partial<ReaderWorkState>])), options);
}

/**
 * Library writes over memory. `fail` refuses every write; `stale` answers the
 * first visibility change as another device's, as Main's 409 does.
 */
export function memoryLibraryApi(options: { fail?: boolean; stale?: boolean } = {}): LibraryApi & {
  calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  let visibility: { visibility: 'public' | 'followers' | 'private'; version: number; changedAt: string } = {
    visibility: 'public', version: 2,
    changedAt: hoursAgo(1000) };
  let stale = options.stale ?? false;
  const settle = <T>(name: string, args: unknown[], data: () => T): Promise<Loaded<T>> => {
    calls.push({ name, args });
    return new Promise(done => setTimeout(() => done(options.fail ? { ok: false, failure: 'unavailable' }
      : { ok: true, data: data() }), 120));
  };
  return { calls,
    setDates: (work, version, dates) => settle('setDates', [work, version, dates], () => ({ version: version + 1 })),
    rate: (work, value, context) => settle('rate', [work, value, context], () => ({ value })),
    saveReview: (work, context, draft, expected) => settle('saveReview', [work, context, draft, expected],
      () => ({ review: `${work.slice(-36, -12)}cccccccccccc`, revision: `${work.slice(-36, -12)}dddddddddddd` })),
    deleteReview: (review, expected) => settle('deleteReview', [review, expected], () => null),
    setVisibility(next, expectedVersion) {
      if (stale) {
        stale = false;
        visibility = { visibility: 'followers', version: visibility.version + 1, changedAt: hoursAgo(0) };
        calls.push({ name: 'setVisibility', args: [next, expectedVersion] });
        return Promise.resolve({ ok: false, failure: 'moved' });
      }
      return settle('setVisibility', [next, expectedVersion], () => {
        visibility = { visibility: next, version: visibility.version + 1, changedAt: hoursAgo(0) };
        return visibility;
      });
    },
    readVisibility: () => settle('readVisibility', [], () => visibility),
    addToShelf: (target, works) => settle('addToShelf', [target, works], () => null),
    removeFromShelf: (target, occurrences) => settle('removeFromShelf', [target, occurrences], () => null),
    createShelf: (name, disclosure) => settle('createShelf', [name, disclosure], () => ({ id: shelf(63, name, disclosure).id })),
  };
}
