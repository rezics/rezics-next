import { describe, expect, test } from 'vitest';
import type { ZoneWork } from '@rezics/zone-sdk';
import { zoneContentText } from '../language/untagged.ts';
import { zoneWork, type AdaptContext, type ModuleCredit } from '../realm/adapt.ts';
import {
  loadDecisionModule,
  loadDiscussionModule,
  loadFeedWorks,
  loadGenreModule,
  loadHeroModule,
  loadPeopleModule,
  loadQuoteModule,
  loadRisingModule,
  loadShelfModule,
} from '../realm/modules.ts';
import type {
  Loaded,
  MainName,
  RankingPage,
  ReadFailure,
  ZoneChapterPage,
  ZoneDecisionPage,
  ZoneGenrePage,
  ZoneReplyPage,
  ZoneWorkPage,
} from '../realm/types.ts';
import { presetTokens, type PresentationModule, type RealmFeed, type ZonePresentation } from '../zones/presentation.ts';
import type { ModuleState } from '../zones/zone-home.tsx';

const iri = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const context: AdaptContext = { locale: 'en', ref: 'harbor', realm: iri(1) };
const position = { dataEpoch: '00000000-0000-4000-8000-000000000002', sequence: '7' };
const continuation = 'more-public-candidates';
const cards = async (context: AdaptContext, targets: readonly string[]) => new Map<string, ZoneWork>(
  targets.map(target => {
    const card = work(Number(target.slice(-12)) - 10);
    return [target, zoneWork(card, context, card.evidence)];
  }),
);
const name = (value: string): MainName => {
  const text = zoneContentText(value, 'en');
  return { value: text.value, language: text.lang, direction: text.dir, basis: 'requested' };
};

function work(index: number): ZoneWorkPage['items'][number] {
  const id = iri(10 + index);
  return {
    id, revision: iri(30 + index), mainVersion: iri(40 + index), title: name(`Public Work ${index + 1}`),
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: id, resourceType: 'work' },
    types: [], tagline: null, completionStatus: null, chapterCount: null, wordCount: null, lastUpdatedAt: null,
    inZone: true, evidence: iri(50 + index), dataEpoch: position.dataEpoch, sequence: position.sequence,
    primaryCredits: [], hub: null,
  };
}

function pageFields(size: number, nextCursor: string | null) {
  return { nextCursor, sourcePosition: position, count: { value: size, kind: 'exact-page' as const, total: null } };
}

function workPage(size: number, nextCursor: string | null,
  profile: ZoneWorkPage['profile'] = 'zone-new-adoptions-v1'): ZoneWorkPage {
  return { profile, realm: context.realm, items: Array.from({ length: size }, (_, index) => work(index)),
    ...pageFields(size, nextCursor) };
}

function chapterPage(indices: number[], nextCursor: string | null): ZoneChapterPage {
  return { profile: 'zone-latest-chapters-v1', realm: context.realm,
    items: indices.map((index, chapter) => ({
      work: work(index), chapter: iri(60 + chapter), chapterTitle: name(`Chapter ${chapter + 1}`),
      chapterUpdatedAt: null, publication: iri(70 + chapter), contentRevision: iri(80 + chapter), language: 'en',
      dataEpoch: position.dataEpoch, sequence: String(7 - chapter),
    })), ...pageFields(indices.length, nextCursor) };
}

function risingPage(size: number, nextCursor: string | null): RankingPage {
  return { profile: 'rising-v1', realm: context.realm, metric: 'reads', interval: 'week', bucket: '2026-10-12',
    contentPosition: position, examined: size,
    items: Array.from({ length: size }, (_, index) => ({ ...work(index), score: 20 - index, growth: 2 })),
    ...pageFields(size, nextCursor) } as RankingPage;
}

function decisionPage(size: number, nextCursor: string | null): ZoneDecisionPage {
  return { profile: 'zone-recent-decisions-v1', realm: context.realm,
    items: Array.from({ length: size }, (_, index) => ({
      id: iri(90 + index), kind: 'adoption' as const, dataEpoch: position.dataEpoch, sequence: String(7 - index),
      work: work(index).id, subject: null, outcome: 'accepted' as const,
    })), summary: { adoption: size, classification: 0, semanticRuleChange: 0, basis: 'exact-page' },
    ...pageFields(size, nextCursor) };
}

