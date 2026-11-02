import { expect, test } from 'bun:test';
import {
  emptyInboxPagination,
  inboxTransportFailure,
  nextInboxPage,
  readableInboxPage,
  receiveInboxPage,
  restartInboxPage,
} from '../src/inbox/inbox-pagination';
import type { InboxPage, ResolvedInboxPage } from '../src/inbox/inbox-read';

const secondCursor = 'opaque.signed+second/cursor==';
const thirdCursor = 'opaque.signed+third/cursor==';
const item = (id: string): ResolvedInboxPage['items'][number] => ({
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
  text: 'A readable reply',
  unavailable: false,
});
const ready = (items: ResolvedInboxPage['items'], next: string | null): InboxPage => ({
  signedIn: true,
  state: 'ready',
  items,
  next,
});

test('A failed next inbox page leaves existing same-viewer notices readable with an exact cursor retry, native denial hides them, and repeated pages cannot duplicate or skip notices', () => {
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
  // Load more cannot advance on failure; refetch addresses the original cursor, without interpreting it.
  expect(nextInboxPage(failed)).toBe(failed);
  expect(failed.cursor).toBe(secondCursor);
  const retried = receiveInboxPage(failed, ready([item('newest'), item('older')], thirdCursor));
  expect(readableInboxPage(retried)?.items.map(({ id }) => id)).toEqual(['newest', 'older']);
  const last = receiveInboxPage(nextInboxPage(retried), ready([item('older'), item('oldest')], null));
  expect(readableInboxPage(last)?.items.map(({ id }) => id)).toEqual(['newest', 'older', 'oldest']);
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
  expect(readableInboxPage(first)).toEqual({ items: [], next: secondCursor });
  const empty = receiveInboxPage(nextInboxPage(first), ready([], thirdCursor));
  expect(empty.cursor).toBe(secondCursor);
  expect(readableInboxPage(empty)).toEqual({ items: [], next: thirdCursor });
  const requested = nextInboxPage(empty);
  expect(requested.cursor).toBe(thirdCursor);
  const last = receiveInboxPage(requested, ready([item('oldest')], null));
  expect(readableInboxPage(last)).toEqual({ items: [item('oldest')], next: null });
});

test('refreshes replace a page and fresh duplicate IDs replace cached target details without collapsing distinct notices', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([item('newest'), item('newest')], secondCursor));
  expect(readableInboxPage(first)?.items).toEqual([item('newest')]);
  const loading = nextInboxPage(first);
  const { href: _href, ...original } = item('newest');
  const hidden = { ...original, text: '', unavailable: true, unread: false };
  const second = receiveInboxPage(loading, ready([hidden, item('older')], thirdCursor));
  expect(readableInboxPage(second)?.items).toEqual([hidden, item('older')]);
  const refreshed = receiveInboxPage(second, ready([item('replacement')], 'refreshed.signed.cursor'));
  expect(readableInboxPage(refreshed)?.items).toEqual([hidden, item('replacement')]);
  expect(nextInboxPage(refreshed).cursor).toBe('refreshed.signed.cursor');
  const transportFailed = receiveInboxPage(refreshed, refreshed.result, true);
  expect(readableInboxPage(transportFailed)).toEqual(readableInboxPage(refreshed));
  expect(transportFailed.cursor).toBe(secondCursor);
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

test('Let an Inbox reader refresh a successful or rejected continuation with original request/privacy/recovery bounds intact', () => {
  const first = receiveInboxPage(emptyInboxPagination, ready([item('original')], secondCursor));
  expect(restartInboxPage(emptyInboxPagination)).toBe(emptyInboxPagination);
  expect(restartInboxPage(first)).toBe(first);
  const continuation = nextInboxPage(first);
  expect(restartInboxPage(continuation)).toBe(continuation);
  const continued = receiveInboxPage(continuation, ready([item('older')], thirdCursor));
  const refreshed = restartInboxPage(continued);
  expect(refreshed).toBe(emptyInboxPagination);
  expect(readableInboxPage(refreshed)).toBeNull();
  expect(readableInboxPage(receiveInboxPage(refreshed, ready([item('arrival')], secondCursor)))).toEqual({
    items: [item('arrival')],
    next: secondCursor,
  });
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
    expect(readableInboxPage(fresh)).toEqual({ items: [item('current-first')], next: thirdCursor });
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
