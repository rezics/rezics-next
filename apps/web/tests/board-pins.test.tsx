import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import {
  BoardPinPageStatus,
  BoardPinThreadControls,
} from '../src/threads/board-pins/controller';
import {
  BoardPinCommandCaller,
  joinBoardPinPage,
  type BoardPinCommand,
  type BoardPinProducer,
  type BoardPinRowStatus,
  type BoardPinSender,
} from '../src/threads/board-pins/contract';

const boardId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
const threadId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b4';
const sender: BoardPinSender = { subject: 'moderator-subject', csrfToken: 'original-csrf' };

test('pin page requires a complete identity match and keeps the producer state attached to native rows', () => {
  const state = joinBoardPinPage(boardId, ['second', 'first'], {
    state: 'ready',
    boardId,
    management: 'allowed',
    threads: [
      { threadId: 'first', pinned: true, actions: ['unpin'] },
      { threadId: 'second', pinned: false, actions: ['pin'] },
    ],
  });
  expect(state.state).toBe('ready');
  if (state.state !== 'ready') throw new Error('Expected a ready pin page.');
  expect(state.byThreadId.get('first')?.pinned).toBe(true);
  expect(state.byThreadId.get('second')?.actions).toEqual(['pin']);
  expect(joinBoardPinPage(boardId, ['first', 'second'], {
    state: 'ready',
    boardId: 'another-board',
    management: 'allowed',
    threads: [],
  })).toEqual({ state: 'unavailable' });
  expect(joinBoardPinPage(boardId, ['first'], {
    state: 'ready',
    boardId,
    management: 'allowed',
    threads: [],
  })).toEqual({ state: 'unavailable' });
});

test('unavailable pin reads expose a retry state without presenting a pin action', () => {
  const html = renderToStaticMarkup(
    createElement(BoardPinPageStatus, { state: { state: 'unavailable' }, onRetry: () => {} }),
  );
  expect(html).toContain(m.board_pin_unavailable());
  expect(html).toContain(m.board_community_retry());
  expect(html).not.toContain(m.board_pin_pin());
});

test('a conflict requires a current-state refresh before another pin command', () => {
  const html = renderToStaticMarkup(
    createElement(BoardPinThreadControls, {
      discussionTitle: 'A readable discussion',
      row: { threadId, pinned: false, actions: ['pin'] },
      management: 'allowed',
      sender,
      status: { state: 'conflict', action: 'pin' },
      onChange: () => {},
      onRetry: () => {},
      onRefresh: () => {},
    }),
  );
  expect(html).toContain(m.board_pin_conflict());
  expect(html).toContain(m.board_pin_refresh());
  expect(html).not.toContain(m.board_pin_pin());
  expect(html).not.toContain(threadId);
});

test('an unknown outcome retries the same sender, credential, key and operands', async () => {
  const calls: BoardPinCommand[] = [];
  const statuses: BoardPinRowStatus[] = [];
  const producer: BoardPinProducer = {
    readPage: async () => ({ state: 'unavailable' }),
    change: async (command) => {
      calls.push(command);
      return calls.length === 1
        ? { state: 'unknown' }
        : {
            state: 'applied',
            boardId,
            thread: { threadId, pinned: true, actions: ['unpin'] },
          };
    },
  };
  const caller = new BoardPinCommandCaller(
    producer,
    () => true,
    (_id, status) => statuses.push(status),
    () => 'fixed-pin-key',
  );
  const input = { boardId, threadId, action: 'pin' as const, sender };

  await caller.start(input);
  expect(statuses.at(-1)).toEqual({ state: 'unknown', action: 'pin' });
  await caller.retry(threadId);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe(calls[0]);
  expect(calls[1]).toMatchObject({ boardId, threadId, action: 'pin', sender, key: 'fixed-pin-key' });
  expect(statuses.at(-1)).toEqual({ state: 'applied', action: 'pin' });
  caller.retry(threadId);
  expect(calls).toHaveLength(2);
});

test('retiring a board visit hides late command results and drops its recovery', async () => {
  let finish!: (result: { state: 'unknown' }) => void;
  const pending = new Promise<{ state: 'unknown' }>((resolve) => {
    finish = resolve;
  });
  const calls: BoardPinCommand[] = [];
  const statuses: BoardPinRowStatus[] = [];
  const producer: BoardPinProducer = {
    readPage: async () => ({ state: 'unavailable' }),
    change: async (command) => {
      calls.push(command);
      return pending;
    },
  };
  const caller = new BoardPinCommandCaller(
    producer,
    () => true,
    (_id, status) => statuses.push(status),
    () => 'retired-key',
  );

  const work = caller.start({ boardId, threadId, action: 'pin', sender });
  caller.retire();
  finish({ state: 'unknown' });
  await work;
  caller.retry(threadId);
  expect(calls).toHaveLength(1);
  expect(statuses).toEqual([{ state: 'submitting', action: 'pin' }]);
});
