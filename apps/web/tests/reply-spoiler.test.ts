import { expect, test } from 'bun:test';
import { mainThreadApi, replyProgress, type ReplyInput } from '../features/feed/thread-api.ts';

const input = (body: string, spoiler: boolean): ReplyInput => ({
  realm: 'realm', work: 'work', rootRevision: 'root',
  parent: { reply: 'parent', revisionId: 'seen' }, body, language: 'ja', spoiler, actingSubject: 'author',
});

function recording() {
  const calls: unknown[] = [];
  const main = {
    v1: {
      'member-reply-drafts': { post: async (body: unknown) => { calls.push(body); return { data: { revisionId: 'revision' } }; } },
      'realm-replies': { post: async (body: unknown) => { calls.push(body); return { data: { reply: 'reply' } }; } },
      'member-replies': () => ({ get: async () => ({ data: { revisionDigest: 'digest' } }) }),
      'realm-reply-placements': { post: async () => ({ data: { reply: 'reply', placement: 'placed' } }) },
    },
  };
  return { calls, api: mainThreadApi(() => main as never) };
}

test('a Japanese reply marked spoiler sends that declaration with the draft and the identity', async () => {
  const { calls, api } = recording();
  expect((await api.reply(input('最終章の手紙\n本文', true), replyProgress())).kind).toBe('placed');
  expect(calls[0]).toMatchObject({ spoiler: true, language: 'ja', body: '最終章の手紙\n本文' });
  expect(calls[1]).toMatchObject({ spoiler: true });
});

test('an unmarked reply titled Spoilers sends spoiler false and keeps the words', async () => {
  const { calls, api } = recording();
  const body = 'Spoilers: a review of spoiler culture\nThe title names the subject.';
  expect((await api.reply(input(body, false), replyProgress())).kind).toBe('placed');
  expect(calls[0]).toMatchObject({ spoiler: false, body });
  expect(calls[1]).toMatchObject({ spoiler: false });
});
