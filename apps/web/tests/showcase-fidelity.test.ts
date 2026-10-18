import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { workCoverProps, type ZoneWork } from '@rezics/zone-sdk';
import { readShowcaseWorks, type ShowcaseWork } from '../features/api/showcase.ts';
import { browserMainApi } from '../features/api/browser.ts';
import { coverProps } from '../features/catalogue/work.ts';
import { seedServedTypes } from '../features/catalogue/type-fixtures.ts';
import { resourceWork } from '../features/discover/resource-card.tsx';
import type { ResourceCard } from '../features/discover/api.ts';
import { workLink, zoneWork, type AdaptContext } from '../features/realm/adapt.ts';
import { loadDiscussionModule, loadEditorListsModule, loadHeroModule, loadQuoteModule, summaryWork } from '../features/realm/modules.ts';
import type { ZoneEditorLists, ZoneReplyPage } from '../features/realm/types.ts';
import { loadPreviewHomeModules, loadPublishedHomeModules, localizedHomePresentation } from '../features/zone-editor/home-modules.ts';
import { collectionPreview, previewCollection, previewReaders, previewShowcaseWork, previewSummary, previewWork } from '../features/zone-editor/home-modules.fixtures.ts';
import { cataloguePlatformWork, catalogueWork } from '../features/zones/card.tsx';
import type { PresentationModule } from '../features/zones/presentation.ts';

beforeAll(seedServedTypes);
const context: AdaptContext = { locale: 'en', ref: 'books', realm: previewCollection,
  mounts: new Map([[previewCollection, 'picks']]) };
const position = previewShowcaseWork.sourcePosition;
const book: ShowcaseWork = { ...previewShowcaseWork,
  title: { value: 'كتاب النهر', language: 'ar', direction: 'rtl', basis: 'fallback' },
  tagline: { value: 'A saved description', language: 'en', direction: 'ltr', basis: 'requested' },
  completionStatus: 'ongoing', chapterCount: 12, wordCount: 24000, lastUpdatedAt: '2026-10-18T10:00:00.000Z',
  factObligations: { status: 'unassessed' },
  primaryCredits: [...previewShowcaseWork.primaryCredits, {
    id: previewCollection, role: 'author', participantKind: 'external-reference', agent: null,
    displayName: 'Second Author', handle: null, provider: 'open-library', key: '/authors/OL2A', ordinal: 1 }],
};
const fullWorks: typeof readShowcaseWorks = async targets => new Map(targets.filter(target => target === book.id).map(target => [target, book]));
const noWorks: typeof readShowcaseWorks = async () => new Map();
const noCards = async () => new Map<string, ZoneWork>();
const knownCards = async () => new Map([[book.id, zoneWork(book, context, null)]]);

function discoveryCard(work: ShowcaseWork): ResourceCard {
  return { id: work.id, kind: 'work', types: work.types, name: work.title, icon: work.cover,
    work: { primaryCredits: work.primaryCredits.map(credit => ({ ...credit, identityStatus: 'active' as const })),
      creditCount: { value: work.primaryCredits.length, kind: 'exact' }, rating: null } };
}

function expectIdentity(work: ZoneWork, source = book) {
  const canonical = resourceWork(discoveryCard(source));
  expect(coverProps(catalogueWork(work))).toEqual(coverProps(canonical));
  expect(catalogueWork(work).title).toEqual(source.title);
  expect(workCoverProps(work).authors).toEqual(canonical.authors.map(author => author.name));
  expect(work).toMatchObject({ kind: 'book', author: { value: 'Jane Austen' },
    authorHref: '/authors/open-library/OL21594A', title: { lang: source.title.language, dir: source.title.direction },
    tagline: { value: 'A saved description' }, status: 'ongoing', chapters: 12, words: 24000,
    updatedAt: '2026-10-18T10:00:00.000Z', factObligations: { status: 'unassessed' } });
}

