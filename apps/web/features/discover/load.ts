import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { signInPath } from '../auth/paths.ts';
import { readReaderSeed } from '../catalogue/reader-store.ts';
import { type CatalogueWork, coverKindOf } from '../catalogue/work.ts';
import type { DiscoverFallback, DiscoverPageProps, LoadedShelf } from './discover-view.tsx';
import { fills } from './fills.ts';
import { readDiscovery, readRealm, readStandingContext, settle } from './read.ts';
import { readQueryDiscovery } from './query-read.ts';
import { readSummaries } from '../search/read.ts';
import { iriOf, type SearchParams, workHref } from './scope.ts';
import { browseReader } from './server.ts';
import { type DiscoverState, discoverHref, discoveryQuery, genreTerms, parseDiscoverState, type ShelfSpec, shelvesFor,
  termShelf } from './state.ts';

// An overview row shows what fits two screens of sideways scrolling; a focused grid two rows before "Show more".
const ROW_PAGE = 10;
const GRID_PAGE = 12;

type Reader = Awaited<ReturnType<typeof browseReader>>;

async function readShelf(reader: Reader, state: DiscoverState, spec: ShelfSpec, context: string | null, limit: number,
  language: string): Promise<LoadedShelf> {
  const mine = state.scope.kind === 'mine';
  const query = discoveryQuery(state, spec, { limit, language, context, actingSubject: reader.actingSubject });
  // Mine is this person's own population; without a session Agent there is nothing to read.
  const initial = mine && !reader.actingSubject ? { ok: false as const, failure: 'sign-in' as const }
    : state.conditions ? await readQueryDiscovery(mine ? reader.personal : reader.anonymous, state, query)
      : await readDiscovery(mine ? reader.personal : reader.anonymous, query);
  return { spec, query, initial };
}

/**
 * Genre rows for the overview: the genres most often on its first books, each
 * popular (top rated) when the scope has a rating question, or newest first
 * when that has nothing yet. A genre with fewer than two Works is no shelf.
 */
async function genreShelves(reader: Reader, state: DiscoverState, first: readonly LoadedShelf[], context: string | null,
  language: string): Promise<LoadedShelf[]> {
  const books = first.filter(shelf => shelf.spec.type === 'book')
    .flatMap(shelf => shelf.initial.ok ? shelf.initial.data.items : []);
  const shelves = await Promise.all(genreTerms(books).map(async ({ term, name }) => {
    let shelf = await readShelf(reader, state, termShelf(term, 'book', context !== null), context, ROW_PAGE, language);
    if (context && shelf.initial.ok && !shelf.initial.data.items.length) {
      shelf = await readShelf(reader, state, termShelf(term, 'book', false), context, ROW_PAGE, language);
    }
    return { ...shelf, genre: name };
  }));
  return shelves.filter(shelf => !shelf.initial.ok || shelf.initial.data.items.length > 1);
}

/**
 * Everything `/discover` shows, read on the server: the URL's state, the
 * community's name, the rating question top-rated shelves rank by (the URL's,
 * or the first Main lists for the scope) and each shelf's first page.
 */
export function loadDiscover(params: SearchParams, locale: UiLocale, options: { genres?: boolean } = {}):
  Promise<DiscoverPageProps> {
  return loadDiscoverState(parseDiscoverState(params), locale, options);
}

