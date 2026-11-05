import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchQueuePage } from '../src/moderation/workbench-queue/window-history';
import type { WorkbenchSearch } from '../src/moderation/workbench-queue/scope';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { WorkbenchQueueWindowHistory, WORKBENCH_PRIOR_WINDOW_LIMIT, workbenchReaderFence } =
  await import('../src/moderation/workbench-queue/window-history');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { readWorkbenchPage } = await import('../src/moderation/workbench-queue/read');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');

const board = 'board-window';

function page(state: WorkbenchQueuePage['state'] = 'ready', next: string | null = null, revision = 4) {
  return {
    state,
    next,
    readerBinding: {
      id: 'binding-window',
      source: 'reader-window',
      revision,
      key: 'queue-window',
      placement: 'browser',
      expected: null,
      retired: false,
    },
    readerOrigin: { subject: 'moderator', csrfFingerprint: 'private' },
  } as unknown as WorkbenchQueuePage;
}

function queue(cursor?: string, extra: Record<string, unknown> = {}): WorkbenchSearch {
  return workbenchSearch({
    board,
    queue: 'reports',
    targetKind: 'post',
    order: 'oldest',
    ...(cursor ? { cursor } : {}),
    ...extra,
  });
}

function target(search: WorkbenchSearch) {
  return { pathname: '/moderation/workbench', search: search as unknown as Record<string, unknown> };
}

