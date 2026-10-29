import { fromMarkdown } from '@rezics/document';
import type { FixtureAccount } from './fake';

const uuid = (kind: number, n: number) =>
  `0192f3a0-6c1e-7b2a-${kind.toString(16).padStart(4, '0')}-${n.toString(16).padStart(12, '0')}`;

/** A generated avatar summary: no real image, a colour and the variants the media route would serve. */
export function avatarSummary(n: number) {
  return {
    media: uuid(0xa001, n),
    width: 512,
    height: 512,
    placeholder: { thumbhash: '', color: '#46607a' },
    variants: [
      { format: 'avif', width: 160 },
      { format: 'webp', width: 160 },
      { format: 'avif', width: 320 },
      { format: 'webp', width: 320 },
    ],
    focalPoint: null,
    credit: null,
  };
}

const day = (n: number) => new Date(Date.UTC(2026, 5, 1 + (n % 28), 9, 30)).toISOString();
const document = (text: string) => fromMarkdown(text, 'text');

export function reviewRows(accountId: string, count: number, kind: 'review' | 'discussion' = 'review') {
  return Array.from({ length: count }, (_, n) => ({
    id: uuid(kind === 'review' ? 0xb001 : 0xb002, n + 1),
    kind,
    title: kind === 'review' ? `Review ${n + 1}: a quiet read` : `Thread ${n + 1}`,
    authorId: accountId,
    firstPost: {
      id: uuid(0xb101, n + 1),
      body: document(`Opening post ${n + 1}. It stays with you after the last page.`),
      createdAt: day(n),
    },
  }));
}

export function postRows(accountId: string, count: number) {
  return Array.from({ length: count }, (_, n) => ({
    id: uuid(0xc001, n + 1),
    authorId: accountId,
    threadId: uuid(0xb002, (n % 7) + 1),
    thread: { id: uuid(0xb002, (n % 7) + 1), title: n % 3 === 2 ? null : `Reading group, week ${(n % 7) + 1}` },
    body: document(`Reply ${n + 1}: I read it on the train and kept missing my stop.`),
    createdAt: day(n),
  }));
}

export function collectionRows(accountId: string, handle: string, count: number) {
  return Array.from({ length: count }, (_, n) => ({
    id: uuid(0xd001, n + 1),
    title: `Shelf ${n + 1}`,
    description: n % 2 === 0 ? 'Books I return to when the weather turns.' : null,
    memberCount: n + 3,
    updatedAt: day(n),
    curator: { id: accountId, handle, displayName: null },
  }));
}

export type AgentActivity = { reviews?: number; discussions?: number; posts?: number; collections?: number };

/** One account of the demo cast, with the activity its lists page through. */
export function agentAccount(
  base: Pick<FixtureAccount, 'id' | 'handle'> & Partial<FixtureAccount>,
  activity: AgentActivity = {},
): FixtureAccount {
  return {
    kind: 'actor',
    state: 'active',
    displayName: null,
    bio: null,
    links: [],
    avatar: null,
    subject: null,
    ...base,
    threads: [
      ...reviewRows(base.id, activity.reviews ?? 0, 'review'),
      ...reviewRows(base.id, activity.discussions ?? 0, 'discussion'),
    ],
    posts: postRows(base.id, activity.posts ?? 0),
    collections: collectionRows(base.id, base.handle, activity.collections ?? 0),
  };
}

/** The Person and Organization subjects the verified accounts of the demo cast are. */
export const demoAgentSubjects = [
  {
    id: uuid(0xe001, 1),
    type: 'schema:Person',
    labels: { en: 'Haruka Aizawa', ja: '相沢 春香' },
    descriptions: {
      en: 'Japanese novelist and translator',
      ja: '日本の小説家、翻訳者',
      'zh-Hans': '日本小说家与翻译家',
      'zh-Hant': '日本小說家與翻譯家',
    },
    aliases: {},
    statements: {},
  },
  {
    id: uuid(0xe001, 2),
    type: 'schema:Organization',
    labels: { en: 'Lantern Press' },
    descriptions: {
      en: 'Independent publisher of translated fiction',
      ja: '翻訳文学を刊行する独立系出版社',
      'zh-Hans': '独立出版商，专注翻译小说',
      'zh-Hant': '獨立出版商，專注翻譯小說',
    },
    aliases: {},
    statements: {},
  },
];

/**
 * The demo cast: an unverified reader with a little of everything, a novelist verified as a catalogue person, a
 * publisher verified as a catalogue organization who keeps reviews private, and a deleted account.
 */
export const demoAgentAccounts: FixtureAccount[] = [
  agentAccount(
    { id: uuid(0xf001, 1), handle: 'mira', displayName: 'Mira Okabe', bio: 'Reads on trains. Keeps lists.' },
    { reviews: 2, posts: 3, collections: 2 },
  ),
  agentAccount(
    {
      id: uuid(0xf001, 2),
      handle: 'haruka',
      displayName: 'Haruka Aizawa',
      bio: 'Novelist and translator. Posts about the work, not about me.',
      links: [{ label: 'Author site', url: 'https://example.com/haruka' }],
      avatar: avatarSummary(1),
      subject: demoAgentSubjects[0]!.id,
    },
    { reviews: 1, posts: 2, collections: 1 },
  ),
  agentAccount(
    {
      id: uuid(0xf001, 3),
      handle: 'lanternpress',
      kind: 'organization',
      displayName: 'Lantern Press',
      bio: 'Translated fiction, in small print runs.',
      links: [{ label: 'Catalogue', url: 'https://example.com/lantern' }],
      avatar: avatarSummary(2),
      subject: demoAgentSubjects[1]!.id,
      publicViews: { posts: true, reviews: false, collections: true },
    },
    { reviews: 2, posts: 2, collections: 3 },
  ),
  agentAccount({ id: uuid(0xf001, 4), handle: 'ghost', state: 'deleted', displayName: 'Ghost' }, { posts: 1 }),
];
