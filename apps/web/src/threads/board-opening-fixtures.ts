import type { BoardPageResponse } from '@rezics/client';
import { fromPlainText } from '@rezics/document';

// Prepared consumer examples checked against the installed generated DTO, never native authority evidence.
export const boardOpeningId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const boardOpeningCursor = 'opaque+ordinary/next==';
export const boardOpeningNow = '2026-11-04T00:00:00.000Z';
const id = (value: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(value).padStart(12, '0')}`;
type Card = BoardPageResponse['threads'][number];

export function boardOpeningCard(index: number): Card {
  const threadId = id(100 + index);
  const authorId = id(40 + (index % 3));
  return {
    thread: {
      id: threadId,
      boardId: boardOpeningId,
      route: 0,
      kind: 'discussion',
      title: `Discussion ${index}`,
      authorId,
      licence: 'CC-BY-4.0',
      subjectIds: [],
      visibility: 'published',
      securityRevision: '1',
      availability: 'available',
      createdAt: boardOpeningNow,
      firstPost: {
        id: id(200 + index),
        threadId,
        boardId: boardOpeningId,
        route: 0,
        parentId: null,
        authorId,
        licence: 'CC-BY-4.0',
        subjectIds: [],
        visibility: 'published',
        securityRevision: '1',
        availability: 'available',
        createdAt: boardOpeningNow,
        revisedAt: null,
        revisionId: id(300 + index),
        sha256: 'a'.repeat(64),
        mediaIds: [],
        voteCitation: null,
        body: fromPlainText(`Opening contribution ${index}`, 'blocks'),
      },
    },
    target: { kind: 'thread', id: threadId, boardId: boardOpeningId },
    authors: {
      thread: {
        state: 'available',
        id: authorId,
        kind: 'actor',
        handle: `reader-${index % 3}`,
        displayName: null,
        automated: false,
      },
      openingPost: { state: 'unavailable' },
    },
    media: { state: 'none', images: [] },
    interaction: {
      target: { kind: 'thread', id: threadId },
      counts: { state: 'unavailable' },
      viewer: { state: 'not-applicable' },
    },
    comments: { state: 'unavailable' },
    actions: { reply: 'sign-in', react: 'sign-in', share: 'available' },
  };
}

export type BoardOpeningExample = 'current' | 'concealed' | 'interactions' | 'sparse' | 'denied';

export function boardOpeningExample(state: BoardOpeningExample = 'current', size = 25): BoardPageResponse {
  const cards = Array.from({ length: size }, (_, index) => boardOpeningCard(index));
  const page: BoardPageResponse = {
    board: {
      id: boardOpeningId,
      route: 0,
      title: 'Reading room',
      purpose: 'discussion',
      visibility: 'published',
      securityRevision: '1',
      availability: 'available',
      createdAt: boardOpeningNow,
      realmId: id(2),
      community: {
        realmId: id(2),
        spaceId: id(3),
        contextId: id(4),
        name: 'Readers',
        description: 'Read and discuss together.',
        avatar: { state: 'none', value: null },
        banner: { state: 'none', value: null },
        members: { state: 'current', count: 0, version: '1' },
        rules: {
          state: 'available',
          value: {
            postId: id(5),
            revisionId: id(6),
            body: fromPlainText('Mark spoilers. Respect other readers.', 'text'),
            licence: 'CC-BY-4.0',
            sha256: 'b'.repeat(64),
          },
        },
        join: { membership: 'nonmember', action: 'sign-in' },
      },
    },
    pinnedThreads: cards.slice(0, Math.min(5, size)),
    threads: cards.slice(5),
    next: boardOpeningCursor,
    rankRefreshedAt: boardOpeningNow,
    reactionsAsOf: null,
    pinRevision: '1',
    viewer: { participation: 'sign-in' },
    actions: { createThread: 'sign-in' },
  };
  if (state === 'concealed') {
    page.board = { ...page.board, community: null };
    for (const card of cards) {
      card.authors = { thread: { state: 'unavailable' }, openingPost: { state: 'unavailable' } };
      card.media = { state: 'unavailable', images: [] };
    }
    const hidden = page.pinnedThreads[0];
    if (hidden) {
      hidden.thread = { ...hidden.thread, availability: 'erased', title: null };
      page.threads.unshift(hidden);
    }
  }
  if (state === 'interactions') {
    const zero = cards[0];
    const lower = cards[1];
    if (zero) {
      zero.interaction.counts = {
        state: 'as-of',
        values: { upvote: 0, downvote: 0 },
        source: { epoch: 2, position: '12' },
      };
      zero.comments = {
        state: 'current',
        cohort: 'public',
        count: { kind: 'exact', value: 0 },
        lastActivityAt: null,
        source: { epoch: 2, position: '10' },
      };
    }
    if (lower)
      lower.comments = {
        state: 'current',
        cohort: 'public',
        count: { kind: 'lower-bound', value: 4 },
        lastActivityAt: boardOpeningNow,
        source: { epoch: 2, position: '11' },
      };
  }
  if (state === 'sparse') {
    page.pinnedThreads = [];
    page.threads = [];
  }
  if (state === 'denied') {
    page.viewer = { participation: 'denied' };
    page.actions = { createThread: 'denied' };
    if (page.board.community)
      page.board = {
        ...page.board,
        community: { ...page.board.community, join: { membership: 'unknown', action: null } },
      };
    for (const card of cards) card.actions = { reply: 'denied', react: 'denied', share: 'available' };
  }
  return page;
}
