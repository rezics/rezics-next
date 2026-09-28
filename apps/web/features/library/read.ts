import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { READER_BATCH, readerEntry, type ReaderSeed } from '../catalogue/reader-store.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import type { MainClient } from '../discover/types.ts';
import { settle } from '../feed/types.ts';
import { shelfCard } from '../profile/cards.ts';
import { shellReader } from '../shell/communities-read.ts';
import { workHref } from '../work-page/route.ts';
import { type LibraryShelf, type LibraryState, pageOf, sortLibrary, statusShelves } from './state.ts';
import type { ContinueItem, CustomShelf, LibraryItem, LibraryOverview, LibraryRow, Loaded, ReaderStateItem,
  ReadingProgress, Review, ShelfStatus, StatusShelfItem } from './types.ts';

// Server reads for `/library`, as the session's Agent. Each region returns
// its own `Loaded` outcome, so a shelf that cannot load leaves the rest.
//
// Main sorts a status shelf only by when each Work reached it, twenty at a
// time, and fails closed past 240 shelved Works per reader
// (`ReaderLibraryStatusStore.publicCandidates`). So Library reads the chosen
// shelf whole, at most twelve pages, and sorts and pages it here; reader
// state (ratings, last read) is read for the whole shelf only when the sort
// needs it, otherwise for the page shown.

const SHELF_PAGE = 20;
const MAX_SHELF_PAGES = 12;
// Main's `/v1/me/shelves` page; five pages is more custom shelves than anyone keeps in view.
const MAX_CUSTOM_PAGES = 5;
// Main's Collection read takes at most 100 members at once.
const CUSTOM_MEMBERS = 100;
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

/**
 * A whole status shelf, newest first as Main keeps it, read once per request.
 * Main answers 409 when the shelf changed between pages; the read then starts
 * again, once.
 */
const readWholeShelf = cache(async (status: ShelfStatus): Promise<Loaded<StatusShelfItem[]>> => {
  const reader = await libraryReader();
  if (!reader) return { ok: false, failure: 'sign-in' };
  for (let attempt = 0; ; attempt++) {
    const items: StatusShelfItem[] = [];
    let cursor: string | undefined;
    let moved = false;
    for (let page = 0; page < MAX_SHELF_PAGES; page++) {
      const read = await settle(() => reader.main.v1.me.shelves.status({ status }).works.get({ query: {
        actingSubject: reader.actingSubject, limit: SHELF_PAGE, cursor } }));
      if (!read.ok) {
        if (read.failure === 'moved' && !attempt) { moved = true; break; }
        return read;
      }
      items.push(...read.data.items);
      if (!read.data.nextCursor) break;
      cursor = read.data.nextCursor;
    }
    if (!moved) return { ok: true, data: items };
  }
});

function statusItem(item: StatusShelfItem): LibraryItem {
  const work = item.card ? shelfCard(item.card)
    : { id: item.work, href: workHref(item.work.slice(-36)), title: null, cover: null, kind: 'book', authors: [],
      rating: null } satisfies CatalogueWork;
  return { work, status: item.status, version: item.version, shelvedAt: item.changedAt,
    startedOn: item.startedOn, finishedOn: item.finishedOn, rating: null, lastReadAt: null, customShelves: [] };
}

/** Reader state for Works, in Main's batches; Works Main could not answer are left out. */
async function readStates(main: MainClient, actingSubject: string, works: readonly string[]):
  Promise<Map<string, ReaderStateItem>> {
  const batches = Array.from({ length: Math.ceil(works.length / READER_BATCH) },
    (_, index) => works.slice(index * READER_BATCH, (index + 1) * READER_BATCH));
  const answers = await pooled(batches, batch => settle(() => main.v1.me['work-states'].get({ query: {
    works: batch.join(','), actingSubject } })));
  return new Map(answers.flatMap(answer => (answer.ok ? answer.data.items : []).map(item => [item.work, item])));
}