describe('curated Work identity', () => {
  test('thin summaries are named links without a fabricated card kind or cover', () => {
    const reference = summaryWork({ id: book.id, title: book.title }, context);
    expect(reference.href).toBe(workLink(context, book.id, null));
    expect(reference).not.toHaveProperty('kind');
    expect(reference).not.toHaveProperty('cover');
  });

  for (const type of ['shelf', 'editorial-list', 'rising', 'hero-carousel'] as const) {
    test(`saved and published ${type} retain the canonical Book and saved metadata`, async () => {
      const preview = collectionPreview();
      preview.presentation.modules[0]!.type = type;
      const presentation = localizedHomePresentation(preview.presentation, 'en');
      const read = { ...previewReaders(), summaries: fullWorks };
      const loaded = await loadPreviewHomeModules(preview, presentation, context, read);
      expect(await loadPublishedHomeModules(preview, presentation, context, read)).toEqual(loaded);
      const state = loaded.modules[0]!.state;
      if (state.state !== 'ready') throw new Error('Saved module did not load');
      const work = 'tabs' in state.data ? state.data.tabs[0]!.items[0]! as ZoneWork
        : 'lists' in state.data ? state.data.lists[0]!.items[0]!
          : 'slides' in state.data ? state.data.slides[0]!.work! : 'items' in state.data ? state.data.items[0] as ZoneWork : null;
      expect(work).not.toBeNull();
      expectIdentity(work!);
    });
  }

  test('a selected image and its public cover credit survive the Zone and catalogue adapters', () => {
    const coverCredit = { kind: 'copyright' as const, text: 'Cover by Artist', holder: 'Artist',
      source: { name: 'Publisher', href: 'https://publisher.example/cover' }, permittedRole: 'cover' as const };
    const illustrated: ShowcaseWork = { ...book, cover: { kind: 'image', selection: previewCollection,
      url: '/v1/media/cover/selected.webp', mediaType: 'image/webp', width: 600, height: 900,
      crop: 'xywh=percent:10,10,60,80', coverCredit, basis: { policy: 'avatar-v1', context: previewCollection } } };
    const adapted = zoneWork(illustrated, context, null);
    expectIdentity(adapted, illustrated);
    expect(workCoverProps(adapted).image?.coverCredit).toEqual(coverCredit);
    expect(coverProps(catalogueWork(adapted)).image?.src).toBe('/api/main/v1/media/cover/selected.webp');
  });

  test('platform metadata keeps the creator preview off its byline', () => {
    expect(catalogueWork(cataloguePlatformWork(zoneWork(book, context, null))).authors).toEqual([]);
  });

  test('semantic kinds come from the Work, including non-Book curated members', async () => {
    for (const [type, kind] of [['https://schema.org/DigitalDocument', 'document'], ['https://schema.org/Recipe', 'recipe']] as const) {
      const preview = collectionPreview();
      const read = { ...previewReaders(), summaries: async () => new Map([[book.id, { ...book, types: [type] }]]) };
      const loaded = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'), context, read);
      expect(loaded.modules[0]?.state).toMatchObject({ state: 'ready', data: { tabs: [{ items: [{ kind }] }] } });
    }
  });

  test('saved display windows hydrate only their visible members and preserve their order', async () => {
    const preview = collectionPreview();
    preview.presentation.modules[0]!.options = { limit: 1 };
    preview.moduleData[0].sources[0].members.push({ work: previewCollection });
    const summaries = mock(fullWorks);
    const loaded = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'), context,
      { ...previewReaders(), summaries });
    expect(loaded.modules[0]?.state.state).toBe('ready');
    expect(summaries.mock.calls[0]?.[0]).toEqual([previewWork]);
  });

  test('partial sources and missing displayed cards remain failed, with no invented replacements', async () => {
    for (const state of ['partial', 'skipped', 'unavailable', 'complete']) {
      const preview = collectionPreview(state);
      const summaries = mock(noWorks);
      const loaded = await loadPreviewHomeModules(preview, localizedHomePresentation(preview.presentation, 'en'), context,
        { ...previewReaders(), summaries });
      expect(loaded.modules[0]?.state).toEqual({ state: 'failed' });
      if (state !== 'complete') expect(summaries).not.toHaveBeenCalled();
    }
  });
});

function module(type: PresentationModule['type'], block: string): PresentationModule {
  return { id: type, type, title: 'Readers’ picks', source: { kind: 'query-block', block } };
}
const reply = { id: previewCollection, placement: previewCollection, author: previewCollection, authorName: 'Reader',
  work: { id: book.id, title: book.title, inZone: false }, excerpt: 'A memorable passage', dataEpoch: position.dataEpoch, sequence: '0' };
const replies: ZoneReplyPage = { profile: 'zone-reader-quotes-v1', realm: context.realm, items: [reply],
  nextCursor: null, sourcePosition: position, count: { value: 1, kind: 'exact-page', total: null } };
