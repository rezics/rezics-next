import { expect, test } from 'bun:test';
import { createKernelClient, type FeedContentItem, type FeedPage } from '../src/index.ts';

const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
const card = {
  id: 'native-activity', source: 'following', occurredAt: null,
  key: { owner: 'content', kind: 'thread', id, route: 0 },
  summary: {
    id, kind: 'review', title: 'Recorded assessment', createdAt: '2026-11-04T00:00:00Z',
    reactionTarget: { targetKind: 'thread', targetId: id }, reactions: { love: 1 }, viewerReaction: 'love',
  },
  destination: { kind: 'thread', id, title: 'Recorded assessment' },
} satisfies FeedContentItem;

test('mounted feed response exports preserve native selection, empty freshness and retry states', async () => {
  const page = (feedItems: FeedPage['feedItems'], extra: Partial<FeedPage>): FeedPage => ({
    feedItems, next: null, asOf: '2026-11-04T00:00:00Z',
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' }, ...extra,
  });
  const switched = { ...card, summary: { ...card.summary, viewerReaction: null } } satisfies FeedContentItem;
  const answers: FeedPage[] = [
    page([card], { reactionsAsOf: { epoch: 1, position: '42' } }),
    page([switched], { reactionsAsOf: null }),
    page([], { next: 'original-frontier', sources: { following: 'unavailable', discovery: 'not_requested', continue: 'not_requested' } }),
  ];
  const fetch = (async () => Response.json(answers.shift())) as typeof globalThis.fetch;
  const client = createKernelClient('https://kernel.test', { fetch });
  for (const expected of [...answers]) {
    const result = await client.feedItems.get({ query: { stream: 'following' } });
    const response: FeedPage | null = result.data;
    expect(result.error).toBeNull();
    expect(response).toEqual(expected);
  }
});
