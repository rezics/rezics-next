import { expect, expectTypeOf, test } from 'bun:test';
import { createKernelClient, type FeedPage, type KernelClient } from '../src/index.ts';

expectTypeOf<Awaited<ReturnType<KernelClient['feedItems']['get']>>['data']>().toEqualTypeOf<FeedPage | null>();

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

test('mounted DTOs preserve recorded context, immediate-parent disclosure and private reaction selection', async () => {
  const id = '00000000-0000-7000-8000-000000000001';
  const page: FeedPage = {
    feedItems: [
      {
        id: 'reply',
        source: 'following',
        occurredAt: null,
        key: { owner: 'content', kind: 'post', route: 0, id },
        summary: {
          id,
          threadId: id,
          title: null,
          createdAt: '2026-11-04T00:00:00Z',
          reviewContext: {
            target: { state: 'withheld' },
            citation: {
              state: 'available',
              question: {
                id,
                label: 'Public custom question',
                revision: 3,
                grain: 'work',
                scale: { min: -4, max: 8, displayStep: 2 },
              },
              units: 0,
              voteRevision: 7,
            },
          },
          parentContext: { kind: 'reply', parent: { state: 'removed', id } },
          reactionTarget: { targetKind: 'post', targetId: id },
          reactions: { upvote: 2, love: 1 },
          viewerReaction: null,
        },
        destination: { kind: 'post', id, threadId: id, postId: id, title: null },
      },
    ],
    next: 'same-cursor',
    asOf: '2026-11-04T00:00:00Z',
    reactionsAsOf: { epoch: 2, position: '9' },
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
  };
  const fetch = (async () => Response.json(page)) as typeof globalThis.fetch;
  const result = await createKernelClient('https://kernel.test', { fetch }).feedItems.get({
    query: { stream: 'following', cursor: 'same-cursor' },
  });
  expect(result.error).toBeNull();
  expect(result.data).toEqual(page);
});
