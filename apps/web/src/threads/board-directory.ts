import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';

type BoardResource = ReturnType<KernelClient['boards']>;
export type DirectoryBoard = NonNullable<Awaited<ReturnType<BoardResource['get']>>['data']>['board'];
export type BoardPurpose = DirectoryBoard['purpose'];
export type BoardDirectoryRequest = { purpose: BoardPurpose; cursor?: string; limit: number };
export type BoardDirectoryResult =
  | { state: 'ready'; boards: DirectoryBoard[]; next: string | null }
  | { state: 'unavailable' | 'denied' | 'closed' };
export type BoardDirectoryState = BoardDirectoryResult | { state: 'loading' };

/** One native GET /v1/boards page; implementations must not refill or read individual boards. */
export type BoardDirectoryAdapter = (request: BoardDirectoryRequest) => Promise<BoardDirectoryResult>;

export function boardDirectoryRequest(input: Record<string, unknown>): BoardDirectoryRequest {
  const purpose = input.purpose === 'reviews' ? 'reviews' : 'discussion';
  const cursor = typeof input.cursor === 'string' && input.cursor ? input.cursor : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Board page limit must be 1..100');
  return { purpose, ...(cursor ? { cursor } : {}), limit };
}

/** Replace this single default when the native directory client is delivered. Never simulate an empty directory. */
export const unavailableBoardDirectoryAdapter: BoardDirectoryAdapter = async () => ({ state: 'unavailable' });

export async function loadBoardDirectory(
  input: BoardDirectoryRequest,
  adapter: BoardDirectoryAdapter = unavailableBoardDirectoryAdapter,
): Promise<BoardDirectoryResult> {
  const request = boardDirectoryRequest(input);
  try {
    const result = await adapter(request);
    if (result.state !== 'ready') return result;
    // Native disclosure remains authoritative. Reject unexpected scope/purpose and unavailable rows defensively,
    // without fetching replacement candidates or leaking their names, identities or Context.
    if (
      result.boards.length > request.limit ||
      (result.next !== null && (result.next.length === 0 || result.next === request.cursor))
    )
      return { state: 'unavailable' };
    return {
      state: 'ready',
      boards: result.boards.filter(
        (board) =>
          board.realmId === null &&
          board.purpose === request.purpose &&
          board.availability === 'available' &&
          (board.visibility === 'published' || board.visibility === 'protected'),
      ),
      next: result.next,
    };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

export function boardDirectoryHref(request: BoardDirectoryRequest, locale: string): string {
  const query = new URLSearchParams({ purpose: request.purpose });
  if (request.cursor) query.set('cursor', request.cursor);
  return `/${locale}/boards?${query}`;
}

/** A single remembered predecessor, established only by following the native next cursor. */
export type BoardDirectoryPrevious = { request: BoardDirectoryRequest; target: string };
export function boardDirectoryPrevious(
  current: BoardDirectoryRequest,
  result: BoardDirectoryResult,
  destination: BoardDirectoryRequest,
): BoardDirectoryPrevious | undefined {
  return result.state === 'ready' &&
    result.next !== null &&
    result.next !== current.cursor &&
    current.purpose === destination.purpose &&
    result.next === destination.cursor
    ? { request: current, target: result.next }
    : undefined;
}
