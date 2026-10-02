import { uuidToSid } from '@rezics/model/address';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { zoneWork } from '../features/realm/adapt.ts';
import { loadModules } from '../features/realm/modules.ts';
import { isType } from '../features/zones/zone-home.tsx';
import { realmWorkHref, siteHref } from '../features/realm/route.ts';
import { messages as zoneMessages } from '../features/zones/messages.ts';
import { defaultPresentation, type ZonePresentation } from '../features/zones/presentation.ts';
import { withoutLocale } from '../i18n/locale.ts';
import {
  chapterHref,
  defaultScope,
  EVERYONE,
  scopeAt,
  tabOf,
  textHref,
  workHref,
  type ZoneWorkBase,
} from '../features/work-page/route.ts';

const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const workId = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const collection = iri('11111111-1111-4111-8111-111111111111');
const zone = '22222222-2222-4222-8222-222222222222';
const ref = 'books';
const name = (value: string) => ({
  value,
  language: 'en',
  direction: 'ltr' as const,
  basis: 'requested' as const,
});
const cover = (id: string) => ({
  kind: 'fallback' as const,
  policy: 'zone',
  key: id,
  resourceType: 'work',
});
const card = (n: number) => ({
  id: iri(workId(n)),
  title: name(`Work ${n}`),
  cover: cover(iri(workId(n))),
  types: ['https://schema.org/Book'],
  tagline: null,
  completionStatus: null,
  chapterCount: null,
  wordCount: null,
  lastUpdatedAt: null,
  evidence: null,
  primaryCredits: [],
  hub: null,
});
const thin = (n: number) => ({
  id: iri(workId(n)),
  title: name(`Work ${n}`),
  cover: cover(iri(workId(n))),
});
const indexPage = {
  kind: 'index',
  collection,
  mount: { segment: 'catalogue' },
  items: [card(8), card(9)],
  nextCursor: 'more',
};
let indexRead: unknown = indexPage;
let indexStatus = 200;

/** Main's module reads for one Realm, served from fixtures; every other read is a 404, like an unmounted route. */
const reads: Record<string, unknown> = {
  'modules/new-adoptions': { items: [card(1), card(2)] },
  'modules/recently-completed': { items: [card(3)] },
  'modules/latest-chapters': {
    items: [
      {
        work: card(4),
        chapter: iri(workId(40)),
        chapterTitle: name('One'),
        chapterUpdatedAt: '2026-09-30T00:00:00.000Z',
      },
    ],
  },
  'modules/rising': { items: [{ ...card(5), score: 1 }] },
  'modules/reader-quotes': {
    items: [{ id: iri(workId(60)), excerpt: 'A line', authorName: 'Reader', work: thin(6) }],
  },
  'modules/discussions': { items: [{ id: iri(workId(61)), excerpt: 'A thread', work: thin(7) }] },
  'modules/editor-lists': {
    lists: [{ collection, name: name('Picks'), items: [thin(8), thin(9)] }],
  },
  'modules/recent-decisions': { items: [] },
  works: { items: [card(1), card(2)], nextCursor: null },
  rankings: { metric: 'reads', interval: 'week', items: [{ ...card(10), score: 3 }] },
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  indexRead = indexPage;
  indexStatus = 200;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      .pathname;
    if (path === `/v1/zones/${zone}/routes`)
      return Response.json(indexRead, { status: indexStatus });
    const read = path.replace(`/v1/realms/${realm}/`, '');
    const found = path.startsWith(`/v1/realms/${realm}/`) ? reads[read] : undefined;
    return found === undefined
      ? Response.json({ code: 'missing' }, { status: 404 })
      : Response.json(found);
  }) as typeof fetch;
});

