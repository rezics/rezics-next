import { expect, mock, test } from 'bun:test';
import {
  emptyInboxPagination,
  inboxPaginationFor,
  inboxTransportFailure,
  nextInboxPage,
  previousInboxPage,
  readableInboxPage,
  receiveInboxPage,
  restartInboxPage,
  selectInboxPage,
} from '../src/inbox/inbox-pagination';
import { readyInboxPage, type InboxPage, type ResolvedInboxPage } from '../src/inbox/inbox-read';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/inbox'),
  setResponseHeader: () => {},
}));

const secondCursor = 'opaque.signed+second/cursor==';
const thirdCursor = 'opaque.signed+third/cursor==';
const viewer = 'alice';
const item = (
  id: string,
  extra: Partial<ResolvedInboxPage['items'][number]> = {},
): ResolvedInboxPage['items'][number] => ({
  id,
  kind: 'reply',
  createdAt: '2026-10-29T10:00:00.000Z',
  actorId: 'actor-1',
  actorName: 'Momo',
  threadId: 'thread-1',
  postId: 'post-1',
  decisionId: null,
  reportId: null,
  unread: true,
  href: '/threads/thread-1#post-1',
  text: extra.text ?? 'A readable reply',
  unavailable: extra.unavailable ?? false,
  ...extra,
});
const ready = (
  items: ResolvedInboxPage['items'],
  next: string | null,
  selection: 'all' | 'unread' = 'all',
): InboxPage => readyInboxPage(items, next, viewer, selection);

test('A failed next inbox page leaves existing same-viewer notices readable with an exact cursor retry, native denial hides them, and a successful page replaces earlier rows', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([item('newest')], secondCursor));
  const loading = nextInboxPage(first);
  expect(loading.cursor).toBe(secondCursor);
  expect(readableInboxPage(loading)?.items).toEqual([item('newest')]);

  const failed = receiveInboxPage(loading, {
    signedIn: true,
    state: 'preparing',
    failure: { status: 503, code: 'dependency_unavailable', retryable: true, requestId: 'next-page' },
  });
  expect(readableInboxPage(failed)?.items[0]?.href).toBe('/threads/thread-1#post-1');
  expect(failed.result).toMatchObject({ failure: { requestId: 'next-page' } });
  expect(nextInboxPage(failed)).toBe(failed);
  expect(failed.cursor).toBe(secondCursor);
  const retried = receiveInboxPage(failed, ready([item('newest'), item('older')], thirdCursor));
  expect(readableInboxPage(retried)?.items.map(({ id }) => id)).toEqual(['newest', 'older']);
  const last = receiveInboxPage(nextInboxPage(retried), ready([item('older'), item('oldest')], null));
  expect(readableInboxPage(last)?.items.map(({ id }) => id)).toEqual(['older', 'oldest']);
  expect(last.earlier).toBeNull();
  expect(readableInboxPage(last)?.next).toBeNull();

  const denied = receiveInboxPage(last, {
    signedIn: true,
    state: 'unavailable',
    failure: { status: 403, code: 'forbidden' },
  });
  expect(readableInboxPage(denied)).toBeNull();
  expect(readableInboxPage(receiveInboxPage(denied, inboxTransportFailure))).toBeNull();
});

test('empty filtered pages retain the native continuation and require an explicit page request', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([], secondCursor));
  expect(readableInboxPage(first)).toMatchObject({ items: [], next: secondCursor });
  const empty = receiveInboxPage(nextInboxPage(first), ready([], thirdCursor));
  expect(empty.cursor).toBe(secondCursor);
  expect(readableInboxPage(empty)).toMatchObject({ items: [], next: thirdCursor });
  const requested = nextInboxPage(empty);
  expect(requested.cursor).toBe(thirdCursor);
  const last = receiveInboxPage(requested, ready([item('oldest')], null));
  expect(readableInboxPage(last)).toMatchObject({ items: [item('oldest')], next: null });
});

