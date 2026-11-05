import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type FeedContentItem, type FeedPage, type KernelClient } from '../src/index.ts';

expectTypeOf<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>().toEqualTypeOf<FeedPage | null>();
expectTypeOf<FeedContentItem['summary']>().toHaveProperty('reviewContext');
expectTypeOf<FeedPage['reactionsAsOf']>().not.toBeNever();

test('the exported mounted feed page preserves empty and retry continuations', async () => {
  for (const following of ['ready', 'unavailable'] as const) {
    const page: FeedPage = {
      feedItems: [],
      next: following === 'unavailable' ? 'original-frontier' : null,
      asOf: '2026-11-04T00:00:00Z',
      sources: { following, discovery: 'not_requested', continue: 'not_requested' },
    };
    const fetch = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://kernel.test/v1/feedItems?stream=following');
      return Response.json(page);
    }) as typeof globalThis.fetch;
    const result = await createKernelClient('https://kernel.test', { fetch }).feedItems.get({
      query: { stream: 'following' },
    });
    expect(result.error).toBeNull();
    expect(result.data).toEqual(page);
  }
});

test('the generated content response carries current review, parent and reaction witnesses', () => {
  const item: FeedContentItem = {
    id: 'activity-1',
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 12, id: '00000000-0000-7000-8000-000000000012' },
    occurredAt: null,
    summary: {
      id: '00000000-0000-7000-8000-000000000012',
      kind: 'review',
      title: 'Review',
      createdAt: '2026-11-04T00:00:00Z',
      reviewContext: {
        target: { state: 'absent' },
        citation: {
          state: 'available',
          question: {
            id: '00000000-0000-7000-8000-000000000013',
            revision: 3,
            label: 'How clear was it?',
            grain: 'work',
            scale: { min: 0, max: 20, displayStep: 1 },
          },
          units: 17,
          voteRevision: 4,
        },
      },
      reactionTarget: { targetKind: 'thread', targetId: '00000000-0000-7000-8000-000000000012' },
      reactions: { like: 2 },
      viewerReaction: null,
    },
    destination: { kind: 'thread', id: '00000000-0000-7000-8000-000000000012', title: 'Review' },
  };
  const reply: FeedContentItem = {
    id: 'activity-2',
    source: 'following',
    key: { owner: 'content', kind: 'post', route: 12, id: '00000000-0000-7000-8000-000000000014' },
    occurredAt: null,
    summary: {
      id: '00000000-0000-7000-8000-000000000014',
      threadId: '00000000-0000-7000-8000-000000000012',
      title: 'Review',
      createdAt: '2026-11-04T00:00:00Z',
      parentContext: {
        kind: 'reply',
        parent: {
          state: 'available',
          id: '00000000-0000-7000-8000-000000000015',
          revisionId: '00000000-0000-7000-8000-000000000016',
          createdAt: '2026-11-03T00:00:00Z',
          author: null,
          excerpt: 'Immediate parent only',
          language: 'en',
          spoiler: false,
        },
      },
    },
    destination: {
      kind: 'post',
      id: '00000000-0000-7000-8000-000000000014',
      threadId: '00000000-0000-7000-8000-000000000012',
      postId: '00000000-0000-7000-8000-000000000014',
      title: 'Review',
    },
  };
  const page: FeedPage = {
    feedItems: [item, reply],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    reactionsAsOf: null,
    sources: { discovery: 'not_requested', following: 'ready', continue: 'not_requested' },
  };
  expect(page.feedItems[0]).toEqual(item);
});