describe('mounted Collection shelves on Zone homes', () => {
  const presentation: ZonePresentation = {
    ...defaultPresentation(zoneMessages),
    modules: [
      {
        id: 'catalogue',
        type: 'shelf',
        title: 'Catalogue',
        source: { kind: 'collection', collection },
        options: { limit: 1 },
      },
    ],
  };
  const context = {
    locale: 'en' as const,
    ref: 'light-novels',
    realm,
    zone,
    mounts: new Map([[collection, 'catalogue']]),
  };
  const load = async () => {
    const shelf = (await loadModules(presentation, context))[0]!;
    if (!isType(shelf, 'shelf')) throw new Error('Expected a shelf');
    return shelf;
  };

  test('loads the catalogue preview, preserves mounted links and sends More to the full catalogue', async () => {
    const shelf = await load();
    expect(shelf.module.more).toBe('/en/z/light-novels/catalogue');
    expect(shelf.state.state).toBe('ready');
    if (shelf.state.state !== 'ready') throw new Error('Catalogue shelf did not load');
    expect(shelf.state.data.tabs[0]!.items.map((item) => item.href)).toEqual([
      `/z/light-novels/catalogue/${uuidToSid(workId(8))}`,
    ]);
  });

  test('collection and feed tabs both load, each keeping its source links', async () => {
    const modules = await loadModules(
      {
        ...presentation,
        modules: [
          {
            ...presentation.modules[0]!,
            tabs: [
              { id: 'catalogue', label: 'Catalogue', source: { kind: 'collection', collection } },
              { id: 'new', label: 'New', source: { kind: 'query-block', block: 'new-adoptions' } },
            ],
          },
        ],
      },
      context,
    );
    const shelf = modules[0]!;
    if (!isType(shelf, 'shelf') || shelf.state.state !== 'ready')
      throw new Error('Tabbed shelf did not load');
    expect(shelf.state.data.tabs.map((tab) => tab.items[0]!.href)).toEqual([
      `/z/light-novels/catalogue/${uuidToSid(workId(8))}`,
      `/z/light-novels/w/${uuidToSid(workId(1))}`,
    ]);
  });

  test('an empty catalogue is empty; a failed or mismatched read stays visibly failed', async () => {
    indexRead = { ...indexPage, items: [], nextCursor: null };
    expect((await load()).state.state).toBe('empty');
    indexStatus = 503;
    expect((await load()).state.state).toBe('failed');
    indexStatus = 200;
    indexRead = { ...indexPage, collection: iri(workId(99)) };
    expect((await load()).state.state).toBe('failed');
    expect(
      (await loadModules(presentation, { ...context, mounts: new Map() }))[0]!.state.state,
    ).toBe('failed');
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every `href` a module hands its cards and rows, except where reading or a person's page is meant to leave. */
function hrefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) hrefs(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'latestChapter' || key === 'authorHref' || key === 'image') continue;
      if (key === 'href' && typeof item === 'string') found.push(item);
      else hrefs(item, found);
    }
  }
  return found;
}

describe('a Zone is a site a reader never has to leave', () => {
  const presentation: ZonePresentation = {
    ...defaultPresentation(zoneMessages),
    modules: [
      ...defaultPresentation(zoneMessages).modules,
      {
        id: 'lists',
        type: 'editorial-list',
        title: 'Lists',
        source: { kind: 'collection', collection },
      },
      {
        id: 'discuss',
        type: 'discussion-list',
        title: 'Discussions',
        source: { kind: 'query-block', block: 'discussions' },
      },
    ],
  };
  const context = { locale: 'en' as const, ref, realm, mounts: new Map([[collection, 'picks']]) };

  test('every module card and row whose Work is in the population links inside /z/{ref}/', async () => {
    const placed = await loadModules(presentation, context);
    const ready = placed.filter((item) => item.state.state === 'ready');
    // A guard that finds no card would pass for the wrong reason.
    expect(ready.map((item) => item.module.type).sort()).toEqual([
      'discussion-list',
      'editorial-list',
      'hero-carousel',
      'quote-stream',
      'ranking',
      'rising',
      'shelf',
    ]);
    const links = ready.flatMap((item) =>
      hrefs(item.state.state === 'ready' ? item.state.data : null),
    );
    expect(links.length).toBeGreaterThan(10);
    for (const href of links) expect(withoutLocale(href)).toStartWith(`/z/${ref}/`);
  });

  test('a card from a mounted Collection opens under its mount, the rest under /w', async () => {
    const lists = (await loadModules(presentation, context)).find(
      (item) => item.module.type === 'editorial-list',
    )!;
    if (lists.state.state !== 'ready') throw new Error('The editors’ list did not load');
    const { items, href } = (
      lists.state.data as { lists: { href: string | null; items: { href: string }[] }[] }
    ).lists[0]!;
    expect(href).toBe(`/z/${ref}/picks`);
    expect(items.map((item) => item.href)).toEqual([
      `/z/${ref}/picks/${uuidToSid(workId(8))}`,
      `/z/${ref}/picks/${uuidToSid(workId(9))}`,
    ]);
    const shelf = (await loadModules(presentation, context)).find(
      (item) => item.module.type === 'shelf',
    )!;
    expect(hrefs(shelf.state.state === 'ready' ? shelf.state.data : null)).toContain(
      `/z/${ref}/w/${uuidToSid(workId(1))}`,
    );
  });

  test('browse cards link inside the Zone as module cards do', () => {
    expect(zoneWork(card(1), context, null).href).toBe(`/z/${ref}/w/${uuidToSid(workId(1))}`);
    expect(zoneWork(card(1), context, null, 'picks').href).toBe(
      `/z/${ref}/picks/${uuidToSid(workId(1))}`,
    );
  });

  test('a Realm with no Zone site keeps the Work’s own page in its scope', () => {
    expect(zoneWork(card(1), { ...context, unrouted: true }, null).href).toBe(
      `/w/${uuidToSid(workId(1))}?scope=realm&realm=${realm}`,
    );
  });

  test('addresses keep the locale off links and on pages', () => {
    expect(realmWorkHref(ref, workId(1), 'picks')).toBe(`/z/${ref}/picks/${uuidToSid(workId(1))}`);
    expect(siteHref('ja', ref, ['guide'])).toBe(`/ja/z/${ref}/guide`);
  });
});