test('duplicate notice IDs keep first-seen order with latest details, and a successful page replaces the retained window', () => {
  const original = item('newest');
  const updated = item('newest', { text: 'Updated target', unread: false, unavailable: true });
  const first = receiveInboxPage(emptyInboxPagination, ready([original, updated, item('older')], secondCursor));
  expect(readableInboxPage(first)?.items).toEqual([updated, item('older')]);
  const loading = nextInboxPage(first);
  const second = receiveInboxPage(loading, ready([item('replacement')], thirdCursor));
  expect(readableInboxPage(second)?.items).toEqual([item('replacement')]);
  expect(second.earlier).toBeNull();
  expect(nextInboxPage(second).cursor).toBe(thirdCursor);
  const transportFailed = receiveInboxPage(second, second.result, true);
  expect(readableInboxPage(transportFailed)).toEqual(readableInboxPage(second));
  expect(transportFailed.cursor).toBe(secondCursor);
});

test('a selection change restarts without a cursor and ignores a page for a different selection', () => {
  const loaded = receiveInboxPage(emptyInboxPagination, ready([item('all-row')], secondCursor));
  const unread = selectInboxPage(loaded, 'unread');
  expect(unread).toEqual(inboxPaginationFor('unread', loaded.episode, loaded.readId + 1));
  expect(unread.cursor).toBeUndefined();
  expect(readableInboxPage(unread)).toBeNull();
  expect(selectInboxPage(unread, 'unread')).toBe(unread);
  const ignored = receiveInboxPage(unread, ready([item('all-row')], null, 'all'));
  expect(ignored).toBe(unread);
  const shown = receiveInboxPage(unread, ready([item('unread-row')], 'unread-next', 'unread'));
  expect(readableInboxPage(shown)?.items.map(({ id }) => id)).toEqual(['unread-row']);
  expect(shown.selection).toBe('unread');
});

test('signed-out, closed and non-transient native failures erase retained rows permanently until a fresh success', () => {
  const loaded = receiveInboxPage(emptyInboxPagination, ready([item('newest')], secondCursor));
  const failures: InboxPage[] = [
    { signedIn: false },
    { signedIn: true, state: 'closed', failure: { status: 503, code: 'platform_closed' } },
    { signedIn: true, state: 'unavailable', failure: { status: null, code: 'forbidden' } },
    ...[401, 403, 404, 410, 422].map((status): InboxPage => ({
      signedIn: true,
      state: 'unavailable',
      failure: { status, retryable: true },
    })),
    { signedIn: true, state: 'preparing', failure: { status: 503, retryable: false } },
  ];
  for (const failure of failures) {
    const cleared = receiveInboxPage(nextInboxPage(loaded), failure);
    expect(readableInboxPage(cleared)).toBeNull();
    expect(readableInboxPage(receiveInboxPage(nextInboxPage(loaded), failure, true))).toBeNull();
    expect(readableInboxPage(receiveInboxPage(cleared, undefined))).toBeNull();
    expect(readableInboxPage(receiveInboxPage(cleared, inboxTransportFailure))).toBeNull();
    expect(readableInboxPage(receiveInboxPage(cleared, ready([item('fresh')], null)))?.items).toEqual([item('fresh')]);
  }
});

test('Let an Inbox reader restart after a rejected continuation with original request/privacy/recovery bounds intact', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([item('original')], secondCursor));
  expect(restartInboxPage(emptyInboxPagination)).toBe(emptyInboxPagination);
  expect(restartInboxPage(first)).toBe(first);
  const continuation = nextInboxPage(first);
  expect(restartInboxPage(continuation)).toBe(continuation);
  for (const status of [400, 409, 410]) {
    const rejection: InboxPage = {
      signedIn: true,
      state: 'unavailable',
      failure: { status, requestId: 'rejected-cursor', retryAfter: '2' },
    };
    const failed = receiveInboxPage(continuation, rejection);
    expect(failed.cursor).toBe(secondCursor);
    expect(failed.result).toBe(rejection);
    expect(readableInboxPage(failed)).toBeNull();
    expect(nextInboxPage(failed)).toBe(failed);
    const exactRetry = receiveInboxPage(failed, { ...rejection });
    expect(exactRetry.cursor).toBe(secondCursor);
    expect(readableInboxPage(exactRetry)).toBeNull();
    const reset = restartInboxPage(exactRetry);
    expect(reset.cursor).toBeUndefined();
    expect(readableInboxPage(reset)).toBeNull();
    const fresh = receiveInboxPage(reset, ready([item('current-first')], thirdCursor));
    expect(readableInboxPage(fresh)).toMatchObject({ items: [item('current-first')], next: thirdCursor });
    expect(nextInboxPage(fresh).cursor).toBe(thirdCursor);
  }
});

