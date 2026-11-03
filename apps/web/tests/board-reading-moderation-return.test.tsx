import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { continuationBoardId, continuationCursor } from '../src/kernel/fake/board-continuation';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardCommunityStatus } from '../src/threads/board-community';
import { BoardFeed } from '../src/threads/board-feed';
import {
  authorsForCurrentReading,
  nativePinnedSection,
  ordinaryBoardThreads,
  type BoardFeedThread,
  type CommunityBoardPage,
} from '../src/threads/board-feed-data';
import {
  BOARD_AUTHOR_BATCH_LIMIT,
  BOARD_ORDINARY_PAGE_LIMIT,
  BOARD_PINNED_SECTION_LIMIT,
  authorBatchCount,
  boardProblemCode,
  boardReadingHref,
  captureBoardReadingReturn,
  disclosedBoardAuthorIds,
  isInvalidBoardCursor,
  isMalformedBoardQuery,
  parseBoardReadingReturn,
  projectBoardReading,
} from '../src/threads/board-reading';
import { BoardPinCommandCaller, parseBoardPinBoard } from '../src/threads/board-pins/contract';
import type { BoardPinCommand, BoardPinProducer, BoardPinSender } from '../src/threads/board-pins/contract';
import { boardSorts } from '../src/threads/board-sort';

const sender: BoardPinSender = { subject: 'moderator-subject', csrfToken: 'original-csrf' };
const boardId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';