describe('a Work’s pages inside a Zone', () => {
  const work = workId(1);
  const base: ZoneWorkBase = { ref: work, path: `/z/${ref}/w/${uuidToSid(work)}`, realm };

  test('tabs stay under the Zone and the Zone’s Realm is the default scope', () => {
    expect(workHref(base)).toBe(`/z/${ref}/w/${uuidToSid(work)}`);
    expect(workHref(base, 'contents', defaultScope(base))).toBe(
      `/z/${ref}/w/${uuidToSid(work)}/contents`,
    );
    expect(workHref(base, 'versions', null, { language: 'ja' })).toBe(
      `/z/${ref}/w/${uuidToSid(work)}/versions?language=ja`,
    );
    expect(workHref(base, 'discussion', { kind: 'mine' })).toBe(
      `/z/${ref}/w/${uuidToSid(work)}/discussion?scope=mine`,
    );
    // Everyone's view is a choice, so it says so.
    expect(workHref(base, 'overview', EVERYONE)).toBe(
      `/z/${ref}/w/${uuidToSid(work)}?scope=global`,
    );
    expect(workHref(work, 'overview', EVERYONE)).toBe(`/w/${uuidToSid(work)}`);
  });

  test('an address with no scope opens the Zone’s Realm; an explicit scope is kept', () => {
    expect(scopeAt(base, {})).toEqual({ kind: 'realm', realm });
    expect(scopeAt(base, { scope: 'global' })).toEqual(EVERYONE);
    expect(scopeAt(base, { scope: 'mine' })).toEqual({ kind: 'mine' });
    expect(scopeAt(base, { scope: 'realm' })).toBeNull();
    expect(scopeAt(work, {})).toEqual(EVERYONE);
  });

  test('the current tab is read from the address under the Zone’s base, also through a mount', () => {
    expect(tabOf(`/en/z/${ref}/w/${uuidToSid(work)}`, base)).toBe('overview');
    expect(tabOf(`/zh-Hans/z/${ref}/w/${uuidToSid(work)}/history`, base)).toBe('history');
    const mounted: ZoneWorkBase = { ...base, path: `/z/${ref}/picks/${uuidToSid(work)}` };
    expect(tabOf(`/en/z/${ref}/picks/${uuidToSid(work)}/discussion`, mounted)).toBe('discussion');
    expect(tabOf(`/en/w/${uuidToSid(work)}/contents`)).toBe('contents');
  });

  test('reading stays global', () => {
    expect(chapterHref(base, 'abc', 'ja')).toBe(`/w/${uuidToSid(work)}/read/abc?language=ja`);
    expect(textHref(base)).toBe(`/w/${uuidToSid(work)}/read`);
  });
});
