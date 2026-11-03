import type { FakeRoute } from '../fake-modules';
import board from '../recorded/board.json';
import threads from '../recorded/board-threads.json';

export const continuationBoardId = '01a17a3b-09a4-7204-87d4-43219f9a15ae';
export const emptyBoardId = '01a17a3b-09a4-7204-87d4-43219f9a15af';
export const continuationCursor = 'signed+board/next==';
export const rankRefreshedAt = '2026-10-26T18:22:09.000Z';

// Isolated page states derived from the recorded board DTO. They do not prove native disclosure or cursor signing.
export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/boards\/([^/]+)(\/threads|\/page)?$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (id !== continuationBoardId && id !== emptyBoardId) return undefined;
      if (!match?.[2]) return { ...board, board: { ...board.board, id } };
      const query = new URL(request.url).searchParams;
      const continued = id === continuationBoardId && query.get('cursor') === continuationCursor;
      const pageThreads = continued
        ? threads.threads.map((thread) => ({
            ...thread,
            boardId: id,
            firstPost: { ...thread.firstPost, boardId: id },
          }))
        : [];
      if (match[2] === '/page') {
        const cards = pageThreads.map((thread) => ({
          thread,
          target: { kind: 'thread', id: thread.id, boardId: id },
          authors: {
            thread: { state: 'unavailable' },
            openingPost: { state: 'unavailable' },
          },
          media:
            Array.isArray(thread.firstPost.mediaIds) && thread.firstPost.mediaIds.length
              ? { state: 'unavailable', images: [] }
              : { state: 'none', images: [] },
          interaction: {
            target: { kind: 'thread', id: thread.id },
            counts: { state: 'unavailable' },
            viewer: { state: 'not-applicable' },
          },
          comments: { state: 'unavailable' },
          actions: {
            reply: request.headers.has('authorization') ? 'allowed' : 'sign-in',
            react: request.headers.has('authorization') ? 'allowed' : 'sign-in',
            share: 'available',
          },
        }));
        return {
          status: 200,
          board: { ...board.board, id },
          pinnedThreads: [],
          threads: cards,
          next: !continued && id === continuationBoardId ? continuationCursor : null,
          rankRefreshedAt: continued && query.get('sort') !== null ? rankRefreshedAt : null,
          reactionsAsOf: null,
          viewer: { participation: request.headers.has('authorization') ? 'allowed' : 'sign-in' },
          actions: { createThread: request.headers.has('authorization') ? 'allowed' : 'sign-in' },
        };
      }
      return {
        ...threads,
        threads: pageThreads,
        next: !continued && id === continuationBoardId ? continuationCursor : null,
        rankRefreshedAt: continued && query.get('sort') !== null ? rankRefreshedAt : null,
      };
    },
  },
];
