import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { READER_BATCH, readerEntry, type ReaderSeed } from '../catalogue/reader-store.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import type { MainClient } from '../discover/types.ts';
import { settle } from '../feed/types.ts';
import { shelfCard } from '../profile/cards.ts';
import { shellReader } from '../shell/communities-read.ts';
import { workHref } from '../work-page/route.ts';
import { dayText, momentText } from './format.ts';
import { type LibraryState, statusShelves } from './state.ts';
import type { ContinueItem, CustomShelf, FollowedAuthors, LibraryItem, LibraryOverview, LibraryRow, Loaded,
  PrivateImportReview, ReaderStateItem, ReadingProgress, ReadingYear, Review, ShelfStatus, StatusShelfItem,
  YearlyGoal } from './types.ts';

// Server reads for `/library`, as the session's Agent. Each region returns
// its own `Loaded` outcome, so a shelf that cannot load leaves the rest.
//
// A rendered shelf page is one Main page: status shelves use `sort`, `order`
// and `cursor` on `/v1/me/shelves/status/:status/works`; a custom shelf uses
// the Collection's `after` continuation. Rows stay in that order, including a
// placeholder where Main kept a status row but could not name the Work. All
// is the shelf list and the reading preview, not a second inventory.

/** Main's status-shelf page, and the same size for one Collection page. */
const MAIN_SHELF_LIMIT = 20;
/** The reading strip on All: one short Main page, not a window over a larger read. */
const READING_PREVIEW = 3;
// Main's `/v1/me/shelves` page; five pages is more custom shelves than anyone keeps in view.
const MAX_CUSTOM_PAGES = 5;
const PARALLEL = 6;

/** Runs `task` over `items`, `PARALLEL` at a time, in order. */
async function pooled<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  }));
  return results;
}

/** The Agent Library reads as; null when the session has none that may act. */
export const libraryReader = cache(async () => {
  const reader = await shellReader();
  return reader.actingSubject ? { ...reader, actingSubject: reader.actingSubject } : null;
});
type Reader = NonNullable<Awaited<ReturnType<typeof libraryReader>>>;

/** A dated finish is the unit of the yearly goal; undated Read works do not advance it. */
export const readYearlyGoal = cache(async (year: number): Promise<Loaded<YearlyGoal>> => {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  return settle(() => reader.main.v1.me['reading-goal'].get({ query: {
    actingSubject: reader.actingSubject, year } }));
});

export const readReadingYear = cache(async (year: number): Promise<Loaded<ReadingYear>> => {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  return settle(() => reader.main.v1.me['reading-stats'].get({ query: {
    actingSubject: reader.actingSubject, year } }));
});

/** Status counts, the reader's custom shelves, who may see the status shelves, and the rating question. */
export const readOverview = cache(async (): Promise<Loaded<LibraryOverview>> => {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  const { main, actingSubject } = reader;
  const [shelves, visibility, context] = await Promise.all([
    readCustomShelves(main, actingSubject),
    settle(() => main.v1.agents({ id: actingSubject.slice(-36) })['library-visibility'].get()),
    settle(() => reader.anonymous.v1['rating-contexts'].get({ query: { scope: 'global', limit: 1 } })),
  ]);
  if (!shelves.ok) return shelves;
  const counts = Object.fromEntries(statusShelves.map(status => [status,
    shelves.data.statusShelves.find(item => item.status === status)?.count ?? 0])) as Record<ShelfStatus, number>;
  return { ok: true, data: { agent: actingSubject, counts, customShelves: shelves.data.items, visibility,
    ratingContext: context.ok ? context.data.items[0]?.context ?? null : null } };
});

async function readCustomShelves(main: MainClient, actingSubject: string) {
  let first: Awaited<ReturnType<MainClient['v1']['me']['shelves']['get']>>['data'] = null;
  const items: CustomShelf[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CUSTOM_PAGES; page++) {
    const read = await settle(() => main.v1.me.shelves.get({ query: { actingSubject, limit: 20, cursor } }));
    if (!read.ok) return page ? { ok: true as const, data: { ...first!, items } } : read;
    first ??= read.data;
    items.push(...read.data.items);
    if (!read.data.nextCursor) break;
    cursor = read.data.nextCursor;
  }
  return { ok: true as const, data: { ...first!, items } };
}

