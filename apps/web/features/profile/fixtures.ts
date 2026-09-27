import type { FollowActions, FollowOutcome } from './follow-button.tsx';
import type { AgentProfile, AgentWorksPage, CreditedWork, FollowState, LibraryView, ShelfCard } from './types.ts';

// Story data shaped as Main answers it, and a follow adapter that keeps its
// state in memory, standing in for Main's follows (G-282).

export const storyId = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-7c1d-4e2f-9a3b-5c6d7e8f9a0b`;
const position = { dataEpoch: 'story', sequence: '42' };
const name = (value: string, language: string) => ({ value, language, direction: 'ltr' as const,
  basis: 'requested' as const });
const cover = (n: number) => ({ kind: 'fallback' as const, policy: 'avatar-fallback-v1', key: `work-${n}`,
  resourceType: 'work' });

export function storyProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  const id = overrides.id ?? storyId(1);
  const handle = overrides.handle ?? 'lin_mei';
  const path = `/v1/agents/${id.slice(-36)}`;
  return { profile: 'agent-read-v1', id, displayName: 'Lin Mei 林梅', kind: 'person',
    revision: `${storyId(900)}`, bio: { language: 'en', text: 'Lin Mei writes 雨夜书店 (The Rainy Night Bookshop), a '
      + 'serial about a bookshop that only opens when it rains, and translates English classics into Chinese. She '
      + 'also keeps a small shelf of family recipes, written down the way her grandmother told them: a handful of '
      + 'this, enough of that, and a pot that has seen forty winters. New chapters arrive on rainy weekends.' },
    avatarSelection: null, avatarUrl: null, handle, disclosure: 'public', sourcePosition: position,
    library: { visibility: 'public', statusShelvesVisible: true },
    links: { profile: `/@${handle}`, works: `${path}/works`, collections: `${path}/collections`,
      statusShelves: `${path}/shelves` },
    resolution: { requestedHandle: handle, state: 'current', redirect: false, canonical: `/@${handle}` },
    ...overrides };
}

function credited(n: number, title: string, language: string, types: string[],
  extra: Partial<CreditedWork> = {}): CreditedWork {
  return { id: storyId(100 + n), title: name(title, language), cover: cover(n), types, tagline: null,
    completionStatus: null, rating: null, attribution: [{ credit: storyId(300 + n), role: 'author' }], ...extra };
}

const book = ['https://schema.org/Book'];
const rating = (mean: number, count: number) => ({ context: storyId(500), count, sum: Math.round(mean * count), mean,
  scale: { min: 1 as const, max: 5 as const } });

export const authorWorks: AgentWorksPage = {
  items: [
    credited(1, '雨夜书店 · 连载小说', 'zh-Hans', book, { completionStatus: 'ongoing', rating: rating(4.4, 128),
      tagline: name('一封没有地址的信，把雨夜书店带向二十年前的秘密。', 'zh-Hans') }),
    credited(2, '傲慢与偏见 · 中文译读', 'zh-Hans', book, { rating: rating(4.1, 37), completionStatus: 'completed',
      attribution: [{ credit: storyId(402), role: 'translator' }],
      tagline: name('伊丽莎白与达西的故事，用今天的中文重新讲一遍。', 'zh-Hans') }),
    credited(3, 'Bilingual book club discussion prompt', 'en', ['https://schema.org/DigitalDocument'],
      { rating: rating(4.6, 12), tagline: name('One passage, two languages, a better conversation.', 'en') }),
    credited(4, '韭菜鸡蛋饺子', 'zh-Hans', ['https://schema.org/Recipe'], { rating: rating(4.8, 9) }),
    credited(5, 'Weekend buttermilk pancakes', 'en', ['https://schema.org/Recipe']),
  ],
  nextCursor: null, sourcePosition: position, count: { value: 5, kind: 'exact-page', total: null },
};

export const organizationWorks: AgentWorksPage = {
  items: ['Pride and Prejudice', 'Alice’s Adventures in Wonderland', 'Jane Eyre', 'Little Women']
    .map((title, index) => credited(20 + index, title, 'en', book, {
      attribution: [{ credit: storyId(420 + index), role: 'editor' }], rating: index % 2 ? null : rating(4.2, 60) })),
  nextCursor: 'story-next', sourcePosition: position, count: { value: 4, kind: 'exact-page', total: null },
};

export const noWorks: AgentWorksPage = { items: [], nextCursor: null, sourcePosition: position,
  count: { value: 0, kind: 'exact-page', total: null } };

const card = (n: number, title: string, language: string): ShelfCard =>
  ({ id: storyId(600 + n), title: name(title, language), cover: cover(600 + n) });

export const shelfCards = {
  reading: [card(1, '雨夜书店 · 连载小说', 'zh-Hans'), card(2, 'Alice’s Adventures in Wonderland', 'en')],
  read: [card(3, 'Pride and Prejudice', 'en'), card(4, '西游记', 'zh-Hans'), card(5, 'Little Women', 'en'),
    card(6, 'Frankenstein; or, The Modern Prometheus', 'en'), card(7, 'The Secret Garden', 'en'),
    card(8, '红楼梦', 'zh-Hans')],
  'want-to-read': [card(9, '聊斋志异', 'zh-Hans'), card(10, 'Jane Eyre', 'en')],
};

export function publicLibrary(own = false): LibraryView {
  return { kind: 'shelves', own, shelves: [
    { status: 'reading', count: 2, works: { ok: true, data: shelfCards.reading } },
    { status: 'read', count: 48, works: { ok: true, data: shelfCards.read } },
    { status: 'want-to-read', count: 2, works: { ok: true, data: shelfCards['want-to-read'] } },
  ] };
}

export function followState(followers: number, following: boolean | null = null,
  kind: 'exact' | 'lower-bound' = 'exact'): FollowState {
  return { profile: 'follow-state-v1', following, revision: following === null ? null : '0192e0aa-0000-7000-8000-000000000001',
    target: { id: storyId(1), kind: 'agent', name: name('Lin Mei 林梅', 'und'),
      icon: { kind: 'fallback', policy: 'avatar-fallback-v1', key: storyId(1), resourceType: 'agent' },
      realm: null, href: '/@lin_mei' },
    followers: { value: followers, kind } };
}

/** Follows over an in-memory state; `fail` refuses every write, `stale` makes the first write lose a race. */
export function memoryFollowActions(options: { fail?: boolean; stale?: boolean } = {}):
  Extract<FollowActions, { kind: 'ready' }> {
  let revision = 1;
  let following = false;
  let raced = !options.stale;
  return {
    kind: 'ready',
    async send(next): Promise<FollowOutcome> {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (options.fail) return { kind: 'failed' };
      if (!raced) { raced = true; return { kind: 'stale' }; }
      following = next;
      revision++;
      return { kind: 'saved', following, revision: `0192e0aa-0000-7000-8000-${String(revision).padStart(12, '0')}` };
    },
    async refresh() {
      return { following, revision: `0192e0aa-0000-7000-8000-${String(revision).padStart(12, '0')}` };
    },
  };
}