const lists: ZoneEditorLists = { profile: 'zone-editor-lists-v1', realm: context.realm, sourcePosition: position,
  lists: [{ collection: previewCollection, name: book.title, state: 'complete',
    items: [{ id: book.id, title: book.title, cover: book.cover, inZone: true }] }] };

describe('Realm modules with missing supplementary cards', () => {
  test('a scheduled Book uses its full public identity without a Realm adoption card', async () => {
    const preview = collectionPreview();
    preview.presentation.slides = [{ id: 'book', work: book.id }];
    const state = await loadHeroModule(module('hero-carousel', 'new-adoptions'),
      localizedHomePresentation(preview.presentation, 'en'), context, [], undefined, noCards, fullWorks);
    if (state.state !== 'ready') throw new Error('Hero did not load');
    expectIdentity(state.data.slides[0]!.work!);
  });

  test('a missing header can use a complete Realm card; missing both produces a failed hero', async () => {
    const preview = collectionPreview();
    preview.presentation.slides = [{ id: 'book', work: book.id }];
    const presentation = localizedHomePresentation(preview.presentation, 'en');
    const hero = module('hero-carousel', 'new-adoptions');
    const state = await loadHeroModule(hero, presentation, context, [], undefined, knownCards, noWorks);
    if (state.state !== 'ready') throw new Error('Known Book did not load');
    expectIdentity(state.data.slides[0]!.work!);
    expect(await loadHeroModule(hero, presentation, context, [], undefined, noCards, noWorks)).toEqual({ state: 'failed' });
  });

  test('a full scheduled header retains its semantic kind when an older Realm card differs', async () => {
    const preview = collectionPreview();
    preview.presentation.slides = [{ id: 'book', work: book.id }];
    const olderCards = async () => new Map([[book.id, { ...zoneWork(book, context, null), kind: 'document' as const }]]);
    const state = await loadHeroModule(module('hero-carousel', 'new-adoptions'),
      localizedHomePresentation(preview.presentation, 'en'), context, [], undefined, olderCards, fullWorks);
    if (state.state !== 'ready') throw new Error('Hero did not load');
    expectIdentity(state.data.slides[0]!.work!);
  });

  for (const type of ['quote-stream', 'discussion-list'] as const) {
    test(`${type} hydrates a missing Realm card and refuses an unavailable Work`, async () => {
      const load = async (works: typeof readShowcaseWorks, cards = noCards) => type === 'quote-stream'
        ? loadQuoteModule(module(type, 'reader-quotes'), context, { cards, quotes: async () => ({ ok: true, data: replies }) }, works)
        : loadDiscussionModule(module(type, 'discussions'), context, { cards, discussions: async () => ({ ok: true, data: replies }) }, works);
      const state = await load(fullWorks);
      if (state.state !== 'ready') throw new Error('Reader module did not load');
      const work = 'quotes' in state.data ? state.data.quotes[0]!.work : state.data.items[0]!.work!;
      expectIdentity(work);
      expect(work.href).toMatch(/^\/w\//);
      expect(await load(noWorks)).toEqual({ state: 'failed' });
      const fallback = mock(noWorks);
      expect((await load(fallback, knownCards)).state).toBe('ready');
      expect(fallback).not.toHaveBeenCalled();
    });
  }

  test('editorial cards retain complete identity, mounted links, partial and unavailable states', async () => {
    const editorial = { ...module('editorial-list', ''), source: { kind: 'collection' as const, collection: previewCollection } };
    const read = { lists: async () => ({ ok: true as const, data: lists }), cards: noCards, works: fullWorks };
    const state = await loadEditorListsModule(editorial, context, read);
    if (state.state !== 'ready') throw new Error('Editorial list did not load');
    expectIdentity(state.data.lists[0]!.items[0]!);
    expect(state.data.lists[0]!.items[0]!.href).toContain('/picks/');
    expect(await loadEditorListsModule(editorial, context, { ...read, works: noWorks })).toEqual({ state: 'failed' });
    expect(await loadEditorListsModule(editorial, context, { ...read, lists: async () => ({ ok: true,
      data: { ...lists, lists: [{ ...lists.lists[0]!, state: 'partial' }] } }) })).toEqual({ state: 'failed' });
  });
});

describe('bounded public showcase hydration', () => {
  function transport(options: { headerStatus?: number; creditsStatus?: number; available?: boolean;
    complete?: boolean; wrongHeader?: boolean; creditPartial?: boolean; creditCursor?: string | null } = {}) {
    const calls: { path: string; body: Record<string, unknown> | null; credentials?: RequestCredentials }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      calls.push({ path: url.pathname, body, credentials: init?.credentials });
      if (url.pathname.endsWith('/summaries')) return Response.json({ complete: options.complete ?? true,
        summaries: [options.available === false ? { reference: book.id, status: 'unavailable' }
          : { ...previewSummary, name: book.title, avatar: book.cover }] });
      if (url.pathname.endsWith('/query')) return Response.json({ result: { profile: 'template-result-v1',
        query: 'https://rezics.com/query/work-credits', revision: 1, items: book.primaryCredits,
        complete: !options.creditPartial, nextCursor: options.creditCursor ?? null } }, { status: options.creditsStatus ?? 200 });
      return Response.json({ ...book, title: previewShowcaseWork.title,
        id: options.wrongHeader ? previewCollection : book.id }, { status: options.headerStatus ?? 200 });
    }) as typeof fetch;
    return { calls, client: browserMainApi('http://showcase.test', { anonymous: true, fetcher }) };
  }

  test('summary selection, header meaning and role-filtered credit preview form one complete card', async () => {
    const { calls, client } = transport();
    const works = await readShowcaseWorks([book.id, book.id], context.realm, client);
    expectIdentity(zoneWork(works.get(book.id)!, context, null));
    expect(calls).toHaveLength(3);
    expect(calls.every(call => call.credentials === 'omit')).toBe(true);
    expect(calls.find(call => call.path.endsWith('/summaries'))?.body).toMatchObject({ resources: [book.id], context: context.realm });
    expect(calls.find(call => call.path.endsWith('/query'))?.body).toMatchObject({ limit: 3, parameters: { roots: [book.id], role: 'author' } });
  });

  test('a bounded public author preview accepts its real continuation and omits an absent context', async () => {
    const { calls, client } = transport({ creditPartial: true, creditCursor: 'next-public-authors' });
    const works = await readShowcaseWorks([book.id], '', client);
    expectIdentity(zoneWork(works.get(book.id)!, { ...context, realm: '' }, null));
    expect(calls.find(call => call.path.endsWith('/summaries'))?.body).not.toHaveProperty('context');
  });

  test('public hydration keeps at most four Works in flight and returns only requested identities', async () => {
    const targets = Array.from({ length: 9 }, (_, index) =>
      `https://rezics.com/id/00000000-0000-4000-8000-${String(index + 100).padStart(12, '0')}`);
    let active = 0;
    let maximum = 0;
    let headers = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/summaries')) return Response.json({ complete: true,
        summaries: [...targets, previewWork].map(reference => ({ ...previewSummary, reference })) });
      if (path.endsWith('/query')) return Response.json({ result: { profile: 'template-result-v1',
        query: 'https://rezics.com/query/work-credits', revision: 1, items: [], complete: true, nextCursor: null } });
      active += 1;
      maximum = Math.max(maximum, active);
      headers += 1;
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return Response.json({ ...book, id: 'https://rezics.com/id/' + path.split('/').at(-1) });
    }) as typeof fetch;
    const works = await readShowcaseWorks(targets, context.realm,
      browserMainApi('http://showcase.test', { anonymous: true, fetcher }));
    expect([...works.keys()].sort()).toEqual([...targets].sort());
    expect(headers).toBe(9);
    expect(maximum).toBe(4);
  });

  for (const options of [{ headerStatus: 404 }, { headerStatus: 403 }, { creditsStatus: 503 },
    { available: false }, { complete: false }, { wrongHeader: true }, { creditPartial: true }]) {
    test(`an unavailable or incomplete public identity stays absent: ${JSON.stringify(options)}`, async () => {
      const { client } = transport(options);
      expect((await readShowcaseWorks([book.id], context.realm, client)).size).toBe(0);
    });
  }

  test('no targets cause no reads, and an oversized or malformed batch is rejected', async () => {
    const { calls, client } = transport();
    expect((await readShowcaseWorks([], context.realm, client)).size).toBe(0);
    expect(calls).toHaveLength(0);
    await expect(readShowcaseWorks(['not-a-work'], context.realm, client)).rejects.toThrow('targets are invalid');
    const targets = Array.from({ length: 65 }, (_, index) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
    await expect(readShowcaseWorks(targets, context.realm, client)).rejects.toThrow('targets are invalid');
  });
});