/** One Main read. A 409 on the first page is read again once; a stale cursor stays a 409. */
async function readOnce<T>(call: () => Promise<{ data: T | null; error: { status: number; value: unknown } | null }>,
  cursor: string | null): Promise<Loaded<T>> {
  const first = await settle(call);
  return !first.ok && first.failure === 'moved' && !cursor ? settle(call) : first;
}

function unnamedWork(work: string): CatalogueWork {
  return { id: work, href: workHref(work.slice(-36)), title: null, cover: null, kind: 'book', authors: [], rating: null };
}

/**
 * One status page in Main's order. A missing card stays in the page as a
 * placeholder; dropping it would make the shelf shorter than Main's count.
 */
export function statusShelfItems(items: readonly StatusShelfItem[]): LibraryItem[] {
  return items.map(item => {
    const named = item.card ? shelfCard(item.card) : null;
    return { work: named ?? unnamedWork(item.work), types: item.card?.types ?? [], status: item.status,
      version: item.version, shelvedAt: momentText(item.changedAt), startedOn: dayText(item.startedOn),
      finishedOn: dayText(item.finishedOn), rating: null, lastReadAt: null, customShelves: [],
      available: named !== null };
  });
}

/**
 * Reader state for Works, in Main's batches. One Work Main cannot answer fails
 * its whole batch; with `alone`, such a batch is read again a Work at a time,
 * so the others still show their state. Works Main could not answer are left out.
 */
async function readStates(main: MainClient, actingSubject: string, works: readonly string[], alone = false):
  Promise<Map<string, ReaderStateItem>> {
  const read = (batch: readonly string[]) => settle(() => main.v1.me['work-states'].get({ query: {
    works: batch.join(','), actingSubject } }));
  const batches = Array.from({ length: Math.ceil(works.length / READER_BATCH) },
    (_, index) => works.slice(index * READER_BATCH, (index + 1) * READER_BATCH));
  const answers = await pooled(batches, async batch => {
    const answer = await read(batch);
    // Only a single batch is split, so the fallback costs at most one batch of reads.
    if (answer.ok || !alone || batch.length === 1 || works.length > READER_BATCH || answer.failure === 'sign-in') {
      return [answer];
    }
    return pooled(batch, work => read([work]));
  });
  return new Map(answers.flat().flatMap(answer => (answer.ok ? answer.data.items : []).map(item => [item.work, item])));
}

function withState(item: LibraryItem, state: ReaderStateItem | undefined): LibraryItem {
  if (!state) return item;
  const own = state.rating.global;
  return { ...item, stateRead: true, status: state.status.status ?? item.status, version: state.status.version,
    shelvedAt: momentText(state.status.changedAt) ?? item.shelvedAt, startedOn: dayText(state.status.startedOn),
    finishedOn: dayText(state.status.finishedOn), rating: own?.availability === 'available' ? own.value : null,
    lastReadAt: momentText(state.progress?.changedAt), customShelves: state.customShelves };
}

/** One Work's own read, shared by the rows that need its chapter count or card within a request. */
const readWork = cache(async (work: string, _locale: UiLocale) => {
  const reader = await libraryReader();
  return reader ? settle(() => reader.main.v1.works({ id: work.slice(-36) }).get({ query: {
    actingSubject: reader.actingSubject } })) : { ok: false as const, failure: 'sign-in' as const };
});

/** Works in progress with their next unread chapter, from Main's Continue read. */
const readContinue = cache(async (): Promise<Map<string, ContinueItem>> => {
  const reader = await libraryReader();
  if (!reader) return new Map();
  const read = await settle(() => reader.main.v1.me.continue.get({ query: { actingSubject: reader.actingSubject,
    limit: 6 } }));
  return new Map((read.ok ? read.data.items : []).map(item => [item.work, item]));
});

/**
 * How far the reader is in each Work on Currently reading: Continue's next
 * chapter and what is left, and chapters read of all when Main counts both exactly.
 */
