import { afterEach, beforeAll, expect, test } from 'bun:test';
import { spaceHref } from '../features/address/path.ts';
import { zoneWork } from '../features/realm/adapt.ts';
import type { RealmView } from '../features/realm/realm-page.tsx';
import { readZoneBrowse } from '../features/realm/read.ts';
import { mainBrowseQuery, parseBrowseState } from '../features/zones/browse-state.ts';
import { browseModel } from '../features/zones/browse-view.ts';
import { applyCatalogueYear } from '../features/zones/catalogue-browse.tsx';
import { messages } from '../features/zones/messages.ts';

// Every ordinary catalogue browse reads through the realm browse adapter, so each case runs the
// route's own sequence: the URL's state, the Main query, the page read, the model, then the link
// the reader follows to the next page. Main is a fetch stub that answers from two pages keyed by
// cursor and echoes the sort it receives, so a case fails when a request drops the cursor, a
// filter or the sort. The second page is fetched from the route the first page's link names.

const MAIN_ORIGIN = 'https://main.test';
const nativeFetch = globalThis.fetch;
const mainOrigin = process.env.MAIN_ORIGIN;

type Catalogue = { name: string; ref: string; catalogue?: true };
type SearchParams = Record<string, string | string[] | undefined>;

const CATALOGUES: Catalogue[] = [
  { name: 'custom Zone', ref: 'custom' },
  { name: 'Books', ref: 'books' },
  { name: 'Fiction', ref: 'fiction' },
  { name: 'Light novels', ref: 'light-novels' },
  // Anime and Manga also run the publication-year stage after the browse model is built.
  { name: 'Anime', ref: 'anime', catalogue: true },
  { name: 'Manga', ref: 'manga', catalogue: true },
  { name: 'Games', ref: 'games' },
  { name: 'Visual novels', ref: 'visual-novels' },
  { name: 'Software', ref: 'software' },
  { name: 'Mods', ref: 'mods' },
  { name: 'AI workshop', ref: 'ai-workshop' },
  { name: 'Franchise wiki', ref: 'franchise-wiki' },
];

// Two statuses, so the repeated parameter has to survive the Main query intact. The sort is not
// the `newest` default, so an echoed sort proves the sort was passed rather than defaulted.
const FILTERS: SearchParams = { status: ['ongoing', 'hiatus'], sort: 'updated' };
const NO_FACETS = { type: [], concept: [], status: [], length: [] };

const uuid = (block: string, n: number) => `00000000-0000-4000-${block}-${String(n).padStart(12, '0')}`;
const realmOf = (index: number) => uuid('9000', index + 1);
const work = (index: number, n: number) => `https://rezics.com/id/${uuid('8000', index * 10 + n)}`;
const routeOf = (row: Catalogue) => spaceHref(row.ref, 'site', ['browse']);

// Each catalogue's browse route, so the link a page produces can be resolved to its Realm.
const ROUTES = new Map(CATALOGUES.map((row, index) => [routeOf(row), { row, index }] as const));

function card(id: string) {
  return {
    id, title: null, cover: null, types: [], tagline: null, completionStatus: null,
    chapterCount: null, wordCount: null, lastUpdatedAt: null, inZone: false as const, evidence: null,
  };
}

function body(ids: string[], nextCursor: string | null) {
  return {
    items: ids.map(card), nextCursor,
    matches: { value: ids.length, kind: 'exact' }, window: { scanned: ids.length, complete: nextCursor === null },
    tags: 'current',
  };
}

function view(row: Catalogue, index: number) {
  return {
    kind: 'view',
    zone: { name: { value: row.name }, links: { browse: routeOf(row) } },
    context: { locale: 'en', ref: row.ref, realm: realmOf(index) },
    zoneMessages: messages,
    pkg: null,
  } as unknown as Extract<RealmView, { kind: 'view' }>;
}

