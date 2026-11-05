import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { openWorkbenchHistory, returnFromWorkbenchHistory, WorkbenchHistoryUnavailable } =
  await import('../src/moderation/workbench-history');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');

test('history keeps a board and queue cursor while preserving a separate opaque history cursor', () => {
  const queue = workbenchSearch({
    queue: 'appeals',
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    realm: 'realm/one',
    board: 'board/one',
    cursor: 'case.cursor:opaque',
    case: 'appeal94bb',
  });
  const opened = openWorkbenchHistory(queue);
  const history = workbenchSearch({ ...opened, historyCursor: 'native:cursor/opaque?x' });
  expect(history).toMatchObject({ board: 'board/one', queue: 'appeals', cursor: 'case.cursor:opaque', history: true });
  expect(history.case).toBe('appeal94bb');
  expect(history.historyCursor).toBe('native:cursor/opaque?x');

  const returned = returnFromWorkbenchHistory(history);
  expect(returned).toMatchObject({
    board: 'board/one',
    queue: 'appeals',
    cursor: 'case.cursor:opaque',
    historyReturn: true,
    case: 'appeal94bb',
  });
  expect(returned.history).toBeUndefined();
  expect(returned.historyCursor).toBeUndefined();
});

test('history is not admitted outside a selected board', () => {
  expect(workbenchSearch({ queue: 'reports', history: true, scope: 'catalogue' }).history).toBeUndefined();
  expect(workbenchSearch({ queue: 'reports', history: true }).history).toBeUndefined();
});

test('the missing native binding is explicit and offers retry and same-queue return', () => {
  const markup = renderToStaticMarkup(
    createElement(WorkbenchHistoryUnavailable, { onRetry: () => {}, onReturn: () => {} }),
  );
  expect(markup).toContain('role="alert"');
  expect(markup).toContain(m.moderation_workbench_history_unavailable());
  expect(markup).toContain(m.moderation_queue_retry());
  expect(markup).toContain(m.moderation_workbench_history_return());
});