async function readProgress(rows: readonly LibraryItem[], locale: UiLocale):
  Promise<Map<string, ReadingProgress>> {
  const continued = await readContinue();
  const reading = rows.filter(row => row.status === 'reading');
  const totals = await pooled(reading.filter(row => continued.get(row.work.id)?.unreadCount.kind === 'exact'),
    async row => [row.work.id, await readWork(row.work.id, locale)] as const);
  const chapters = new Map(totals.flatMap(([work, read]) => (read.ok && read.data.chapterCount !== null
    ? [[work, read.data.chapterCount]] : [])));
  return new Map(reading.map(row => {
    const item = continued.get(row.work.id);
    const total = chapters.get(row.work.id);
    const left = item?.unreadCount ?? null;
    return [row.work.id, { next: item ? { title: item.nextUnread.title, href: item.nextUnread.href } : null, left,
      chapters: total !== undefined && left?.kind === 'exact' && left.value <= total
        ? { read: total - left.value, total } : null }];
  }));
}

/**
 * The reader's own review of each Read Work. Main lists a Work's reviews
 * with the reader's own first; one that is someone else's means there is none.
 */
async function readReviews(reader: Reader, rows: readonly LibraryItem[], context: string):
  Promise<Map<string, Loaded<Review | null>>> {
  const read = rows.filter(row => row.status === 'read');
  const answers = await pooled(read, async row => [row.work.id, await settle(() => reader.main.v1
    .resources({ resource: row.work.id.slice(-36) }).reviews.get({ query: { context, actingSubject: reader.actingSubject,
      limit: 1, showSpoilers: true } }))] as const);
  return new Map(answers.map(([work, answer]) => [work, answer.ok
    ? { ok: true, data: answer.data.items.find(review => review.author === reader.actingSubject) ?? null }
    : answer]));
}

async function readPrivateReviews(reader: Reader, rows: readonly LibraryItem[]):
  Promise<Map<string, Loaded<PrivateImportReview | null>>> {
  const works = rows.filter(row => row.status === 'read').map(row => row.work.id);
  if (!works.length) return new Map();
  const answer = await settle(() => reader.main.v1.me['import-reviews'].get({ query: {
    actingSubject: reader.actingSubject, works: works.join(',') } }));
  const found = new Map((answer.ok ? answer.data.items : []).map(item => [item.work, item]));
  return new Map(works.map(work => [work, answer.ok ? { ok: true, data: found.get(work) ?? null } : answer]));
}

export interface ShelfView {
  shelf: LibraryState['shelf'];
  /** The custom shelf shown; null for the status shelves and All. */
  custom: CustomShelf | null;
  /** Main's exact status count. Null when a custom shelf's one page is not the whole shelf. */
  total: number | null;
  rows: LibraryRow[];
  /** Main's continuation, passed back as the next page's cursor. */
  nextCursor: string | null;
  /** Reader state for the rows, so their shelf controls render settled. */
  seed: ReaderSeed;
}

/** A custom shelf member as a card, from the Work's own read; a placeholder when Main cannot show it. */
async function memberItem(member: { work: string; occurrence: string }, locale: UiLocale): Promise<LibraryItem> {
  const read = await readWork(member.work, locale);
  const work: CatalogueWork = read.ok
    ? { id: member.work, href: workHref(member.work.slice(-36)), title: read.data.title, cover: read.data.cover,
      kind: coverKindOf(read.data.types), authors: [], rating: null, completion: read.data.completionStatus }
    : unnamedWork(member.work);
  return { work, types: read.ok ? read.data.types : [], status: null, version: 0, shelvedAt: null,
    startedOn: null, finishedOn: null, rating: null, lastReadAt: null, customShelves: [],
    occurrence: member.occurrence, available: read.ok };
}

/**
 * The chosen shelf as one Main page, with what that page's rows show:
 * reader state, reading progress and, in the list, the reader's reviews.
 */