// The route's browse sequence for one URL state, with the page's own model.
async function browse(row: Catalogue, index: number, search: SearchParams) {
  const state = parseBrowseState(search);
  const read = await readZoneBrowse(realmOf(index), 'en', mainBrowseQuery(state));
  if (!read.ok) throw new Error(`browse read failed: ${read.failure}`);
  const page = read.data;
  const current = view(row, index);
  const model = browseModel({
    base: current.zone.links.browse, zoneName: row.name, state, admitted: new Map(), locale: 'en', messages,
    page: {
      ...page, facets: NO_FACETS, sort: page.query.sort,
      items: page.items.map(item => zoneWork(item, current.context, item.evidence)),
    },
  });
  if (row.catalogue) await applyCatalogueYear({ view: current, search, model });
  return model;
}

function searchOf(href: string): SearchParams {
  const search: Record<string, string[]> = {};
  for (const [key, value] of new URL(href, 'https://rezics.local').searchParams) (search[key] ??= []).push(value);
  return search;
}

function currentSort(model: { sorts: { sort: string; current: boolean }[] }) {
  return model.sorts.find(item => item.current)?.sort;
}

const requests: URL[] = [];

// Answers Main's browse endpoint for one realm with the given pages, keyed by the cursor it receives.
// The page's query echoes the sort of the request, as Main does.
function serveMain(realm: string, pages: Record<string, unknown>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url);
    if (url.pathname !== `/v1/realms/${realm}/modules/browse`) return new Response('no route', { status: 404 });
    const page = pages[url.searchParams.get('cursor') ?? ''];
    return page
      ? Response.json({ ...page, query: { sort: url.searchParams.get('sort') } })
      : new Response('no page', { status: 404 });
  }) as unknown as typeof fetch;
}

function withoutCursor(url: URL): string {
  const copy = new URL(url);
  copy.searchParams.delete('cursor');
  return copy.search;
}

beforeAll(() => {
  process.env.MAIN_ORIGIN = MAIN_ORIGIN;
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  requests.length = 0;
  if (mainOrigin === undefined) delete process.env.MAIN_ORIGIN;
  else process.env.MAIN_ORIGIN = mainOrigin;
});

CATALOGUES.forEach((row, index) => {
  test(`${row.name} browse reaches its second page through the link the first page produces`, async () => {
    const cursor = `${row.ref}-page-2`;
    serveMain(realmOf(index), {
      '': body([work(index, 1), work(index, 2)], cursor),
      [cursor]: body([work(index, 3), work(index, 4)], null),
    });

    const first = await browse(row, index, FILTERS);
    expect(first.items.map(item => item.id)).toEqual([work(index, 1), work(index, 2)]);
    expect(currentSort(first)).toBe('updated');
    expect(first.next).not.toBeNull();
    const link = new URL(first.next!, 'https://rezics.local');
    expect(link.pathname).toBe(routeOf(row));
    expect(searchOf(first.next!).cursor).toEqual([cursor]);

    // The second page is read from the Realm of the route the link names, not from this row.
    const target = ROUTES.get(link.pathname);
    if (!target) throw new Error(`no catalogue route at ${link.pathname}`);
    const second = await browse(target.row, target.index, searchOf(first.next!));
    expect(second.items.map(item => item.id)).toEqual([work(index, 3), work(index, 4)]);
    expect(currentSort(second)).toBe('updated');
    expect(second.next).toBeNull();

    const [firstCall, secondCall] = requests;
    expect(firstCall!.searchParams.has('cursor')).toBe(false);
    expect(secondCall!.searchParams.get('cursor')).toBe(cursor);
    expect(firstCall!.searchParams.getAll('sort')).toEqual(['updated']);
    expect(secondCall!.searchParams.getAll('sort')).toEqual(['updated']);
    expect(secondCall!.searchParams.getAll('status')).toEqual(['ongoing', 'hiatus']);
    expect(withoutCursor(secondCall!)).toBe(withoutCursor(firstCall!));
  });
});