async function render(
  page: CommunityBoardPage,
  extras: { pinProducer?: BoardPinProducer; pinSender?: BoardPinSender; cursor?: string; sort?: 'active' | 'hot' | 'new' } = {},
) {
  const root = createRootRoute({
    component: () =>
      createElement(BoardFeed, {
        boardId: page.board.id,
        sort: extras.sort ?? 'active',
        page: page.threads,
        authors: page.authors,
        now: '2026-11-01T00:00:00.000Z',
        ...(extras.cursor === undefined ? {} : { cursor: extras.cursor }),
        ...(extras.pinProducer ? { pinProducer: extras.pinProducer } : {}),
        ...(extras.pinSender ? { pinSender: extras.pinSender } : {}),
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

async function fixturePage(): Promise<CommunityBoardPage> {
  return loadBoardPageWithAuthors(
    createKernelClient('https://kernel.test', { fetch: createStoryRecordedKernelFetch() }),
    { id: continuationBoardId, cursor: continuationCursor },
  );
}

function asThread(
  source: BoardFeedThread,
  id: string,
  title: string,
  availability: BoardFeedThread['availability'] = 'available',
  authorId = source.authorId,
): BoardFeedThread {
  return { ...source, id, title, availability, authorId };
}

test('installed bounds are five pins, twenty ordinary rows and 100-author batches', () => {
  expect(BOARD_PINNED_SECTION_LIMIT).toBe(5);
  expect(BOARD_ORDINARY_PAGE_LIMIT).toBe(20);
  expect(BOARD_AUTHOR_BATCH_LIMIT).toBe(100);
  expect(authorBatchCount(Array.from({ length: 25 }, (_, index) => `a${index}`))).toBe(1);
});

test('zero and five pins, concealed identities and duplicate cohorts keep ordinary continuation honest', async () => {
  setLocale('en', { reload: false });
  const page = await fixturePage();
  const source = page.threads.threads[0]!;
  expect(nativePinnedSection([]).state).toBe('empty');
  expect(ordinaryBoardThreads({ ...page.threads, pinnedThreads: [], threads: [source] }).threads.map((row) => row.id)).toEqual([
    source.id,
  ]);
  const pins = [1, 2, 3, 4, 5].map((index) =>
    asThread(source, `01a17a3b-09b4-77bf-a24b-1234ebeab5d${index}`, `Pin ${index}`),
  );
  const hiddenAuthor = '01a17a3b-09b4-77bf-a24b-1234ebeab5e0';
  const hidden = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5d6', 'Hidden pin', 'erased', hiddenAuthor);
  const ordinary = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5d7', 'Ordinary');
  const supplied: CommunityBoardPage = {
    ...page,
    threads: {
      ...page.threads,
      pinnedThreads: [...pins, hidden],
      threads: [pins[0]!, ordinary, hidden],
      next: 'signed+board/next==',
    },
  };
  const section = nativePinnedSection(supplied.threads.pinnedThreads);
  expect(section.state).toBe('ready');
  if (section.state !== 'ready') throw new Error('Expected five disclosed pins.');
  expect(section.threads).toHaveLength(5);
  expect(ordinaryBoardThreads(supplied.threads).threads.map((row) => row.id)).toEqual([ordinary.id]);
  expect(
    disclosedBoardAuthorIds(supplied.threads.pinnedThreads, ordinaryBoardThreads(supplied.threads).threads),
  ).not.toContain(hiddenAuthor);
  const markup = await render(supplied);
  expect(markup).toContain('Pin 1');
  expect(markup).toContain('Ordinary');
  expect(markup).not.toContain('Hidden pin');
  expect(markup).toContain(m.threads_next_page());
  expect(nativePinnedSection([pins[0], pins[0]]).state).toBe('unavailable');
});

test('every installed sort keeps native ordinary order and a same-origin return without private fields', () => {
  for (const sort of boardSorts) {
    const captured = captureBoardReadingReturn({
      boardId,
      sort,
      locale: 'en',
      cursor: continuationCursor,
    });
    expect(captured).toMatchObject({ boardId, sort, locale: 'en', cursor: continuationCursor });
    const href = boardReadingHref(captured!);
    expect(href.startsWith('/en/boards/')).toBe(true);
    expect(href).not.toContain(sender.csrfToken);
    expect(href).not.toContain('Readable title');
    expect(parseBoardReadingReturn({ ...captured, title: 'secret' })).toMatchObject({ boardId, sort });
  }
  expect(parseBoardReadingReturn({ version: 1, boardId, sort: 'active', locale: 'en', cursor: 'x'.repeat(40_000) })).toBe(
    null,
  );
  expect(
    captureBoardReadingReturn({ boardId, sort: 'hot', locale: 'en', cursor: 'x'.repeat(40_000) })?.cursor,
  ).toBeUndefined();
});

test('invalid_cursor restarts; malformed queries stay distinct from denied reads', () => {
  expect(isInvalidBoardCursor(400, { code: 'invalid_cursor' })).toBe(true);
  expect(isInvalidBoardCursor(400, { value: { code: 'invalid_cursor' } })).toBe(true);
  expect(isMalformedBoardQuery(400, { code: 'invalid_request' })).toBe(true);
  expect(isMalformedBoardQuery(400, { code: 'invalid_cursor' })).toBe(false);
  expect(boardProblemCode({ error: { value: { code: 'invalid_cursor' } } })).toBe('invalid_cursor');
  expect(parseBoardPinBoard(boardId, { threads: [], pinnedThreads: [], next: null, rankRefreshedAt: null })).toMatchObject({
    state: 'ready',
    authors: null,
  });
  setLocale('en', { reload: false });
  const restart = renderToStaticMarkup(
    createElement(BoardCommunityStatus, { state: 'restart', restart: { boardId, sort: 'hot' } }),
  );
  expect(restart).toContain(m.board_reading_invalid_cursor());
  expect(restart).toContain(m.board_reading_restart());
  expect(restart).toContain(`sort=hot`);
  expect(restart).not.toContain('cursor=');
  const denied = renderToStaticMarkup(createElement(BoardCommunityStatus, { state: 'error' }));
  expect(denied).toContain(m.error_message());
  expect(denied).not.toContain(m.board_reading_restart());
});

test('pin/unpin on a continuation does not replay the stale cursor and unknown retries stay exact', async () => {
  const reads: { cursor?: string }[] = [];
  const commands: BoardPinCommand[] = [];
  const producer: BoardPinProducer = {
    readPage: async () => ({ state: 'unavailable' }),
    readBoard: async (query) => {
      reads.push({ ...(query.cursor === undefined ? {} : { cursor: query.cursor }) });
      return { state: 'restart' };
    },
    change: async (command) => {
      commands.push(command);
      return commands.length === 1
        ? { state: 'unknown' }
        : { state: 'applied', boardId: command.boardId, thread: { threadId: command.threadId, pinned: true, actions: ['unpin'] } };
    },
  };
  const caller = new BoardPinCommandCaller(
    producer,
    () => true,
    () => {},
    () => 'exact-pin-key',
  );
  await caller.start({ boardId, threadId: '01a17a3b-09b4-77bf-a24b-1234ebeab5b4', action: 'pin', sender });
  await caller.retry('01a17a3b-09b4-77bf-a24b-1234ebeab5b4');
  expect(commands[1]).toBe(commands[0]);
  expect(commands[1]?.key).toBe('exact-pin-key');
  const page = await fixturePage();
  const source = page.threads.threads[0]!;
  const markup = await render(
    {
      ...page,
      threads: { ...page.threads, pinnedThreads: [], threads: [source], next: continuationCursor },
    },
    { pinProducer: producer, pinSender: sender, cursor: continuationCursor, sort: 'hot' },
  );
  expect(markup).toContain(source.title);
  expect(reads.every((read) => read.cursor !== continuationCursor || reads.length === 0)).toBe(true);
});

test('a new disclosed author replaces leftover metadata; denied pin reads keep ordinary rows', async () => {
  setLocale('en', { reload: false });
  const page = await fixturePage();
  const source = page.threads.threads[0]!;
  const nextAuthor = '01a17a3b-09b4-77bf-a24b-1234ebeab5e1';
  const replacement = asThread(source, source.id, 'Replacement title', 'available', nextAuthor);
  const authors = authorsForCurrentReading(
    { [source.authorId]: page.authors![source.authorId]! },
    {
      [nextAuthor]: {
        id: nextAuthor,
        state: 'active',
        kind: 'actor',
        displayName: 'New author',
        handle: 'new-author',
      } as NonNullable<CommunityBoardPage['authors']>[string],
    },
    [nextAuthor],
  );
  expect(authors?.[source.authorId]).toBeUndefined();
  expect(authors?.[nextAuthor]?.displayName).toBe('New author');
  const markup = await render(page, {
    pinProducer: {
      readPage: async () => ({ state: 'denied' }),
      change: async () => ({ state: 'denied' }),
    },
  });
  expect(markup).toContain(source.title);
  expect(markup).not.toContain(m.board_pin_pin());
  const replaced: CommunityBoardPage = {
    ...page,
    threads: { ...page.threads, pinnedThreads: [], threads: [replacement] },
    authors: authors,
  };
  const nextMarkup = await render(replaced);
  expect(nextMarkup).toContain('New author');
  expect(nextMarkup).not.toContain(page.authors![source.authorId]?.displayName ?? 'no-name');
});

test('thread return is board/sort/continuation only; session replacement drops retry identity', () => {
  const reading = captureBoardReadingReturn({ boardId, sort: 'new', locale: 'de', cursor: 'opaque+frontier' });
  expect(boardReadingHref(reading!)).toBe(
    `/de/boards/${boardId}?sort=new&cursor=${encodeURIComponent('opaque+frontier')}`,
  );
  expect(parseBoardReadingReturn({ version: 1, boardId, sort: 'new', locale: 'de', csrf: sender.csrfToken })).toEqual({
    version: 1,
    boardId,
    sort: 'new',
    locale: 'de',
  });
  expect(parseBoardReadingReturn({ version: 1, boardId: 'other-board', sort: 'active', locale: 'en' })).toBe(null);
});

test('page projection stays O(P+L) at board populations 32, 256 and 2048', () => {
  const retained: number[] = [];
  const requests: number[] = [];
  for (const population of [32, 256, 2048]) {
    const pinned = Array.from({ length: 5 }, (_, index) => ({
      id: `p${index}`,
      availability: index === 4 ? 'erased' : 'available',
      authorId: `author-p${index}`,
    }));
    const ordinary = Array.from({ length: BOARD_ORDINARY_PAGE_LIMIT }, (_, index) => ({
      id: `o${index}`,
      availability: 'available' as const,
      authorId: `author-o${index}`,
    }));
    const first = projectBoardReading({
      pinnedThreads: pinned,
      threads: ordinary,
      next: population > BOARD_ORDINARY_PAGE_LIMIT ? 'cursor-1' : null,
    });
    const empty = projectBoardReading({ pinnedThreads: [], threads: [], next: null });
    const restarted = projectBoardReading({ pinnedThreads: pinned, threads: ordinary, next: null });
    expect(first.displayedPinnedIds).toHaveLength(4);
    expect(first.ordinaryIds).toHaveLength(BOARD_ORDINARY_PAGE_LIMIT);
    expect(first.authorIds.length).toBeLessThanOrEqual(BOARD_PINNED_SECTION_LIMIT + BOARD_ORDINARY_PAGE_LIMIT);
    expect(first.authorBatches).toBe(1);
    expect(empty.ordinaryIds).toEqual([]);
    expect(restarted.next).toBeNull();
    expect(first.bytes).toBe(restarted.bytes);
    retained.push(first.bytes);
    requests.push(1 + first.authorBatches);
    expect(first.pinnedIds.length + first.ordinaryIds.length).toBeLessThan(population);
  }
  expect(new Set(retained).size).toBe(1);
  expect(new Set(requests).size).toBe(1);
});