export async function readShelfView(state: LibraryState, locale: UiLocale): Promise<Loaded<ShelfView>> {
  const [reader, overview] = await Promise.all([libraryReader(), readOverview()]);
  if (!reader) return { ok: false, failure: 'sign-in' };
  if (!overview.ok) return overview;
  if (state.shelf.kind === 'all') {
    return { ok: true, data: { shelf: state.shelf, custom: null, total: statusShelves.reduce((sum, status) =>
      sum + overview.data.counts[status], 0), rows: [], nextCursor: null, seed: {} } };
  }
  let custom: CustomShelf | null = null;
  let items: LibraryItem[];
  let total: number | null;
  let nextCursor: string | null;
  if (state.shelf.kind === 'custom') {
    const id = state.shelf.id;
    custom = overview.data.customShelves.find(shelf => shelf.id.endsWith(id)) ?? null;
    if (!custom) return { ok: false, failure: 'missing' };
    const collection = custom.id.slice(-36);
    const read = await readOnce(() => reader.main.v1.collections({ id: collection }).get({ query: {
      actingSubject: reader.actingSubject, limit: MAIN_SHELF_LIMIT, ...(state.cursor ? { after: state.cursor } : {}) } }),
    state.cursor);
    if (!read.ok) return read;
    // Main types occurrences loosely; these are the Structure's occurrence records, in Collection order.
    const occurrences = read.data.occurrences as { occurrence: string; state: 'active' | 'removed'; role: string;
      target?: string }[];
    const members = occurrences.flatMap(item => item.state === 'active' && item.role === 'member' && item.target
      ? [{ work: item.target, occurrence: item.occurrence }] : []);
    items = await pooled(members, member => memberItem(member, locale));
    nextCursor = read.data.next;
    total = state.cursor === null && nextCursor === null ? items.length : null;
  } else {
    const status = state.shelf.status;
    const read = await readOnce(() => reader.main.v1.me.shelves.status({ status }).works.get({ query: {
      actingSubject: reader.actingSubject, sort: state.sort, order: state.order, limit: MAIN_SHELF_LIMIT,
      ...(state.cursor ? { cursor: state.cursor } : {}) } }), state.cursor);
    if (!read.ok) return read;
    items = statusShelfItems(read.data.items);
    nextCursor = read.data.nextCursor;
    total = overview.data.counts[status];
  }
  const states = await readStates(reader.main, reader.actingSubject,
    items.filter(item => item.available !== false).map(item => item.work.id), true);
  const shown = items.map(item => withState(item, states.get(item.work.id)));
  const [progress, reviews, privateReviews] = await Promise.all([
    readProgress(shown, locale),
    state.layout === 'list' && overview.data.ratingContext
      ? readReviews(reader, shown, overview.data.ratingContext) : Promise.resolve(new Map()),
    state.layout === 'list' ? readPrivateReviews(reader, shown) : Promise.resolve(new Map()),
  ]);
  // Shelf buttons show the status the shelf read gave when Main could not answer the rest.
  const seed: ReaderSeed = Object.fromEntries(shown.flatMap(item => {
    const known = states.get(item.work.id);
    if (known) return [[item.work.id, readerEntry(known)]];
    return item.status ? [[item.work.id, { status: item.status, version: item.version, rating: null }]] : [];
  }));
  return { ok: true, data: { shelf: state.shelf, custom, total, nextCursor, seed,
    rows: shown.map(item => ({ ...item,
      ...(item.status === 'reading' ? { progress: progress.get(item.work.id) ?? null } : {}),
      ...(reviews.has(item.work.id) ? { review: reviews.get(item.work.id) } : {}),
      ...(privateReviews.has(item.work.id) ? { privateReview: privateReviews.get(item.work.id) } : {}) })) } };
}

/**
 * Currently reading, for the top of All: one Main page of the reading shelf,
 * most recently read first, each with where to continue.
 */
export async function readCurrentlyReading(locale: UiLocale): Promise<LibraryRow[]> {
  const [reader, overview] = await Promise.all([libraryReader(), readOverview()]);
  if (!reader || !overview.ok || !overview.data.counts.reading) return [];
  const shelf = await readOnce(() => reader.main.v1.me.shelves.status({ status: 'reading' }).works.get({ query: {
    actingSubject: reader.actingSubject, sort: 'last-read', order: 'desc', limit: READING_PREVIEW } }), null);
  if (!shelf.ok) return [];
  const items = statusShelfItems(shelf.data.items);
  const states = await readStates(reader.main, reader.actingSubject,
    items.filter(item => item.available !== false).map(item => item.work.id), true);
  const shown = items.map(item => withState(item, states.get(item.work.id)));
  const progress = await readProgress(shown, locale);
  return shown.map(item => ({ ...item, progress: progress.get(item.work.id) ?? null }));
}

/**
 * The first page of authors the reader follows (Main pages them eight at a
 * time), each with their newest Work on REZICS. Main answers 409 when the
 * follows changed during the read; it is read again, once.
 */
export async function readFollowedAuthors(_locale: UiLocale): Promise<Loaded<FollowedAuthors>> {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  const read = () => settle(() => reader.main.v1.me.follows.authors.get({ query: {
    actingSubject: reader.actingSubject } }));
  const first = await read();
  return !first.ok && first.failure === 'moved' ? read() : first;
}
