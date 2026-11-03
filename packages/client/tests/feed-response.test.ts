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

test('the generated feed response carries native review, parent, and reaction context', async () => {
  const id = '00000000-0000-7000-8000-000000000001';
  const threadId = '00000000-0000-7000-8000-000000000002';
  const parentId = '00000000-0000-7000-8000-000000000003';
  const page: FeedPage = {
    feedItems: [
      {
        id: 'following:post:one',
        source: 'following',
        occurredAt: null,
        key: { owner: 'content', kind: 'post', route: 1, id },
        summary: {
          id,
          threadId,
          title: 'A review',
          createdAt: '2026-11-04T00:00:00Z',
          reviewContext: {
            target: { state: 'available', subject: { id, kind: 'schema:Book', label: { value: 'Book', language: 'en' } } },
            citation: {
              state: 'available',
              question: {
                id: parentId,
                revision: 4,
                label: 'How suitable is this book?',
                grain: 'work',
                scale: { min: 0, max: 20, displayStep: 2 },
              },
              units: 14,
              voteRevision: 3,
            },
          },
          parentContext: {
            kind: 'reply',
            parent: {
              state: 'available',
              id: parentId,
              revisionId: threadId,
              createdAt: '2026-11-03T00:00:00Z',
              author: { id: threadId, displayName: 'Reader', handle: 'reader' },
              excerpt: 'A parent post.',
              language: 'en',
              spoiler: true,
            },
          },
          reactionTarget: { targetKind: 'post', targetId: id },
          reactions: { upvote: 2 },
          viewerReaction: 'upvote',
        },
        destination: { kind: 'post', id, postId: id, threadId, title: 'A review' },
      },
    ],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    reactionsAsOf: { epoch: 3, position: '8' },
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
  };
  const fetch = (async () => Response.json(page)) as typeof globalThis.fetch;
  const result = await createKernelClient('https://kernel.test', { fetch }).feedItems.get({
    query: { stream: 'following' },
  });
  expect(result.error).toBeNull();
  expect(result.data).toEqual(page);
});
