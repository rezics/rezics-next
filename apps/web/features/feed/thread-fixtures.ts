import { communityHref } from './discussion.ts';
import type { ReplyOutcome, ThreadApi } from './thread-api.ts';
import type { ThreadRead, ThreadReply, ThreadSummary } from './thread.ts';

// Story data: a Realm thread as `realm-thread-v1` returns it, a Realm's list
// as `realm-threads-v1` does, and a ThreadApi that answers from memory.

const id = (n: number, tag = '0000') => `https://rezics.com/id/${String(n).padStart(8, '0')}-${tag}-7a6f-8c2d-3e7b5c1a9f40`;
const name = (value: string, language = 'en') => ({ value, language, direction: 'ltr' as const, basis: 'requested' as const });

export const THREAD_NOW = Date.parse('2026-09-28T09:00:00.000Z');
const ago = (minutes: number) => new Date(THREAD_NOW - minutes * 60_000).toISOString();

const people = {
  priya: { id: id(801, 'bbbb'), name: 'Priya Raman', handle: 'priya_raman' },
  daniel: { id: id(802, 'bbbb'), name: 'Daniel Chen 陈丹尼', handle: 'daniel_chen' },
  nora: { id: id(803, 'bbbb'), name: 'Nora Lindqvist', handle: 'nora_lindqvist' },
  sophie: { id: id(804, 'bbbb'), name: 'Sophie Li 李素菲', handle: 'sophie_li' },
  hana: { id: id(805, 'bbbb'), name: 'Hana Sato 佐藤花', handle: 'hana_sato' },
  leo: { id: id(806, 'bbbb'), name: 'Leo Sun 孙乐', handle: 'leo_sun' },
  aria: { id: id(807, 'bbbb'), name: 'Aria Wang 王雅', handle: 'aria_wang' },
};

export const storyRealm = { id: id(950, 'aaaa'), name: 'English Classics Reading Circle',
  path: communityHref(id(950, 'aaaa')) };
const work = { id: id(960, 'cccc'), title: name('Pride and Prejudice'),
  cover: { kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: 'pride', resourceType: 'work' } };

/** The address of a story reply's own page. */
export const storyReply = (n: number) => id(n);

/** A discussion's first line is its title, as Main reads it; a reply is only its words. */
const titled = (text: string) => {
  const [title = '', ...rest] = text.split('\n');
  return { title, body: rest.join('\n') };
};

function reply(n: number, parent: number | null, author: keyof typeof people | null, minutes: number, text: string,
  vote: Partial<ThreadReply['vote']> = {}, language = 'en', spoiler?: boolean): ThreadReply {
  const { title, body } = parent === null ? titled(text) : { title: null, body: text };
  return { reply: id(n), placement: id(n, 'eeee'), parent: parent === null ? null : id(parent),
    author: author ? people[author] : null, time: ago(minutes), language,
    revisionId: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, title, body,
    ...(spoiler === undefined ? {} : { spoiler }),
    vote: { score: 0, value: 0, revision: null, open: true, ...vote } };
}

/**
 * A read-along thread, depth first in Best order: a conversation that runs
 * past the shown depth, a reply by someone whose profile is private, one
 * the community voted down, and a reply in Chinese whose vote is not open yet.
 */
const items: ThreadReply[] = [
  reply(1, null, 'priya', 180, 'October read-along: Pride and Prejudice, chapters 1–12\n'
    + 'Welcome to October’s read! This week covers chapters 1–12, through the Netherfield ball.\n\n'
    + 'Share one line that made you laugh, and one character you already distrust. Later chapters go in their '
    + 'own thread marked “Spoilers”.', { score: 14, value: 1, revision: '00000000-0000-4000-b000-000000000001' }),
  reply(2, 1, 'daniel', 170, 'I’d forgotten how funny the first chapter is. Mr. Bennet answering “You want to tell me, '
    + 'and I have no objection to hearing it” is pure deadpan.', { score: 9 }),
  reply(3, 2, 'priya', 160, 'Right? And the narrator is in on the joke with him from the very first sentence.', { score: 4 }),
  reply(4, 3, 'nora', 150, 'Which makes it sting later, when the joke turns out to cost his daughters something.',
    { score: 2 }),
  reply(5, 4, 'daniel', 140, 'Careful, that’s edging toward the spoiler thread!', { score: 1 }),
  reply(6, 5, 'sophie', 130, 'It’s set up in chapter 1 though. Fair game, I think.'),
  reply(7, 6, 'hana', 120, 'I agree. Reading slowly in English, I noticed the irony only on my second pass.'),
  reply(8, 7, 'leo', 110, 'Same here. The second pass is where Austen really opens up.'),
  reply(9, 1, 'aria', 100, 'Line that made me laugh: “She is tolerable; but not handsome enough to tempt me.” '
    + 'Character I distrust: Mr. Wickham, and he has barely arrived.', { score: 5 }),
  reply(10, 9, null, 90, 'Wickham is too charming to be true. Every compliment he pays sounds rehearsed.'),
  reply(11, 1, 'sophie', 60, '第一次读英文原版，比译本难，但句子的节奏更好笑。有没有推荐的注释版？', { score: 3, open: false },
    'zh-Hans'),
  reply(12, 1, 'leo', 30, 'Honestly this book is boring, just watch the movie.', { score: -6 }),
];