function replyPage(size: number, nextCursor: string | null,
  profile: ZoneReplyPage['profile']): ZoneReplyPage {
  return { profile, realm: context.realm,
    items: Array.from({ length: size }, (_, index) => ({
      id: iri(100 + index), placement: iri(110 + index), author: iri(120 + index), authorName: `Reader ${index + 1}`,
      work: { id: work(index).id, title: work(index).title, inZone: true },
      excerpt: `A public reader's account of Work ${index + 1}.`,
      dataEpoch: position.dataEpoch, sequence: String(7 - index),
    })), ...pageFields(size, nextCursor) };
}

function genrePage(size: number, nextCursor: string | null): ZoneGenrePage {
  return { profile: 'zone-genres-v1', realm: context.realm, context: iri(3), generation: position.dataEpoch,
    stale: false, projectionPosition: position,
    items: Array.from({ length: size }, (_, index) => ({ id: iri(130 + index), concept: iri(140 + index),
      name: name(`Genre ${index + 1}`), workCount: 4 })), ...pageFields(size, nextCursor) };
}

function loaded<T>(data: T, failure?: ReadFailure): Loaded<T> {
  return failure ? { ok: false, failure } : { ok: true, data };
}

function homeWindow<T>(data: T, nextCursor: string | null, failure?: ReadFailure) {
  return failure ? { ok: false as const, failure } : { ok: true as const, data, nextCursor };
}

function presentationModule(type: PresentationModule['type'], block: string): PresentationModule {
  return { id: `public-${type}`, type, title: 'Public selection', source: { kind: 'query-block', block },
    options: { limit: 2 } };
}

const shelf = presentationModule('shelf', 'new-adoptions');
const hero = presentationModule('hero-carousel', 'new-adoptions');
const presentation: ZonePresentation = {
  profile: 'zone-presentation-v2', preset: 'clean', tokens: presetTokens.clean,
  navigation: [], slides: [], modules: [hero],
};
const people = presentationModule('people', 'new-adoptions');
const genre: PresentationModule = { ...presentationModule('chip-nav', 'genres'), source: { kind: 'context', context: iri(3) } };

function peopleWorks(size: number, sameAuthor = false) {
  return Array.from({ length: size }, (_, index) => ({ title: work(index).title,
    primaryCredits: [{ agent: iri(150 + (sameAuthor ? 0 : index)), handle: null, displayName: `Author ${sameAuthor ? 1 : index + 1}`,
      provider: null, key: null } satisfies ModuleCredit] }));
}

interface Delegate {
  name: string;
  load(size: number, nextCursor: string | null, failure?: ReadFailure): Promise<ModuleState>;
}

const delegates: Delegate[] = [
  { name: 'shelf', load: async (size, nextCursor, failure) => loadShelfModule(shelf, context,
    async () => homeWindow(Array.from({ length: size }, (_, index) => zoneWork(work(index), context, null)), nextCursor, failure)) },
  { name: 'hero feed', load: async (size, nextCursor, failure) => loadHeroModule(hero, presentation, context, [],
    async () => homeWindow(Array.from({ length: size }, (_, index) => zoneWork(work(index), context, null)), nextCursor, failure)) },
  { name: 'rising', load: async (size, nextCursor, failure) => loadRisingModule(presentationModule('rising', 'rising'), context,
    { cards, rising: async () => loaded(risingPage(size, nextCursor), failure) }) },
  { name: 'people', load: async (size, nextCursor, failure) => loadPeopleModule(people, context,
    async () => homeWindow(peopleWorks(size), nextCursor, failure)) },
  { name: 'decisions', load: async (size, nextCursor, failure) => loadDecisionModule(presentationModule('decision-log', 'recent-decisions'), context,
    { decisions: async () => loaded(decisionPage(size, nextCursor), failure), works: async () => ({ ok: false, failure: 'missing' }) }) },
  { name: 'quotes', load: async (size, nextCursor, failure) => loadQuoteModule(presentationModule('quote-stream', 'reader-quotes'), context,
    { cards, quotes: async () => loaded(replyPage(size, nextCursor, 'zone-reader-quotes-v1'), failure) }) },
  { name: 'discussions', load: async (size, nextCursor, failure) => loadDiscussionModule(presentationModule('discussion-list', 'discussions'), context,
    { cards, discussions: async () => loaded(replyPage(size, nextCursor, 'zone-discussions-v1'), failure) }) },
  { name: 'genre chips', load: async (size, nextCursor, failure) => loadGenreModule(genre, context,
    async () => loaded(genrePage(size, nextCursor), failure)) },
];

function displayedCount(state: ModuleState): number {
  if (state.state !== 'ready') return 0;
  const data = state.data;
  if ('tabs' in data) return data.tabs.reduce((count, tab) => count + tab.items.length, 0);
  if ('slides' in data) return data.slides.length;
  if ('items' in data) return data.items.length;
  if ('quotes' in data) return data.quotes.length;
  if ('chips' in data) return data.chips.length;
  throw new Error('The public window did not expose its selected items');
}

