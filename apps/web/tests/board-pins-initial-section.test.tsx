import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { KernelClient } from '@rezics/client';
import { createKernelClient } from '@rezics/client';
import { loadBoardPageWithAuthors } from '../src/identity/page-loaders';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { continuationBoardId, continuationCursor } from '../src/kernel/fake/board-continuation';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { BoardFeed } from '../src/threads/board-feed';
import {
  nativePinnedSection,
  ordinaryBoardThreads,
  type BoardFeedThread,
  type CommunityBoardPage,
} from '../src/threads/board-feed-data';
import { BOARD_PINNED_SECTION_LIMIT } from '../src/threads/board-pins/contract';
import { BoardPinThreadControls } from '../src/threads/board-pins/controller';
import {
  parseBoardPinCommandResult,
  type BoardPinProducer,
  type BoardPinSender,
} from '../src/threads/board-pins/contract';
import { nativeBoardThreadPin, nativeBoardThreads } from '../src/threads/board-pins/native';

const sender: BoardPinSender = { subject: 'moderator-subject', csrfToken: 'original-csrf' };

async function render(
  page: CommunityBoardPage,
  extras: { pinProducer?: BoardPinProducer; pinSender?: BoardPinSender } = {},
) {
  const root = createRootRoute({
    component: () =>
      createElement(BoardFeed, {
        boardId: page.board.id,
        sort: 'active',
        page: page.threads,
        authors: page.authors,
        now: '2026-11-01T00:00:00.000Z',
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
): BoardFeedThread {
  return { ...source, id, title, availability };
}

test('native pinned section keeps newest-first order, the five-row bound, and hides concealed pins', () => {
  const rows = [1, 2, 3, 4, 5, 6].map((index) => ({
    id: `01a17a3b-09b4-77bf-a24b-1234ebeab5b${index}`,
    availability: index === 2 ? 'erased' : 'available',
  }));
  const section = nativePinnedSection(rows);
  expect(section.state).toBe('ready');
  if (section.state !== 'ready') throw new Error('Expected a disclosed pinned section.');
  expect(section.threads.map((thread) => thread.id)).toEqual([
    rows[0]!.id,
    rows[2]!.id,
    rows[3]!.id,
    rows[4]!.id,
    rows[5]!.id,
  ]);
  expect(section.threads).toHaveLength(BOARD_PINNED_SECTION_LIMIT);
  expect(section.threads.some((thread) => thread.availability !== 'available')).toBe(false);
  const capped = nativePinnedSection(
    [0, 1, 2, 3, 4, 5].map((index) => ({ id: `n${index}`, availability: 'available' })),
  );
  expect(capped.state).toBe('ready');
  if (capped.state !== 'ready') throw new Error('Expected a bounded pinned section.');
  expect(capped.threads.map((thread) => thread.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  expect(nativePinnedSection([{ id: 'a' }, { id: 'a' }]).state).toBe('unavailable');
  expect(nativePinnedSection(undefined).state).toBe('empty');
});

test('ordinary continuation drops same-page pinned identities and keeps sparse next', async () => {
  setLocale('en', { reload: false });
  const page = await fixturePage();
  const source = page.threads.threads[0]!;
  const newest = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5c1', 'Newest pin');
  const older = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5c2', 'Older pin');
  const hidden = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5c3', 'Hidden pin', 'erased');
  const ordinary = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5c4', 'Ordinary discussion');
  const supplied: CommunityBoardPage = {
    ...page,
    threads: {
      ...page.threads,
      pinnedThreads: [newest, older, hidden],
      threads: [newest, ordinary],
      next: 'signed+board/next==',
    },
  };
  const continuation = ordinaryBoardThreads(supplied.threads);
  expect(continuation.threads.map((thread) => thread.id)).toEqual([ordinary.id]);
  expect(continuation.next).toBe('signed+board/next==');
  const markup = await render(supplied);
  const titles = [...markup.matchAll(/<h3\b[^>]*data-slot="board-feed-card"[^>]*>([\s\S]*?)<\/h3>/gu)].map(
    (match) => match[1],
  );
  expect(titles).toEqual(['Newest pin', 'Older pin', 'Ordinary discussion']);
  expect(markup).toContain(m.board_pin_section_heading());
  expect(markup).toContain(m.board_pin_badge());
  expect(markup).toContain(m.threads_next_page());
  expect(markup).not.toContain('Hidden pin');
  expect(markup).not.toContain(hidden.id);
  expect(markup.match(/<ul\b/gu)).toHaveLength(2);
});

test('empty ordinary continuation with remaining next stays sparse and does not claim the board is empty', async () => {
  setLocale('en', { reload: false });
  const page = await fixturePage();
  const source = page.threads.threads[0]!;
  const pinned = asThread(source, '01a17a3b-09b4-77bf-a24b-1234ebeab5c5', 'Only pin');
  const markup = await render({
    ...page,
    threads: { ...page.threads, pinnedThreads: [pinned], threads: [pinned], next: continuationCursor },
  });
  expect(markup).toContain('Only pin');
  expect(markup).toContain(m.threads_next_page());
  expect(markup).not.toContain(m.board_threads_empty());
  expect(markup).not.toContain(m.board_threads_page_empty());
});

test('pin confirmation names the discussion and does not leak credentials', () => {
  setLocale('en', { reload: false });
  const html = renderToStaticMarkup(
    createElement(Fragment, null, [
      createElement(BoardPinThreadControls, {
        key: 'controls',
        discussionTitle: 'Readable discussion',
        row: { threadId: '01a17a3b-09b4-77bf-a24b-1234ebeab5c6', pinned: false, actions: ['pin'] },
        management: 'allowed',
        sender,
        onChange: () => {},
        onRetry: () => {},
        onRefresh: () => {},
      }),
    ]),
  );
  expect(html).toContain(m.board_pin_pin());
  expect(html).not.toContain('original-csrf');
  expect(html).not.toContain('moderator-subject');
  expect(html).not.toContain('01a17a3b-09b4-77bf-a24b-1234ebeab5c6');
});

test('native pin methods stay unavailable when the generated board resource is absent', () => {
  const client = { boards: () => ({ get() {}, reports: {} }) } as unknown as KernelClient;
  const boardId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
  const threadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b4';
  expect(nativeBoardThreads(client, boardId)).toBeUndefined();
  expect(nativeBoardThreadPin(client, boardId, threadId)).toBeUndefined();
});

test('applied pin commands require the native identity and reject a sixth slot', () => {
  const command = {
    boardId: '01a17a3b-09b4-77bf-a24b-1234ebeab5b3',
    threadId: '01a17a3b-09b4-77bf-a24b-1234ebeab5b4',
    action: 'pin' as const,
  };
  expect(
    parseBoardPinCommandResult(
      200,
      { boardId: command.boardId, threadId: command.threadId, pinned: true, pinPosition: 1 },
      command,
    ),
  ).toMatchObject({ state: 'applied', thread: { pinned: true, actions: ['unpin'] } });
  expect(
    parseBoardPinCommandResult(
      200,
      { boardId: command.boardId, threadId: command.threadId, pinned: true, pinPosition: 6 },
      command,
    ),
  ).toEqual({ state: 'conflict' });
  expect(parseBoardPinCommandResult(409, {}, command)).toEqual({ state: 'conflict' });
  expect(parseBoardPinCommandResult(403, {}, command)).toEqual({ state: 'denied' });
});