test('a failed first-page restart cannot resurrect the abandoned chain, including after a transient continuation failure or native viewer denial', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([item('old-private-row')], secondCursor));
  const failed = receiveInboxPage(nextInboxPage(first), inboxTransportFailure);
  expect(readableInboxPage(failed)?.items).toEqual([item('old-private-row')]);
  const reset = restartInboxPage(failed);
  expect(readableInboxPage(reset)).toBeNull();
  for (const failure of [
    inboxTransportFailure,
    { signedIn: false },
    { signedIn: true, state: 'unavailable', failure: { status: 403, code: 'forbidden' } },
  ] satisfies InboxPage[]) {
    const resetFailed = receiveInboxPage(reset, failure);
    expect(resetFailed.cursor).toBeUndefined();
    expect(readableInboxPage(resetFailed)).toBeNull();
    expect(restartInboxPage(resetFailed)).toBe(resetFailed);
    expect(readableInboxPage(receiveInboxPage(resetFailed, inboxTransportFailure))).toBeNull();
    const recovered = receiveInboxPage(resetFailed, ready([item('new-private-row')], null));
    expect(readableInboxPage(recovered)?.items).toEqual([item('new-private-row')]);
  }
});

test('Previous re-admits exact paired addresses, caps history at eight, and clears it on restart or refusal', () => {
  const episode = 37;
  let current = receiveInboxPage(inboxPaginationFor('unread', episode), ready([item('page-0')], 'cursor-1', 'unread'));
  for (let index = 1; index <= 10; index += 1) {
    const requested = nextInboxPage(current);
    expect(requested.cursor).toBe(`cursor-${index}`);
    const rows = index === 5 ? [] : [item(`page-${index}`)];
    current = receiveInboxPage(
      requested,
      ready(rows, index === 10 ? null : `cursor-${index + 1}`, 'unread'),
    );
  }

  expect(current.history).toHaveLength(8);
  expect(current.history.map(({ cursor, selection, episode: addressEpisode }) => [cursor, selection, addressEpisode])).toEqual(
    Array.from({ length: 8 }, (_, index) => [`cursor-${index + 2}`, 'unread', episode]),
  );
  const previous = previousInboxPage(current);
  expect(previous.cursor).toBe('cursor-9');
  expect(previous.readId).toBe(current.readId + 1);
  expect(previous.direction).toBe('previous');
  expect(readableInboxPage(previous)?.items).toEqual([item('page-10')]);
  const admitted = receiveInboxPage(previous, ready([item('fresh-page-9')], null, 'unread'));
  expect(readableInboxPage(admitted)?.items).toEqual([item('fresh-page-9')]);
  expect(admitted.earlier).toBeNull();
  expect(admitted.history).toHaveLength(7);

  const restarted = restartInboxPage(admitted);
  expect(restarted.cursor).toBeUndefined();
  expect(restarted.history).toEqual([]);
  const denied = receiveInboxPage(previous, {
    signedIn: true,
    state: 'unavailable',
    failure: { status: 403, code: 'forbidden' },
  });
  expect(readableInboxPage(denied)).toBeNull();
  expect(denied.history).toEqual([]);

  const first = receiveInboxPage(inboxPaginationFor('all', episode), ready([item('first')], 'sparse-cursor'));
  const sparse = receiveInboxPage(nextInboxPage(first), ready([], 'sparse-next'));
  expect(readableInboxPage(sparse)?.items).toEqual([]);
  const sparsePrevious = previousInboxPage(sparse);
  expect(sparsePrevious.cursor).toBeUndefined();
  expect(sparsePrevious.direction).toBe('previous');
  expect(readableInboxPage(receiveInboxPage(sparsePrevious, ready([item('fresh-first')], null)))?.items).toEqual([
    item('fresh-first'),
  ]);
});