function withState(item: LibraryItem, state: ReaderStateItem | undefined): LibraryItem {
  if (!state) return item;
  const own = state.rating.global;
  return { ...item, status: state.status.status ?? item.status, version: state.status.version,
    shelvedAt: state.status.changedAt ?? item.shelvedAt, startedOn: state.status.startedOn,
    finishedOn: state.status.finishedOn, rating: own?.availability === 'available' ? own.value : null,
    lastReadAt: state.progress?.changedAt ?? null, customShelves: state.customShelves };
}

/** One Work's own read, shared by the rows that need its chapter count or card within a request. */
const readWork = cache(async (work: string, locale: UiLocale) => {
  const reader = await libraryReader();
  return reader ? settle(() => reader.main.v1.works({ id: work.slice(-36) }).get({ query: { language: locale,
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
    .works({ id: row.work.id.slice(-36) }).reviews.get({ query: { context, actingSubject: reader.actingSubject,
      limit: 1, showSpoilers: true } }))] as const);
  return new Map(answers.map(([work, answer]) => [work, answer.ok
    ? { ok: true, data: answer.data.items.find(review => review.author === reader.actingSubject) ?? null }
    : answer]));
}

export interface ShelfView {
  shelf: LibraryShelf;
  /** The custom shelf shown; null for the status shelves and All. */
  custom: CustomShelf | null;
  total: number;
  rows: LibraryRow[];
  page: number;
  pages: number;
  /** A custom shelf with more members than one read shows. */
  truncated: boolean;
  /** Reader state for the rows, so their shelf controls render settled. */
  seed: ReaderSeed;
}

/** Works on the chosen status shelves in the chosen order, and the rows of the page shown. */
async function readStatusView(reader: Reader, overview: LibraryOverview, state: LibraryState,
  statuses: readonly ShelfStatus[]): Promise<Loaded<{ items: LibraryItem[]; states: Map<string, ReaderStateItem> }>> {
  const shelves = await Promise.all(statuses.map(status => overview.counts[status]
    ? readWholeShelf(status) : Promise.resolve({ ok: true as const, data: [] })));
  const failed = shelves.find(shelf => !shelf.ok);
  if (failed && !failed.ok) return failed;
  let items = shelves.flatMap(shelf => (shelf.ok ? shelf.data : []).map(statusItem));
  let states = new Map<string, ReaderStateItem>();
  if (state.sort === 'rating' || state.sort === 'last-read') {
    // Works Main could not name are left out of the batch, where one would fail it.
    states = await readStates(reader.main, reader.actingSubject,
      items.filter(item => item.work.title).map(item => item.work.id));
    items = items.map(item => withState(item, states.get(item.work.id)));
  }
  return { ok: true, data: { items, states } };
}

/** A custom shelf's members in its own order, as far as one read of Main's Collection goes. */
async function readMembers(reader: Reader, shelf: CustomShelf):
  Promise<Loaded<{ members: { work: string; occurrence: string }[]; truncated: boolean }>> {
  const read = await settle(() => reader.main.v1.collections({ id: shelf.id.slice(-36) }).get({ query: {
    actingSubject: reader.actingSubject, limit: CUSTOM_MEMBERS } }));
  if (!read.ok) return read;
  // Main types occurrences loosely; these are the Structure's occurrence records.
  const occurrences = read.data.occurrences as { occurrence: string; state: 'active' | 'removed'; role: string;
    target?: string }[];
  const members = occurrences.flatMap(item => item.state === 'active' && item.role === 'member' && item.target
    ? [{ work: item.target, occurrence: item.occurrence }] : []);
  return { ok: true, data: { members, truncated: read.data.next !== null } };
}

/** A custom shelf member as a card, from the Work's own read; null when Main cannot show it. */
async function memberItem(member: { work: string; occurrence: string }, locale: UiLocale): Promise<LibraryItem> {
  const read = await readWork(member.work, locale);
  const work: CatalogueWork = read.ok
    ? { id: member.work, href: workHref(member.work.slice(-36)), title: read.data.title, cover: read.data.cover,
      kind: coverKindOf(read.data.types), authors: [], rating: null, completion: read.data.completionStatus }
    : { id: member.work, href: workHref(member.work.slice(-36)), title: null, cover: null, kind: 'book', authors: [],
      rating: null };
  return { work, status: null, version: 0, shelvedAt: null, startedOn: null, finishedOn: null, rating: null,
    lastReadAt: null, customShelves: [], occurrence: member.occurrence };
}

/**
 * The chosen shelf, sorted and paged, with what the page's rows show:
 * reader state, reading progress and, in the list, the reader's reviews.
 */
export async function readShelfView(state: LibraryState, locale: UiLocale): Promise<Loaded<ShelfView>> {
  const [reader, overview] = await Promise.all([libraryReader(), readOverview()]);
  if (!reader) return { ok: false, failure: 'sign-in' };
  if (!overview.ok) return overview;
  let custom: CustomShelf | null = null;
  let states = new Map<string, ReaderStateItem>();
  let truncated = false;
  let total: number;
  let page: { items: LibraryItem[]; page: number; pages: number };
  if (state.shelf.kind === 'custom') {
    const id = state.shelf.id;
    custom = overview.data.customShelves.find(shelf => shelf.id.endsWith(id)) ?? null;
    if (!custom) return { ok: false, failure: 'missing' };
    const read = await readMembers(reader, custom);
    if (!read.ok) return read;
    truncated = read.data.truncated;
    total = read.data.members.length;
    const members = pageOf(read.data.members, state.page);
    page = { ...members, items: await pooled(members.items, member => memberItem(member, locale)) };
  } else {
    const read = await readStatusView(reader, overview.data, state,
      state.shelf.kind === 'all' ? statusShelves : [state.shelf.status]);
    if (!read.ok) return read;
    states = read.data.states;
    const items = sortLibrary(read.data.items, state.sort, state.order, locale);
    total = items.length;
    page = pageOf(items, state.page);
  }
  const missing = page.items.filter(item => !states.has(item.work.id) && item.work.title).map(item => item.work.id);
  if (missing.length) for (const [work, item] of await readStates(reader.main, reader.actingSubject, missing)) {
    states.set(work, item);
  }
  const shown = page.items.map(item => withState(item, states.get(item.work.id)));
  const [progress, reviews] = await Promise.all([
    readProgress(shown, locale),
    state.layout === 'list' && overview.data.ratingContext
      ? readReviews(reader, shown, overview.data.ratingContext) : Promise.resolve(new Map()),
  ]);
  const seed: ReaderSeed = Object.fromEntries(shown.flatMap(item => {
    const known = states.get(item.work.id);
    return known ? [[item.work.id, readerEntry(known)]] : [];
  }));
  return { ok: true, data: { shelf: state.shelf, custom, total, page: page.page, pages: page.pages,
    truncated, seed, rows: shown.map(item => ({ ...item,
      ...(item.status === 'reading' ? { progress: progress.get(item.work.id) ?? null } : {}),
      ...(reviews.has(item.work.id) ? { review: reviews.get(item.work.id) } : {}) })) } };
}

/**
 * Currently reading, for the top of All: the Works in progress, most
 * recently read first, each with where to continue.
 */
export async function readCurrentlyReading(locale: UiLocale): Promise<LibraryRow[]> {
  const [reader, overview] = await Promise.all([libraryReader(), readOverview()]);
  if (!reader || !overview.ok || !overview.data.counts.reading) return [];
  const shelf = await readWholeShelf('reading');
  if (!shelf.ok) return [];
  const items = shelf.data.map(statusItem);
  const states = await readStates(reader.main, reader.actingSubject,
    items.filter(item => item.work.title).map(item => item.work.id));
  const shown = sortLibrary(items.map(item => withState(item, states.get(item.work.id))), 'last-read', 'desc', locale)
    .slice(0, 6);
  const progress = await readProgress(shown, locale);
  return shown.map(item => ({ ...item, progress: progress.get(item.work.id) ?? null }));
}
