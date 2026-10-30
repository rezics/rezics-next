import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import recording from '../src/kernel/recorded/board.json';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import {
  boardDirectoryHref,
  boardDirectoryPrevious,
  boardDirectoryRequest,
  loadBoardDirectory,
  type BoardDirectoryRequest,
  type BoardDirectoryState,
  type DirectoryBoard,
} from '../src/threads/board-directory';
import { BoardDirectory } from '../src/threads/board-directory-view';

const board: DirectoryBoard = { ...recording.board, purpose: 'discussion', visibility: 'published', availability: 'available' };
function render(request: BoardDirectoryRequest, result: BoardDirectoryState) {
  return renderToString(createElement(BoardDirectory, { request, result, onRetry: () => {} }));
}

test('purpose and an exact returned cursor reach the real Global board in one bounded page per action', async () => {
  setLocale('en', { reload: false });
  const cursor = 'signed:next/+cursor=';
  for (const limit of [1, 20, 100]) {
    const calls: BoardDirectoryRequest[] = [];
    const adapter = async (request: BoardDirectoryRequest) => {
      calls.push(request);
      return { state: 'ready' as const, boards: request.cursor ? [board] : [], next: request.cursor ? null : cursor };
    };
    const reviews = boardDirectoryRequest({ purpose: 'reviews', cursor: 'old-purpose-cursor', limit });
    const choice = new URL(boardDirectoryHref(boardDirectoryRequest({ purpose: 'discussion', limit }), 'en'), 'https://site.test');
    expect(choice.searchParams.get('purpose')).toBe('discussion');
    expect(choice.searchParams.has('cursor')).toBe(false);
    const request = boardDirectoryRequest({ purpose: choice.searchParams.get('purpose'), limit });
    const sparse = await loadBoardDirectory(request, adapter);
    const html = render(request, sparse);
    expect(html).toContain(m.board_directory_sparse());
    expect(html).not.toContain(m.board_directory_empty());
    const href = [...html.matchAll(/href="([^"]+)"/gu)].map((match) => match[1]!.replaceAll('&amp;', '&'))
      .find((value) => new URL(value, 'https://site.test').searchParams.has('cursor'));
    expect(href).toBeDefined();
    const next = new URL(href!, 'https://site.test');
    expect(next.searchParams.get('cursor')).toBe(cursor);
    const destination = boardDirectoryRequest({ purpose: next.searchParams.get('purpose'), cursor: next.searchParams.get('cursor'), limit });
    const previous = boardDirectoryPrevious(request, sparse, destination);
    expect(previous).toEqual({ request, target: cursor });
    expect(boardDirectoryPrevious(reviews, sparse, destination)).toBeUndefined();
    const result = await loadBoardDirectory(destination, adapter);
    const visible = render(destination, result);
    expect(visible).toContain(`href="/en/boards/${board.id}"`);
    expect(visible).toContain(board.title!);
    expect(visible).toContain(m.board_directory_open());
    expect(visible).not.toContain(m.board_directory_next());
    expect(calls).toEqual([request, destination]);
  }
  expect(boardDirectoryRequest({}).limit).toBe(20);
  for (const limit of [0, 101, 1.5]) expect(() => boardDirectoryRequest({ limit })).toThrow();
});

test('unavailable, sparse and current refusal never become false empty or disclose hidden board metadata', async () => {
  setLocale('en', { reload: false });
  const request = boardDirectoryRequest({ purpose: 'discussion', cursor: 'keep-query' });
  const unavailable = await loadBoardDirectory(request);
  expect(unavailable).toEqual({ state: 'unavailable' });
  expect(render(request, unavailable)).toContain(m.board_directory_retry());
  expect(render(request, unavailable)).not.toContain(m.board_directory_empty());
  const hidden: DirectoryBoard[] = [
    { ...board, id: 'hidden-realm-id', realmId: 'removed-realm', title: 'Hidden Realm name' },
    { ...board, id: 'hidden-denied-id', visibility: 'taken_down', title: 'Hidden denied name' },
    { ...board, id: 'hidden-review-id', purpose: 'reviews', title: 'Hidden other-purpose name' },
    { ...board, id: 'hidden-erased-id', availability: 'erased', title: 'Hidden erased name' },
  ];
  const sparse = await loadBoardDirectory(request, async () => ({ state: 'ready', boards: hidden, next: 'continue' }));
  const html = render(request, sparse);
  expect(html).toContain(m.board_directory_sparse());
  expect(html).toContain(m.board_directory_next());
  expect(html).not.toContain(m.board_directory_empty());
  for (const item of hidden) {
    expect(html).not.toContain(item.id);
    expect(html).not.toContain(item.title!);
  }
  for (const state of ['denied', 'closed'] as const) {
    const refusal = await loadBoardDirectory(request, async () => ({ state }));
    expect(refusal).toEqual({ state });
    const refused = render(request, refusal);
    expect(refused).not.toContain(board.title!);
    expect(refused).not.toContain(m.board_directory_empty());
    expect(refused).not.toContain('href="/en/boards/' + board.id);
  }
  const failure = await loadBoardDirectory(request, async () => { throw new Error('Read uncertain'); });
  expect(failure).toEqual({ state: 'unavailable' });
  expect(request.cursor).toBe('keep-query');
  expect(await loadBoardDirectory(request, async () => { throw new PlatformClosedError(403, { code: 'platform_closed' }); })).toEqual({ state: 'closed' });
  expect(render(request, { state: 'ready', boards: [], next: null })).toContain(m.board_directory_empty());
  expect(render(request, { state: 'loading' })).toContain(m.board_directory_loading());
});
