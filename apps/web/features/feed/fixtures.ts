import type { FeedApi, VoteReceipt } from './api.ts';
import type { FeedHead, FeedItem, FeedPage, FeedQuery, Loaded, ReadFailure, SuggestedFollow } from './types.ts';

// Story data: feed posts as Main's `home-feed-v1` returns them, and a FeedApi
// that keeps its state in memory and records each call, standing in for Main.

export const storyId = (n: number, tag = '0000') => `https://rezics.com/id/${String(n).padStart(8, '0')}-${tag}-4a6f-8c2d-3e7b5c1a9f40`;
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });
const fallbackCover = (key: string) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key, resourceType: 'work' });

export const NOW = Date.parse('2026-09-28T09:00:00.000Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

export const realms = {
  fiction: { id: storyId(901, 'aaaa'), name: name('中文网络小说 · Chinese Web Fiction'), icon: fallbackCover('fiction') },
  classics: { id: storyId(902, 'aaaa'), name: name('Classic Literature'), icon: fallbackCover('classics') },
  kitchen: { id: storyId(903, 'aaaa'), name: name('Home Cooking · 家常菜'), icon: fallbackCover('kitchen') },
  mods: { id: storyId(904, 'aaaa'), name: name('Stardew Mods'), icon: fallbackCover('mods') },
};

const people = {
  mei: { id: storyId(801, 'bbbb'), name: 'Lin Mei 林梅', handle: 'lin_mei' },
  daniel: { id: storyId(802, 'bbbb'), name: 'Daniel Chen', handle: 'daniel_chen' },
  aria: { id: storyId(803, 'bbbb'), name: 'Aria Wang 王雅', handle: 'aria_wang' },
  leo: { id: storyId(804, 'bbbb'), name: 'Leo Sun', handle: 'leo_sun' },
};

type Overrides = Partial<Omit<FeedItem, 'target'>> & { target?: Partial<FeedItem['target']> };
type Credit = FeedItem['authors'][number];

/** A credited author from Open Library, named but not on REZICS. */
const openLibrary = (n: number, displayName: string): Credit => ({ id: storyId(n, '0a0a'), role: 'author',
  participantKind: 'external-reference', provider: 'open-library', key: `OL${n}A`, ordinal: 0, agent: null, displayName,
  handle: null });
/** A credited author with a REZICS profile. */
const onRezics = (person: { id: string; name: string; handle: string }): Credit => ({ id: storyId(990, '0b0b'), role: 'author',
  participantKind: 'agent', provider: null, key: null, ordinal: null, agent: person.id, displayName: person.name,
  handle: person.handle });

/** One post; `n` keys its IDs so every story item is distinct and stable. */
export function post(n: number, overrides: Overrides = {}): FeedItem {
  const work = storyId(n, 'cccc');
  const actor = overrides.actor ?? people.mei;
  const base: FeedItem = {
    id: storyId(n), kind: 'work', actor, authors: [], reasons: [],
    reason: { kind: 'followed', target: realms.fiction.id, targetKind: 'realm' },
    card: { kind: 'work' }, primaryAction: { kind: 'want-to-read', work }, viewerState: { status: 'anonymous' },
    group: { key: `group-${n}`, count: 1, actors: [actor] },
    target: { id: work, work, title: name(`Work ${n}`), cover: fallbackCover(`work-${n}`),
      types: ['https://schema.org/Book'], excerpt: null, language: 'en' },
    realm: realms.fiction, time: ago(n * 37), timeBasis: 'revision', score: 12, vote: 0, voteRevision: null,
    comments: { value: 3, kind: 'exact' },
    links: { target: `/w/${work.slice(-36)}`, actor: `/@${actor.handle}`, comments: `/w/${work.slice(-36)}/discussion`,
      vote: `/v1/feed/${storyId(n).slice(-36)}/vote` },
  };
  return { ...base, ...overrides, target: { ...base.target, ...overrides.target } };
}

const chapterAction = (n: number, chapter: number) => ({ kind: 'read-chapter' as const, work: storyId(n, 'cccc'),
  occurrence: storyId(n * 10 + chapter, 'dddd'), href: `/w/${storyId(n, 'cccc').slice(-36)}/read/${storyId(n * 10 + chapter, 'dddd').slice(-36)}` });

/** Every kind of post, in the anatomy the feed shares. */
export const everyKind: FeedItem[] = [
  post(1, { kind: 'contribution', score: 248, comments: { value: 41, kind: 'exact' },
    card: { kind: 'chapter', occurrence: storyId(12, 'dddd'), parent: storyId(1, 'eeee'), number: 212, title: '第二百一十二章 攻城', wordCount: 3280,
      excerpt: '城门在拂晓前被撞开。林渊握紧那封未寄出的信，逆着人潮走向钟楼——那里有人在等他，已经等了二十年。' },
    primaryAction: chapterAction(1, 2), group: { key: 'serial-day', count: 3, actors: [people.mei],
      range: { kind: 'chapters', from: 212, to: 214 } },
    target: { title: name('雨夜书店', 'zh-Hans'), language: 'zh-Hans', excerpt: null } }),
  post(2, { kind: 'contribution', realm: realms.fiction,
    // Main drops a hidden chapter's title and text; only its number remains.
    card: { kind: 'chapter', occurrence: storyId(23, 'dddd'), parent: storyId(2, 'eeee'), number: 58 },
    primaryAction: chapterAction(2, 3), target: { title: name('The Last Lantern'), excerpt: null },
    viewerState: { status: 'available', shelf: { id: storyId(2, 'ffff'), status: 'reading' },
      progress: { composition: storyId(2, 'eeee'), occurrence: storyId(21, 'dddd'), selectedRevision: 'urn:rezics:content:revision:2', completed: false,
        position: null }, spoiler: { policy: 'hide-unread', hidden: true } } }),
  post(3, { realm: realms.classics, actor: people.daniel, score: 1830, comments: { value: 64, kind: 'lower-bound' },
    authors: [openLibrary(3, 'George Eliot')],
    target: { title: name('Middlemarch: A Study of Provincial Life'),
      excerpt: 'A new annotated translation of George Eliot’s novel, with notes on the reform era and the provincial press.' } }),
  post(4, { kind: 'contribution', realm: realms.mods, actor: people.leo, card: { kind: 'release', version: '2.4.0', level: 'Minor',
    changelogExcerpt: 'Adds Ginger Island crops to the planner, fixes the greenhouse overlap, and supports SMAPI 4.1.' },
    primaryAction: { kind: 'install', work: storyId(4, 'cccc'), revision: 'urn:rezics:content:revision:4',
      href: `/w/${storyId(4, 'cccc').slice(-36)}`, compatibilityTargets: [] },
    target: { title: name('Crop Planner for Stardew Valley') } }),
  post(5, { realm: null, actor: people.aria, card: { kind: 'prompt',
    preview: 'You are a bilingual book club host. For the chapter below, ask three open questions in English and 中文, then…' },
    primaryAction: { kind: 'copy-prompt', work: storyId(5, 'cccc'), revision: 'urn:rezics:content:revision:5',
      href: `/w/${storyId(5, 'cccc').slice(-36)}` },
    target: { title: name('Bilingual book club discussion prompt') }, comments: { value: 0, kind: 'exact' } }),
  post(6, { realm: realms.kitchen, actor: people.mei, card: { kind: 'recipe', totalTime: '35 min', servings: 'Serves 4' },
    target: { title: name('韭菜鸡蛋饺子', 'zh-Hans'), language: 'zh-Hans', excerpt: '皮薄馅大，一次包好冷冻，随吃随煮。' } }),
  post(7, { kind: 'discussion', realm: realms.classics, actor: people.leo, primaryAction: { kind: 'open', href: '/w/x' },
    card: { kind: 'activity' }, target: { title: name('Pride and Prejudice'),
      excerpt: 'Is Mr. Bennet a good father? Chapter 2 makes me think he enjoys his family’s confusion more than he should.' } }),
  // A pick and the Work's own post on one page arrive as one card with both reasons.
  post(8, { kind: 'adoption', realm: realms.classics, actor: people.daniel, card: { kind: 'work' },
    authors: [openLibrary(8, 'Charlotte Brontë')],
    reasons: [{ kind: 'realm-pick', realm: realms.classics.id, curator: people.daniel.id },
      { kind: 'new-work', actor: people.mei.id }],
    target: { title: name('Jane Eyre'), excerpt: 'Now in Classic Literature’s Gothic shelf.' } }),
  post(9, { kind: 'collection', realm: null, actor: people.aria, card: { kind: 'activity' },
    primaryAction: { kind: 'open', href: '/collections/9' },
    target: { id: storyId(9, 'ffff'), work: null, title: name('Autumn reading: slow novels'), excerpt: null },
    links: { target: '/collections/9', actor: '/@aria_wang', comments: '/collections/9', vote: '/v1/feed/9/vote' } }),
  // An import is added to REZICS by someone who did not write it.
  post(12, { kind: 'added', realm: null, actor: people.mei, authors: [openLibrary(12, 'Lewis Carroll')],
    reasons: [{ kind: 'added-to-rezics', actor: people.mei.id }], target: { title: name('Alice’s Adventures in Wonderland'),
      excerpt: 'Alice follows a white rabbit down a hole and into a world that argues with her at every turn.' } }),
  post(13, { kind: 'work', realm: realms.fiction, actor: people.mei, authors: [onRezics(people.mei)],
    reasons: [{ kind: 'new-work', actor: people.mei.id }], target: { title: name('雨夜书店 · 番外', 'zh-Hans'),
      language: 'zh-Hans', excerpt: '雨停之后，书店的灯还亮着。' } }),
  review(10, { actor: people.leo, realm: null, title: name('Persuasion'), card: { rating: 4, scale: 5, spoiler: false,
    helpfulCount: 12, opening: 'Austen’s quietest novel and her most grown-up: Anne Elliot has already lost once, and the book '
      + 'lets her be right about it without ever saying so.' } }),
  // A Realm review uses its ten-point scale; one that discusses the plot keeps its opening back.
  review(11, { actor: people.aria, realm: realms.fiction, title: name('长夜将明', 'zh-Hans'), count: 3,
    card: { rating: 9, scale: 10, spoiler: true, helpfulCount: 0, opening: null } }),
];

/** A reader's review, linking to it on the Work page; `count` groups one person's reviews of several Works. */
function review(n: number, options: { actor: FeedItem['actor']; realm: FeedItem['realm']; title: FeedItem['target']['title'];
  count?: number; card: Omit<Extract<FeedItem['card'], { kind: 'review' }>, 'kind' | 'review'> }): FeedItem {
  const id = storyId(n, 'abcd').slice(-36);
  const href = `/w/${storyId(n, 'cccc').slice(-36)}#review-${id}`;
  return post(n, { kind: 'review', actor: options.actor, realm: options.realm,
    card: { kind: 'review', review: id, ...options.card }, primaryAction: { kind: 'read-review', review: id, href },
    group: { key: `review-${n}`, count: options.count ?? 1, actors: [options.actor] },
    target: { title: options.title, language: options.title.language },
    links: { target: href, actor: `/@${options.actor.handle}`, comments: `/w/${storyId(n, 'cccc').slice(-36)}/discussion`,
      vote: `/v1/feed/${storyId(n).slice(-36)}/vote` } });
}

/** A recommendation inside Following: the one place a reason is worth showing. */
export const suggestion = post(20, { reason: { kind: 'recommended', basis: 'thin-following' }, realm: realms.kitchen,
  target: { title: name('Weekend buttermilk pancakes') }, card: { kind: 'recipe' } });

export function page(items: FeedItem[], options: Partial<Pick<FeedPage, 'caughtUp' | 'nextCursor' | 'scope' | 'sort'>> = {}): FeedPage {
  return { profile: 'home-feed-v1', scope: options.scope ?? 'following', sort: options.sort ?? 'best', window: 'all',
    ranking: { version: 'home-best-v1', decayHours: 24, candidatePool: 256, normalization: 'realm-percentile-in-candidate-pool',
      signals: { upvote: 1, downvote: -1 }, diversityWindow: 10, realmCap: 3, thinFollowing: 3 },
    caughtUp: options.caughtUp ?? null, items, nextCursor: options.nextCursor ?? null,
    sourcePosition: { dataEpoch: 'story', sequence: '40' },
    count: { value: items.length, kind: 'exact-page', total: null },
    projection: { sequence: '40', reviewSequence: '7', status: 'current' } };
}

export interface MemoryFeed extends FeedApi { calls: string[] }

/**
 * An in-memory Main for the feed: later pages by cursor, votes that answer
 * with a receipt (or refuse), and follows and feedback that succeed unless
 * told to fail.
 */
export function memoryFeed(options: { pages?: Record<string, Loaded<FeedPage>>; head?: FeedHead;
  refuse?: ReadFailure; suggestions?: SuggestedFollow[] } = {}): MemoryFeed {
  const calls: string[] = [];
  const refused = <T>(): Loaded<T> => ({ ok: false, failure: options.refuse! });
  return {
    calls,
    async page(query: FeedQuery) {
      calls.push(`page:${query.cursor ?? ''}`);
      return options.pages?.[query.cursor ?? ''] ?? { ok: false, failure: 'unavailable' };
    },
    async vote(item, input) {
      calls.push(`vote:${item.slice(-4)}:${input.value}`);
      if (options.refuse) return refused<VoteReceipt>();
      const before = everyKind.concat(suggestion).find(candidate => candidate.id === item);
      return { ok: true, data: { value: input.value, score: (before?.score ?? 0) + input.value, revision: storyId(700) } };
    },
    async follow(target, _kind, following) {
      calls.push(`follow:${target.slice(-4)}:${following}`);
      return options.refuse ? refused() : { ok: true, data: { following } };
    },
    async batchFollow(targets) {
      calls.push(`batch:${targets.length}`);
      return options.refuse ? refused() : { ok: true, data: null };
    },
    async suggestions() {
      calls.push('suggestions');
      return { ok: true, data: options.suggestions ?? [] };
    },
    async feedback(input) {
      calls.push(`feedback:${input.kind}:${input.strength}`);
      return options.refuse ? refused() : { ok: true, data: null };
    },
    async hideContinue(work, hidden) {
      calls.push(`continue:${work.slice(-4)}:${hidden}`);
      return options.refuse ? refused() : { ok: true, data: null };
    },
    async head() {
      calls.push('head');
      return options.head ? { ok: true, data: options.head } : { ok: false, failure: 'missing' };
    },
    async watermark(scope) {
      calls.push(`watermark:${scope}`);
      return { ok: true, data: null };
    },
  };
}
