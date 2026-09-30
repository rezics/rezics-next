import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { zoneWork } from '../features/realm/adapt.ts';
import { loadModules } from '../features/realm/modules.ts';
import { realmWorkHref, siteHref } from '../features/realm/route.ts';
import { messages as zoneMessages } from '../features/zones/messages.ts';
import { defaultPresentation, type ZonePresentation } from '../features/zones/presentation.ts';
import { withoutLocale } from '../i18n/locale.ts';
import { chapterHref, defaultScope, EVERYONE, scopeAt, tabOf, textHref, workHref, type ZoneWorkBase }
  from '../features/work-page/route.ts';

const realm = '7c3e9a1d-2b4f-4d6e-8a0c-5e7f9b1d3c2a';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const workId = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const collection = iri('11111111-1111-4111-8111-111111111111');
const ref = 'books';
const name = (value: string) => ({ value, language: 'en', direction: 'ltr' as const, basis: 'requested' as const });
const cover = (id: string) => ({ kind: 'fallback' as const, policy: 'zone', key: id, resourceType: 'work' });
const card = (n: number) => ({ id: iri(workId(n)), title: name(`Work ${n}`), cover: cover(iri(workId(n))),
  types: ['https://schema.org/Book'], tagline: null, completionStatus: null, chapterCount: null, wordCount: null,
  lastUpdatedAt: null, evidence: null, primaryCredits: [], hub: null });
const thin = (n: number) => ({ id: iri(workId(n)), title: name(`Work ${n}`), cover: cover(iri(workId(n))) });

/** Main's module reads for one Realm, served from fixtures; every other read is a 404, like an unmounted route. */
const reads: Record<string, unknown> = {
  'modules/new-adoptions': { items: [card(1), card(2)] },
  'modules/recently-completed': { items: [card(3)] },
  'modules/latest-chapters': { items: [{ work: card(4), chapter: iri(workId(40)), chapterTitle: name('One'),
    chapterUpdatedAt: '2026-09-30T00:00:00.000Z' }] },
  'modules/rising': { items: [{ ...card(5), score: 1 }] },
  'modules/reader-quotes': { items: [{ id: iri(workId(60)), excerpt: 'A line', authorName: 'Reader', work: thin(6) }] },
  'modules/discussions': { items: [{ id: iri(workId(61)), excerpt: 'A thread', work: thin(7) }] },
  'modules/editor-lists': { lists: [{ collection, name: name('Picks'), items: [thin(8), thin(9)] }] },
  'modules/recent-decisions': { items: [] },
  works: { items: [card(1), card(2)], nextCursor: null },
  rankings: { metric: 'reads', interval: 'week', items: [{ ...card(10), score: 3 }] },
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
    const read = path.replace(`/v1/realms/${realm}/`, '');
    const found = path.startsWith(`/v1/realms/${realm}/`) ? reads[read] : undefined;
    return found === undefined ? Response.json({ code: 'missing' }, { status: 404 }) : Response.json(found);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

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
  const presentation: ZonePresentation = { ...defaultPresentation(zoneMessages), modules: [
    ...defaultPresentation(zoneMessages).modules,
    { id: 'lists', type: 'editorial-list', title: 'Lists', source: { kind: 'collection', collection } },
    { id: 'discuss', type: 'discussion-list', title: 'Discussions', source: { kind: 'query-block', block: 'discussions' } },
  ] };
  const context = { locale: 'en' as const, ref, realm, mounts: new Map([[collection, 'picks']]) };

  test('every module card and row whose Work is in the population links inside /r/{ref}/', async () => {
    const placed = await loadModules(presentation, context);
    const ready = placed.filter(item => item.state.state === 'ready');
    // A guard that finds no card would pass for the wrong reason.
    expect(ready.map(item => item.module.type).sort()).toEqual(['discussion-list', 'editorial-list', 'hero-carousel',
      'quote-stream', 'ranking', 'rising', 'shelf']);
    const links = ready.flatMap(item => hrefs(item.state.state === 'ready' ? item.state.data : null));
    expect(links.length).toBeGreaterThan(10);
    for (const href of links) expect(withoutLocale(href)).toStartWith(`/r/${ref}/`);
  });

  test('a card from a mounted Collection opens under its mount, the rest under /w', async () => {
    const lists = (await loadModules(presentation, context)).find(item => item.module.type === 'editorial-list')!;
    if (lists.state.state !== 'ready') throw new Error('The editors’ list did not load');
    const { items, href } = (lists.state.data as { lists: { href: string | null; items: { href: string }[] }[] }).lists[0]!;
    expect(href).toBe(`/r/${ref}/picks`);
    expect(items.map(item => item.href)).toEqual([`/r/${ref}/picks/${workId(8)}`, `/r/${ref}/picks/${workId(9)}`]);
    const shelf = (await loadModules(presentation, context)).find(item => item.module.type === 'shelf')!;
    expect(hrefs(shelf.state.state === 'ready' ? shelf.state.data : null)).toContain(`/r/${ref}/w/${workId(1)}`);
  });

  test('browse cards link inside the Zone as module cards do', () => {
    expect(zoneWork(card(1), context, null).href).toBe(`/r/${ref}/w/${workId(1)}`);
    expect(zoneWork(card(1), context, null, 'picks').href).toBe(`/r/${ref}/picks/${workId(1)}`);
  });

  test('a Realm with no Zone site keeps the Work’s own page in its scope', () => {
    expect(zoneWork(card(1), { ...context, unrouted: true }, null).href)
      .toBe(`/w/${workId(1)}?scope=realm&realm=${realm}`);
  });

  test('addresses keep the locale off links and on pages', () => {
    expect(realmWorkHref(ref, workId(1), 'picks')).toBe(`/r/${ref}/picks/${workId(1)}`);
    expect(siteHref('ja', ref, ['guide'])).toBe(`/ja/r/${ref}/guide`);
  });
});