test('admitted native movement retains eight prior addresses and Refresh and First replace the current address', () => {
  const history = new WorkbenchQueueWindowHistory();
  let currentSearch = queue();
  let currentPage = page('ready', 'cursor-1');
  let visitId = 'visit-0';
  history.admitQueue({ visitId, page: currentPage, search: currentSearch, locale: 'en', admitted: true });

  for (let index = 1; index <= WORKBENCH_PRIOR_WINDOW_LIMIT + 2; index++) {
    const cursor = currentPage.next!;
    const nextSearch = queue(cursor);
    expect(
      history.beginMove({
        visitId,
        search: currentSearch,
        fence: workbenchReaderFence(currentPage, 'en'),
        move: 'next',
        keyboard: false,
      }),
    ).toBe(true);
    expect(history.navigate(visitId, target(nextSearch), currentSearch, currentPage)).toBe(true);
    visitId = `visit-${index}`;
    currentSearch = nextSearch;
    currentPage = page('ready', `cursor-${index + 1}`);
    history.admitQueue({ visitId, page: currentPage, search: currentSearch, locale: 'en', admitted: true });
  }

  expect(history.view(visitId, currentSearch, 'ready')).toMatchObject({ previous: true, refresh: true, first: true });
  expect(history.previousAddress(visitId, currentSearch)).toBe('cursor-9');
  expect(
    history.beginMove({
      visitId,
      search: currentSearch,
      fence: workbenchReaderFence(currentPage, 'en'),
      move: 'refresh',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate(visitId, target(currentSearch), currentSearch, currentPage)).toBe(true);
  visitId = 'refresh-later-window';
  currentPage = page('ready', 'cursor-11');
  history.admitQueue({ visitId, page: currentPage, search: currentSearch, locale: 'en', admitted: true });
  expect(history.previousAddress(visitId, currentSearch)).toBe('cursor-9');

  for (let index = 0; index < WORKBENCH_PRIOR_WINDOW_LIMIT; index++) {
    const previous = history.previousAddress(visitId, currentSearch);
    expect(previous).toBeDefined();
    const previousSearch = queue(previous ?? undefined);
    expect(
      history.beginMove({
        visitId,
        search: currentSearch,
        fence: workbenchReaderFence(currentPage, 'en'),
        move: 'previous',
        keyboard: false,
      }),
    ).toBe(true);
    expect(history.navigate(visitId, target(previousSearch), currentSearch, currentPage)).toBe(true);
    visitId = `previous-${index}`;
    currentSearch = previousSearch;
    currentPage = page();
    history.admitQueue({ visitId, page: currentPage, search: currentSearch, locale: 'en', admitted: true });
  }
  expect(currentSearch.cursor).toBe('cursor-2');
  expect(history.previousAddress(visitId, currentSearch)).toBeUndefined();

  expect(
    history.beginMove({
      visitId,
      search: currentSearch,
      fence: workbenchReaderFence(page(), 'en'),
      move: 'first',
      keyboard: false,
    }),
  ).toBe(true);
  const first = queue();
  expect(history.navigate(visitId, target(first), currentSearch, page())).toBe(true);
  visitId = 'first-admitted';
  currentSearch = first;
  history.admitQueue({ visitId, page: page('ready', 'cursor-1'), search: first, locale: 'en', admitted: true });
  expect(history.view(visitId, first, 'ready')).toMatchObject({ previous: false, refresh: true, first: false });
});

test('failed Next keeps its cursor and exact Retry direction; sparse admitted pages still continue', () => {
  const history = new WorkbenchQueueWindowHistory();
  const first = queue();
  const firstPage = page('ready', 'cursor-1');
  history.admitQueue({ visitId: 'visit-0', page: firstPage, search: first, locale: 'en', admitted: true });
  const requested = queue('cursor-1');
  expect(
    history.beginMove({
      visitId: 'visit-0',
      search: first,
      fence: workbenchReaderFence(firstPage, 'en'),
      move: 'next',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate('visit-0', target(requested), first, firstPage)).toBe(true);
  const failed = page('unavailable', null);
  history.admitQueue({ visitId: 'visit-1', page: failed, search: requested, locale: 'en', admitted: true });
  expect(history.view('visit-1', requested, 'unavailable').retry).toBe('next');
  expect(
    history.beginRetry({
      visitId: 'visit-1',
      search: requested,
      fence: workbenchReaderFence(failed, 'en'),
      keyboard: false,
    }),
  ).toBe(true);

  const admitted = page('ready', 'cursor-2');
  history.admitQueue({ visitId: 'visit-1', page: admitted, search: requested, locale: 'en', admitted: true });
  expect(history.previousAddress('visit-1', requested)).toBeNull();
  expect(
    history.beginMove({
      visitId: 'visit-1',
      search: requested,
      fence: workbenchReaderFence(admitted, 'en'),
      move: 'next',
      keyboard: false,
    }),
  ).toBe(true);
  const sparseNext = queue('cursor-2');
  expect(history.navigate('visit-1', target(sparseNext), requested, admitted)).toBe(true);
  history.admitQueue({ visitId: 'visit-2', page: page(), search: sparseNext, locale: 'en', admitted: true });
  expect(history.view('visit-2', sparseNext, 'ready').previous).toBe(true);

  const previous = queue('cursor-1');
  expect(
    history.beginMove({
      visitId: 'visit-2',
      search: sparseNext,
      fence: workbenchReaderFence(page(), 'en'),
      move: 'previous',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate('visit-2', target(previous), sparseNext, page())).toBe(true);
  const failedPrevious = page('unavailable');
  history.admitQueue({ visitId: 'visit-3', page: failedPrevious, search: previous, locale: 'en', admitted: true });
  expect(history.view('visit-3', previous, 'unavailable').retry).toBe('previous');
  expect(
    history.beginRetry({
      visitId: 'visit-3',
      search: previous,
      fence: workbenchReaderFence(failedPrevious, 'en'),
      keyboard: false,
    }),
  ).toBe(true);
  history.admitQueue({ visitId: 'visit-3', page: page(), search: previous, locale: 'en', admitted: true });
  expect(history.previousAddress('visit-3', previous)).toBeNull();
});

test('direct canonical deep links have no invented predecessors and a changed reader fence retires them', () => {
  const history = new WorkbenchQueueWindowHistory();
  const direct = queue('canonical-cursor');
  const directPage = page('ready', 'next-cursor');
  history.admitQueue({ visitId: 'direct', page: directPage, search: direct, locale: 'en', admitted: true });
  expect(history.view('direct', direct, 'ready')).toMatchObject({ previous: false, refresh: true, first: true });

  const first = queue();
  expect(
    history.beginMove({
      visitId: 'direct',
      search: direct,
      fence: workbenchReaderFence(directPage, 'en'),
      move: 'first',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate('direct', target(first), direct, directPage)).toBe(true);
  const firstPage = page('ready', 'cursor-1');
  history.admitQueue({ visitId: 'first-visit', page: firstPage, search: first, locale: 'en', admitted: true });
  const second = queue('cursor-1');
  expect(
    history.beginMove({
      visitId: 'first-visit',
      search: first,
      fence: workbenchReaderFence(firstPage, 'en'),
      move: 'next',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate('first-visit', target(second), first, firstPage)).toBe(true);
  const secondPage = page('ready', null);
  history.admitQueue({ visitId: 'second-visit', page: secondPage, search: second, locale: 'en', admitted: true });
  expect(history.previousAddress('second-visit', second)).toBeNull();

  const changedReader = page('ready', null, 5);
  history.admitQueue({ visitId: 'second-visit', page: changedReader, search: second, locale: 'en', admitted: true });
  expect(history.previousAddress('second-visit', second)).toBeUndefined();

  const expired = page('stale', null, 5);
  history.admitQueue({ visitId: 'second-visit', page: expired, search: second, locale: 'en', admitted: true });
  expect(history.view('second-visit', second, 'stale').first).toBe(true);
  const restarted = queue();
  expect(
    history.beginMove({
      visitId: 'second-visit',
      search: second,
      fence: workbenchReaderFence(expired, 'en'),
      move: 'first',
      keyboard: false,
    }),
  ).toBe(true);
  expect(history.navigate('second-visit', target(restarted), second, expired)).toBe(true);
  history.admitQueue({
    visitId: 'recovered',
    page: page('ready', 'cursor-1', 5),
    search: restarted,
    locale: 'en',
    admitted: true,
  });
  expect(history.view('recovered', restarted, 'ready')).toMatchObject({ previous: false, first: false });
});

test('an oversized native continuation cannot become a queue address', async () => {
  const client = {
    boards: () => ({
      reports: {
        get: async () => ({ data: { reports: [], next: 'x'.repeat(4097) } }),
      },
    }),
  };
  const result = await readWorkbenchPage(client as never, queue(), 'credential-is-not-retained', {
    subject: 'moderator',
    csrfFingerprint: 'private',
  });
  expect(result.state).toBe('unavailable');
  expect(result.next).toBeNull();
});

test('Board reports and resolved views expose native Next, Previous, same-window Refresh and First controls', () => {
  for (const queueKind of ['reports', 'resolved'] as const) {
    const search = workbenchSearch({ board, queue: queueKind, targetKind: 'post', order: 'newest' });
    const markup = renderToStaticMarkup(
      createElement(WorkbenchView, {
        page: {
          state: 'ready',
          search,
          realms: [],
          realmsNext: null,
          boards: [],
          boardsNext: null,
          cases: [],
          next: 'native-next-cursor',
        },
        onSearch: () => {},
        onRefresh: async () => {},
        onWindowMove: () => {},
        queueWindow: { previous: true, refresh: true, first: true },
      }),
    );
    expect(markup).toContain('Previous');
    expect(markup).toContain('Next page');
    expect(markup).toContain('Refresh current window');
    expect(markup).toContain('First');
  }
});
