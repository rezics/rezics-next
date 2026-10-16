import { expect } from 'bun:test';

/** An empty bounded window proves absence only after its continuation ends.
 * Keep every query control and the caller's existing preparation deadline. */
export async function readCatalogueTail<T extends { nextCursor: string | null }>(
  path: string, read: (path: string, page: number) => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, 'http://main.local');
  const cursors = new Set<string>();
  for (let page = 0; ; page++) {
    signal?.throwIfAborted();
    const result = await read(`${url.pathname}${url.search}`, page);
    if (!result.nextCursor) return result;
    expect(cursors.has(result.nextCursor), 'Catalogue continuation must advance').toBe(false);
    cursors.add(result.nextCursor);
    url.searchParams.set('cursor', result.nextCursor);
  }
}