/** `loadDiscover` for a state already parsed; null is a malformed address. */
export async function loadDiscoverState(state: DiscoverState | null, locale: UiLocale,
  { genres = true }: { genres?: boolean } = {}): Promise<DiscoverPageProps> {
  const [messages, reader] = await Promise.all([getMessages('discover', locale), browseReader()]);
  const common = { signedIn: reader.signedIn, avatarQuery: reader.avatarQuery, locale, messages,
    signInHref: signInPath(localizedPath(state ? discoverHref(state) : '/discover', locale)) };
  if (!state) return { state: null, realm: null, shelves: [], ...common };
  const { scope } = state;
  const [realm, listed] = await Promise.all([
    scope.kind === 'realm' ? readRealm(reader.anonymous, scope.realm, locale) : null,
    state.context ? null : readStandingContext(reader.anonymous, scope.kind === 'realm' ? scope : { kind: 'global' }),
  ]);
  const realmView = scope.kind === 'realm' ? { id: scope.realm, name: realm?.ok ? realm.data.name : null } : null;
  if (realm && !realm.ok && realm.failure === 'missing') {
    return { state, realm: realmView, realmMissing: true, shelves: [], ...common };
  }
  // A question that could not be listed leaves the ranked shelves out rather than guessing one.
  const context = state.context ?? (listed?.ok ? listed.data : null);
  const overview = scope.kind !== 'mine' && !state.type && !state.term;
  const limit = overview ? ROW_PAGE : GRID_PAGE;
  const first = await Promise.all(shelvesFor(state, context !== null)
    .map(spec => readShelf(reader, state, spec, context, limit, locale)));
  const genre = overview && genres && !state.conditions ? await genreShelves(reader, state, first, context, locale) : [];
  // Genres follow the favorites they grew from, ahead of what is merely recent.
  const favorites = first.filter(shelf => shelf.spec.topic.kind === 'favorites');
  const shelves = genre.length
    ? [...favorites, ...genre, ...first.filter(shelf => !favorites.includes(shelf))] : first;
  // When no list here can be shown, the page still offers what readers are reading, and in a
  // community, everyone's lists; never a column of identical "being prepared" boxes.
  const fallback = overview && !state.conditions && !first.some(fills)
    ? await readFallback(reader, state, locale) : undefined;
  const conceptNames = state.conditions ? [...(await readSummaries(reader.anonymous, [...state.conditions.include,
    ...state.conditions.exclude].map(iriOf), locale) ?? new Map())].map(([id, item]) => ({ id,
    name: item.name.value, language: item.name.language })) : [];
  return { state, realm: realmView, shelves, conceptNames, fallback, ...common,
    ...await readerState(reader, [...shelves, ...fallback?.shelves ?? []]) };
}

/** What an overview shows when none of its own rows can: trending here, and everyone's lists in a community. */
async function readFallback(reader: Reader, state: DiscoverState, language: string): Promise<DiscoverFallback> {
  const { scope } = state;
  const trending = settle(() => scope.kind === 'realm'
    ? reader.anonymous.v1.realms({ realm: scope.realm }).rankings.get({ query: { limit: ROW_PAGE, language } })
    : reader.anonymous.v1.rankings.trending.get({ query: { limit: ROW_PAGE, language } }));
  const everyone: Promise<LoadedShelf[]> = scope.kind === 'realm' ? (async () => {
    const global: DiscoverState = { scope: { kind: 'global' }, context: null, type: null, term: null };
    const listed = await readStandingContext(reader.anonymous, { kind: 'global' });
    const context = listed.ok ? listed.data : null;
    const specs = shelvesFor(global, context !== null).filter(spec => spec.type === 'book');
    return (await Promise.all(specs.map(spec => readShelf(reader, global, spec, context, ROW_PAGE, language))))
      .filter(fills);
  })() : Promise.resolve([]);
  const [ranked, shelves] = await Promise.all([trending, everyone]);
  return { trending: ranked.ok ? ranked.data.items.map(item => rankedWork(item)) : [], shelves };
}

/** The signed-in reader's shelf and rating state for every Work on the page's first pages, in Main's batches. */
async function readerState(reader: Reader, shelves: readonly LoadedShelf[]) {
  if (!reader.actingSubject) return {};
  const works = shelves.flatMap(shelf => shelf.initial.ok ? shelf.initial.data.items.map(item => item.id) : []);
  const seed = works.length ? await readReaderSeed(reader.personal, reader.actingSubject, works) : {};
  // Denied a reader library, the page draws no shelf control rather than one that cannot act.
  return seed ? { actingSubject: reader.actingSubject, readerSeed: seed } : {};
}

type RankedItem = Extract<Awaited<ReturnType<Reader['anonymous']['v1']['rankings']['trending']['get']>>['data'],
  { items: unknown }>['items'][number];

/** A trending Work as a card. Rankings carry the Work card without credits or ratings, so it shows neither. */
function rankedWork(item: RankedItem): CatalogueWork {
  return { id: item.id, href: workHref(item.id, { kind: 'global' }), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types), authors: [], rating: null, tagline: item.tagline, completion: item.completionStatus };
}