describe('a Work’s pages inside a Zone', () => {
  const work = workId(1);
  const base: ZoneWorkBase = { ref: work, path: `/r/${ref}/w/${work}`, realm };

  test('tabs stay under the Zone and the Zone’s Realm is the default scope', () => {
    expect(workHref(base)).toBe(`/r/${ref}/w/${work}`);
    expect(workHref(base, 'contents', defaultScope(base))).toBe(`/r/${ref}/w/${work}/contents`);
    expect(workHref(base, 'versions', null, { language: 'ja' })).toBe(`/r/${ref}/w/${work}/versions?language=ja`);
    expect(workHref(base, 'discussion', { kind: 'mine' })).toBe(`/r/${ref}/w/${work}/discussion?scope=mine`);
    // Everyone's view is a choice, so it says so.
    expect(workHref(base, 'overview', EVERYONE)).toBe(`/r/${ref}/w/${work}?scope=global`);
    expect(workHref(work, 'overview', EVERYONE)).toBe(`/w/${work}`);
  });

  test('an address with no scope opens the Zone’s Realm; an explicit scope is kept', () => {
    expect(scopeAt(base, {})).toEqual({ kind: 'realm', realm });
    expect(scopeAt(base, { scope: 'global' })).toEqual(EVERYONE);
    expect(scopeAt(base, { scope: 'mine' })).toEqual({ kind: 'mine' });
    expect(scopeAt(base, { scope: 'realm' })).toBeNull();
    expect(scopeAt(work, {})).toEqual(EVERYONE);
  });

  test('the current tab is read from the address under the Zone’s base, also through a mount', () => {
    expect(tabOf(`/en/r/${ref}/w/${work}`, base)).toBe('overview');
    expect(tabOf(`/zh-Hans/r/${ref}/w/${work}/history`, base)).toBe('history');
    const mounted: ZoneWorkBase = { ...base, path: `/r/${ref}/picks/${work}` };
    expect(tabOf(`/en/r/${ref}/picks/${work}/discussion`, mounted)).toBe('discussion');
    expect(tabOf(`/en/w/${work}/contents`)).toBe('contents');
  });

  test('reading stays global', () => {
    expect(chapterHref(base, 'abc', 'ja')).toBe(`/w/${work}/read/abc?language=ja`);
    expect(textHref(base)).toBe(`/w/${work}/read`);
  });
});
