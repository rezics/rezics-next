import type { KernelClient } from '@rezics/client';
import { createServerOnlyFn } from '@tanstack/react-start';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';

type DirectoryPage = NonNullable<Awaited<ReturnType<KernelClient['boards']['get']>>['data']>;
export type DirectoryBoard = DirectoryPage['boards'][number];
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

/** The mounted native collection owns anonymous FINAL disclosure, even when credentials are supplied. */
export function createNativeBoardDirectoryAdapter(
  client: Pick<KernelClient, 'boards'>,
  options: { authorization?: string | null; signal?: AbortSignal } = {},
): BoardDirectoryAdapter {
  return async (request) => {
    options.signal?.throwIfAborted();
    const result = await client.boards.get({
      query: request,
      ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
      ...(options.signal ? { fetch: { signal: options.signal } } : {}),
    });
    options.signal?.throwIfAborted();
    if (result.error) {
      if (isPlatformClosedProblem(result.status, result.error.value)) return { state: 'closed' };
      return { state: result.status === 401 || result.status === 403 ? 'denied' : 'unavailable' };
    }
    return result.data
      ? { state: 'ready', boards: result.data.boards, next: result.data.next }
      : { state: 'unavailable' };
  };
}

/** Resolve the current BFF credential for every action; a session failure never retries anonymously. */
const currentBoardDirectoryAdapter = createServerOnlyFn(async (request: BoardDirectoryRequest) => {
  const [{ kernelClient }, { getRequest }, { env }, { prepareSession, viewerCredential }, { carriesSession }] =
    await Promise.all([
      import('../kernel/client'),
      import('@tanstack/react-start/server'),
      import('cloudflare:workers'),
      import('../session/request'),
      import('../session/csrf'),
    ]);
  const incoming = getRequest();
  if (await prepareSession(incoming, env as Partial<SessionEnv>)) return { state: 'denied' as const };
  const authorization = viewerCredential(incoming);
  if (carriesSession(incoming) && !authorization) return { state: 'unavailable' as const };
  return createNativeBoardDirectoryAdapter(kernelClient(), { authorization, signal: incoming.signal })(request);
});

export async function loadBoardDirectory(
  input: BoardDirectoryRequest,
  adapter: BoardDirectoryAdapter = currentBoardDirectoryAdapter,
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
          board.visibility === 'published',
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
