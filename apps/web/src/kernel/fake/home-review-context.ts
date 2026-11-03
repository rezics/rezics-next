import type { FeedContentItem, FeedPage } from '@rezics/client';

/** Prepared transport examples for the existing Home card; these do not establish native eligibility. */
export function homeReviewContextPage(parentState: 'available' | 'withheld' | 'removed' = 'available'): FeedPage {
  const id = (tail: number) => `00000000-0000-7000-8000-${String(tail).padStart(12, '0')}`;
  const review: FeedContentItem = {
    id: 'prepared-review',
    source: 'following',
    occurredAt: '2026-11-04T00:00:00Z',
    key: { owner: 'content', kind: 'thread', route: 0, id: id(1) },
    summary: {
      id: id(1),
      kind: 'review',
      title: 'Review of a permitted work',
      createdAt: '2026-11-03T00:00:00Z',
      author: { displayName: 'Morgan', handle: 'morgan', avatar: null },
      excerpt: 'A review with a recorded zero.',
      reviewContext: {
        target: {
          state: 'available',
          subject: { id: id(4), kind: 'schema:Book', label: { value: '現在の作品名', language: 'ja' } },
        },
        citation: {
          state: 'available',
          question: {
            id: id(5),
            revision: 11,
            label: 'A different public question',
            grain: 'work',
            scale: { min: -4, max: 8, displayStep: 2 },
          },
          units: 0,
          voteRevision: 7,
        },
      },
    },
    destination: { kind: 'thread', id: id(1), title: 'Review of a permitted work' },
  };
  const reply: FeedContentItem = {
    id: 'prepared-reply',
    source: 'following',
    occurredAt: '2026-11-04T01:00:00Z',
    key: { owner: 'content', kind: 'post', route: 0, id: id(2) },
    summary: {
      id: id(2),
      threadId: id(1),
      title: 'Review of a permitted work',
      createdAt: '2026-11-04T01:00:00Z',
      author: { displayName: 'Morgan', handle: 'morgan', avatar: null },
      excerpt: 'A reply to the immediate parent.',
      reviewContext: review.summary.reviewContext!,
      parentContext: {
        kind: 'reply',
        parent:
          parentState === 'available'
            ? {
                state: 'available',
                id: id(3),
                revisionId: id(6),
                createdAt: '2026-11-04T00:30:00Z',
                author: { id: id(7), displayName: 'Hana', handle: 'hana' },
                excerpt: '許された親の本文。',
                language: 'ja',
                spoiler: true,
              }
            : parentState === 'removed'
              ? { state: 'removed', id: id(3) }
              : { state: 'withheld' },
      },
    },
    destination: { kind: 'post', id: id(2), threadId: id(1), postId: id(2), title: 'Review of a permitted work' },
  };
  return {
    feedItems: [review, reply],
    next: null,
    asOf: '2026-11-04T02:00:00Z',
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
  };
}