export const storyThread: ThreadRead = { profile: 'realm-thread-v1', realm: storyRealm.id, thread: id(1), focus: id(1),
  sort: 'best', work, rootRevision: id(970, 'dddd'), ancestors: [], items, complete: true,
  sourcePosition: { dataEpoch: 'story', sequence: '40' } };

/** One reply's own page: the branch under reply 4, with the discussion and its parents for context. */
export const storyBranch: ThreadRead = { ...storyThread, focus: id(4), ancestors: items.slice(0, 3),
  items: items.slice(3, 8) };

/** A discussion nobody has answered yet. */
export const storyQuietThread: ThreadRead = { ...storyThread, thread: id(20), focus: id(20),
  items: [reply(20, null, 'nora', 12, 'Frankenstein for Halloween?\nShould we read it in the last week of October, '
    + 'or save it for next year?')] };

/** A discussion the author marked as a spoiler. The title still says what they typed, including the word "Spoilers". */
export const storySpoilerThread: ThreadRead = { ...storyThread, thread: id(21), focus: id(21),
  items: [reply(21, null, 'sophie', 45, 'Spoilers (chapter 35): Darcy’s letter\nThe letter changes everything: '
    + 'Elizabeth rereads it until she has to admit she was wrong about Wickham.', { score: 8 }, 'en', true),
  reply(22, 21, 'daniel', 40, 'The rereading is the whole point. She changes her mind on the page.', {}, 'en', true)] };

/** A Japanese discussion marked as a spoiler. The warning is the localized label, not words in the title. */
export const storyJapaneseSpoiler: ThreadRead = { ...storyThread, thread: id(30), focus: id(30),
  items: [reply(30, null, 'hana', 20, '最終章の手紙\nエリザベスは手紙を読み返す。', { score: 3 }, 'ja', true)] };

/** A title that begins with "Spoilers" and is not marked. The body stays visible. */
export const storyUnmarkedTitle: ThreadRead = { ...storyThread, thread: id(31), focus: id(31),
  items: [reply(31, null, 'daniel', 15, 'Spoilers: a review of spoiler culture\nThe title names the subject. '
    + 'The post is not a spoiler.')] };

const summary = (n: number, author: keyof typeof people | null, minutes: number, excerpt: string, score: number,
  replies: number, title = work.title, spoiler?: boolean): ThreadSummary => ({ reply: id(n), placement: id(n, 'eeee'),
  work: { ...work, id: id(960 + n, 'cccc'), title }, author: author ? people[author] : null, time: ago(minutes),
  language: 'en', ...(({ title: heading, body }) => ({ title: heading, excerpt: body }))(titled(excerpt)),
  ...(spoiler === undefined ? {} : { spoiler }),
  vote: { score, value: 0, revision: null, open: true },
  replies: { value: replies, kind: 'exact' } });

/** A Realm's discussions as its list shows them. */
export const storyThreads: ThreadSummary[] = [
  summary(1, 'priya', 180, `${items[0]!.title}\n${items[0]!.body}`, 14, 11),
  summary(21, 'sophie', 45, `${storySpoilerThread.items[0]!.title}\n${storySpoilerThread.items[0]!.body}`, 8, 1, work.title, true),
  summary(31, 'daniel', 15, `${storyUnmarkedTitle.items[0]!.title}\n${storyUnmarkedTitle.items[0]!.body}`, 1, 0),
  summary(23, 'aria', 300, 'Which edition of Jane Eyre for a first read?\nPenguin, Oxford or the Norton critical '
    + 'edition? I want notes that explain without spoiling.', 5, 4, name('Jane Eyre')),
  summary(20, 'nora', 12, `${storyQuietThread.items[0]!.title}\n${storyQuietThread.items[0]!.body}`, 0, 0,
    name('Frankenstein')),
  summary(24, null, 2000, 'The Secret Garden as a comfort read\nSomething about Mary’s garden coming back to life '
    + 'every spring makes this my rainy-day book.', 3, 2, name('The Secret Garden')),
];

export interface MemoryThreads extends ThreadApi { calls: string[] }

/** An in-memory Main for replying: places a reply, refuses it, or fails once, as told. */
export function memoryThreads(outcome: ReplyOutcome['kind'] = 'placed'): MemoryThreads {
  const calls: string[] = [];
  return {
    calls,
    async reply(input, progress) {
      calls.push(`reply:${input.parent.reply.slice(-12)}:${input.body}`);
      if (outcome === 'placed') return { kind: 'placed', reply: progress.reply, placement: id(700, 'eeee') };
      if (outcome === 'refused') return { kind: 'refused' };
      return { kind: 'failed', progress: { ...progress, revisionId: '00000000-0000-4000-a000-000000000700' } };
    },
    async withdraw() { calls.push('withdraw'); },
  };
}
