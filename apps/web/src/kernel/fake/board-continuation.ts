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
    path: /^\/v1\/boards\/([^/]+)(\/threads)?$/,
    story: ({ request, match }) => {
      const id = match?.[1];
      if (id !== continuationBoardId && id !== emptyBoardId) return undefined;
      if (!match?.[2]) return { ...board, board: { ...board.board, id } };
      const query = new URL(request.url).searchParams;
      const continued = id === continuationBoardId && query.get('cursor') === continuationCursor;
      return {
        ...threads,
        threads: continued
          ? threads.threads.map((thread) => ({
              ...thread,
              boardId: id,
              firstPost: { ...thread.firstPost, boardId: id },
            }))
          : [],
        next: !continued && id === continuationBoardId ? continuationCursor : null,
        rankRefreshedAt: continued && query.get('sort') !== null ? rankRefreshedAt : null,
      };
    },
  },
];
