import { expect, test } from 'bun:test';
import { feedReplyPost } from '../src/modules/feed/read.ts';
import { readProfileContributions } from '../src/modules/realm-reply/thread-read.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (suffix: number) => `https://rezics.com/id/00000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;

test('a Japanese reply marked spoiler carries the declaration, and a Spoilers title does not', () => {
  const marked = feedReplyPost('reply', '最終章の手紙\n本文はここです。', 'ja',
    { body: '最終章の手紙\n本文はここです。', spoiler: true });
  expect(marked.post).toMatchObject({ title: null, language: 'ja', spoiler: true });
  expect(marked.post.excerpt).toContain('本文はここです');

  const unmarked = feedReplyPost('discussion',
    'Spoilers: a review of spoiler culture\nThe title names the subject.', 'en',
    { body: 'Spoilers: a review of spoiler culture\nThe title names the subject.' });
  expect(unmarked.post.title).toBe('Spoilers: a review of spoiler culture');
  expect(unmarked.post.excerpt).toContain('The title names the subject');
  expect(unmarked.post).not.toHaveProperty('spoiler');

  const explicit = feedReplyPost('discussion',
    'Spoilers: a review of spoiler culture\nThe title names the subject.', 'en',
    { body: 'Spoilers: a review of spoiler culture\nThe title names the subject.', spoiler: false });
  expect(explicit.post.spoiler).toBe(false);
  expect(explicit.post.title).toBe('Spoilers: a review of spoiler culture');
});

test('a corrupt spoiler declaration fails the feed read instead of looking unmarked', () => {
  expect(() => feedReplyPost('reply', '本文', 'ja', { spoiler: 'yes' })).toThrow(WorkReadUnavailable);
});

test('profile contributions veil a marked Japanese reply and leave an unmarked Spoilers title open', async () => {
  const author = id(1), realm = id(2);
  const japanese = id(10), titled = id(11);
  let exactReads = 0;
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal: null, options: {}, deps: { content: { readExactBatch: async () => { exactReads++; return []; } },
      realmReplyThreads: { authorPage: async () => [
        { reply: japanese, parent: id(50), author, origin: realm, rootTarget: id(3), rootRevision: id(4),
          createdAt: new Date('2026-09-28T01:00:00Z') },
        { reply: titled, parent: null, author, origin: realm, rootTarget: id(3), rootRevision: id(4),
          createdAt: new Date('2026-09-28T00:00:00Z') },
      ] },
      realmReplies: { readPublic: async (reply: string) => reply === japanese
        ? { reply, author, originRealm: realm, body: '最終章の手紙\n本文はここです。', spoiler: true }
        : { reply, author, originRealm: realm,
          body: 'Spoilers: a review of spoiler culture\nThe title names the subject.' } },
      personPreferences: { profileVisible: async () => true } },
  } as unknown as WorkReadSession;
  const result = await readProfileContributions(session, author, 'posts', undefined, async () => ({} as never));
  expect(exactReads).toBe(0);
  expect(result.items.find(item => item.reply === japanese)).toMatchObject({
    title: null, spoiler: true, excerpt: expect.stringContaining('本文はここです') });
  const open = result.items.find(item => item.reply === titled)!;
  expect(open.title).toBe('Spoilers: a review of spoiler culture');
  expect(open.excerpt).toContain('The title names the subject');
  expect(open).not.toHaveProperty('spoiler');
});

test('a corrupt contribution declaration fails closed', async () => {
  const author = id(1);
  const session = { position: { datasetId: 'product', dataEpoch: 'epoch', sequence: '10' },
    principal: null, options: {}, deps: { content: {},
      realmReplyThreads: { authorPage: async () => [{ reply: id(10), parent: null, author, origin: id(2),
        rootTarget: id(3), rootRevision: id(4), createdAt: new Date('2026-09-28T00:00:00Z') }] },
      realmReplies: { readPublic: async (reply: string) => ({ reply, author, originRealm: id(2),
        body: '本文', spoiler: 'yes' }) },
      personPreferences: { profileVisible: async () => true } },
  } as unknown as WorkReadSession;
  await expect(readProfileContributions(session, author, 'comments', undefined, async () => ({} as never)))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});
