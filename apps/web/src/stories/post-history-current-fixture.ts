import type { NativeHistoryPage } from '../threads/post-history-context';
import { id, selected, later } from './exact-revision/fixture';

/** Constructed generated-envelope examples; native authorization remains producer evidence. */
export function currentHistoryEnvelope(
  count = 1,
  kind: 'discussion' | 'reply' | 'review' = 'review',
): NativeHistoryPage {
  const revisions = Array.from({ length: count }, (_, index) => ({
    ...selected,
    revisionId: id(1000 + index),
    parentId: kind === 'reply' ? id(11) : null,
    voteCitation: kind === 'review' ? { ...selected.voteCitation!, units: 0 } : null,
  }));
  return {
    revisions,
    next: null,
    page: {
      viewer: { kind: 'anonymous' },
      conversation: {
        id: selected.threadId,
        kind: kind === 'review' ? 'review' : 'discussion',
        title: 'Admitted conversation',
        authorId: selected.authorId,
        boardId: selected.boardId,
        subjectIds: [...selected.subjectIds],
        createdAt: selected.createdAt,
      },
      board: {
        id: selected.boardId,
        realmId: null,
        community: null,
        route: 0,
        title: 'Admitted Board',
        purpose: kind === 'review' ? 'reviews' : 'discussion',
        visibility: 'published',
        securityRevision: '1',
        availability: 'available',
        createdAt: selected.createdAt,
      },
      place: { kind: 'global', id: id(99) },
      head: {
        postId: selected.id,
        revisionId: later.revisionId,
        state: 'current',
        authorId: selected.authorId,
        createdAt: later.createdAt,
        revisedAt: later.revisedAt,
      },
      authors: {
        state: 'current',
        retryable: false,
        items: [
          {
            id: selected.authorId,
            state: 'available',
            displayName: 'Current author presentation',
            handle: 'current-author',
            avatar: null,
          },
        ],
      },
      mentions: { state: 'current', retryable: false, items: [] },
      subjects: {
        state: 'current',
        retryable: false,
        limit: 4,
        items: [
          {
            id: selected.subjectIds[0]!,
            state: 'available',
            summary: {
              id: id(21),
              type: 'schema:Book',
              types: ['schema:Book'],
              label: { value: 'Merged terminal book', language: 'en' },
              creativeWork: true,
              cover: null,
            },
          },
        ],
      },
      reviewScores: {
        state: 'current',
        retryable: false,
        items:
          kind === 'review'
            ? revisions.map((revision) => ({
                revisionId: revision.revisionId,
                state: 'available',
                citation: revision.voteCitation!,
                question: {
                  id: revision.voteCitation!.questionId,
                  revision: 7,
                  label: 'Recorded rating question',
                  grain: 'work',
                  scale: { min: 0, max: 20, displayStep: 1 },
                  lifecycle: { state: 'retired', revision: 8 },
                },
              }))
            : [],
      },
      media: { state: 'current', retryable: false, items: [] },
      actions: { state: 'current', retryable: false, references: [] },
      navigation: {
        exact: revisions.map((revision) => ({ postId: revision.id, revisionId: revision.revisionId })),
        compareToHead: revisions.map((revision) => ({
          postId: revision.id,
          fromRevisionId: revision.revisionId,
          toRevisionId: later.revisionId,
        })),
      },
      currentness: {
        source: 'current',
        conversation: 'current',
        board: 'current',
        place: 'current',
        head: 'current',
        authors: 'current',
        mentions: 'current',
        subjects: 'current',
        reviewScores: 'current',
        media: 'current',
        actions: 'current',
      },
      retry: { state: 'none' },
    },
  };
}