describe.each(delegates)('$name public window', ({ load }) => {
  test.each([0, 1])('an underfilled continued source with %i display items stays visibly failed', async size => {
    expect(await load(size, continuation)).toEqual({ state: 'failed' });
  });

  test('a full continued source preserves the author-selected two-item window', async () => {
    const state = await load(3, continuation);
    expect(state.state).toBe('ready');
    expect(displayedCount(state)).toBe(2);
  });

  test('a short terminal source is a complete one-item selection', async () => {
    const state = await load(1, null);
    expect(state.state).toBe('ready');
    expect(displayedCount(state)).toBe(1);
  });

  test('a terminal empty source stays empty', async () => {
    expect(await load(0, null)).toEqual({ state: 'empty' });
  });

  test.each(['missing', 'moved', 'unavailable'] as const)('Main’s %s refusal cannot become an empty or successful selection', async failure => {
    expect(await load(3, null, failure)).toEqual({ state: 'failed' });
  });
});

function feedReaders(nextCursor: string | null, indices = [0], failure?: ReadFailure) {
  return {
    adoptions: async () => loaded(workPage(indices.length, nextCursor), failure),
    completed: async () => loaded(workPage(indices.length, nextCursor, 'zone-recently-completed-v1'), failure),
    chapters: async () => loaded(chapterPage(indices, nextCursor), failure),
    cards,
  };
}

describe('public feed continuation', () => {
  const feeds: RealmFeed[] = ['new-adoptions', 'recently-completed', 'latest-chapters'];

  test.each(feeds)('%s retains Main’s cursor alongside its adapted Works', async feed => {
    const result = await loadFeedWorks(feed, context, feedReaders(continuation));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('The public feed failed');
    expect(result.nextCursor).toBe(continuation);
    expect(result.data.map(item => item.id)).toEqual([work(0).id]);
  });

  test.each(feeds)('%s propagates a denied source without adapting it to empty data', async feed => {
    expect(await loadFeedWorks(feed, context, feedReaders(null, [0], 'missing'))).toEqual({ ok: false, failure: 'missing' });
  });

  test('two chapter candidates for one Work do not fill a continued two-Work shelf', async () => {
    const latest = presentationModule('shelf', 'latest-chapters');
    const read = async () => loadFeedWorks('latest-chapters', context, feedReaders(continuation, [0, 0]));
    const window = await read();
    expect(window.ok).toBe(true);
    if (!window.ok) throw new Error('The chapter feed failed');
    expect(window.data).toHaveLength(1);
    expect(window.nextCursor).toBe(continuation);
    expect(await loadShelfModule(latest, context, read)).toEqual({ state: 'failed' });
  });

  test('terminal repeated chapters retain one Work and its newest chapter', async () => {
    const latest = presentationModule('shelf', 'latest-chapters');
    const state = await loadShelfModule(latest, context,
      async () => loadFeedWorks('latest-chapters', context, feedReaders(null, [0, 0])));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('The terminal chapter shelf failed');
    expect(state.data.tabs[0]?.items.map(item => item.id)).toEqual([work(0).id]);
    expect(state.data.tabs[0]?.items[0]?.latestChapter?.title?.value).toBe('Chapter 1');
  });

  test('distinct Works still fill a continued shelf after repeated chapters are deduplicated', async () => {
    const latest = presentationModule('shelf', 'latest-chapters');
    const state = await loadShelfModule(latest, context,
      async () => loadFeedWorks('latest-chapters', context, feedReaders(continuation, [0, 0, 1])));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('The full chapter shelf failed');
    expect(state.data.tabs[0]?.items.map(item => item.id)).toEqual([work(0).id, work(1).id]);
  });
});

describe('public people continuation', () => {
  test('repeated authors do not fill a continued two-person selection', async () => {
    expect(await loadPeopleModule(people, context,
      async () => homeWindow(peopleWorks(2, true), continuation))).toEqual({ state: 'failed' });
  });

  test('a terminal repeated author remains one person with both Work titles', async () => {
    const state = await loadPeopleModule(people, context, async () => homeWindow(peopleWorks(2, true), null));
    expect(state.state).toBe('ready');
    if (state.state !== 'ready') throw new Error('The terminal people selection failed');
    expect(state.data.items).toHaveLength(1);
    expect(state.data.items[0]?.note?.value).toBe('Public Work 1 · Public Work 2');
  });
});
