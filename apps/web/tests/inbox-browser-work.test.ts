import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { nativeInboxEnvelope, readyInboxPage } = await import('../src/inbox/inbox-read');
const { emptyInboxPagination, inboxPaginationWork, nextInboxPage, receiveInboxPage } =
  await import('../src/inbox/inbox-pagination');
const {
  composeInboxWork,
  deriveInboxBrowserWork,
  INBOX_BROWSER_GROWTH_SCALES,
  INBOX_CONTENT_DISCLOSURE_EVIDENCE,
  INBOX_CONTENT_GROWTH_SCALES,
  INBOX_LIST_CANDIDATE_LIMIT,
  INBOX_PAGE_SIZE,
  INBOX_UNREAD_RAW_WINDOW,
  MAX_INBOX_CURSOR_LENGTH,
  MAX_INBOX_CURSOR_PAYLOAD_BYTES,
  MAX_INBOX_PRIOR_ADDRESSES,
  MAX_INBOX_RETAINED_CURSORS,
} = await import('../src/inbox/inbox-work');
const { loadInboxPage } = await import('../src/inbox/inbox-read');
type InboxNotice = import('../src/inbox/inbox-read').InboxNotice;

function notice(id: string): InboxNotice {
  return {
    id,
    kind: 'thread_watch',
    createdAt: '2026-11-04T10:00:00.000Z',
    unread: true,
    actorId: 'actor-1',
    threadId: 'thread-1',
    postId: 'post-1',
    decisionId: null,
    reportId: null,
    actor: {
      state: 'available',
      accountId: 'actor-1',
      displayName: 'Momo',
      handle: 'momo',
      avatar: null,
      avatarUrl: null,
      automated: false,
    },
    target: {
      state: 'available',
      threadId: 'thread-1',
      postId: 'post-1',
      boardId: 'board-1',
      threadTitle: 'Watched discussion',
      boardTitle: 'Books',
    },
    summary: 'A new post on a thread you watch',
    actions: {
      open: { kind: 'thread_post', threadId: 'thread-1', postId: 'post-1' },
      markSeen: { method: 'POST', path: `/v1/accounts/alice/notifications/${id}:markSeen` },
    },
  };
}

test('composed Inbox work keeps one 20-row body, eight prior addresses, one return receipt and zero hydration at 64/512/4096', async () => {
  expect(INBOX_BROWSER_GROWTH_SCALES).toEqual([64, 512, 4096]);
  expect(INBOX_CONTENT_GROWTH_SCALES).toEqual([256, 1024, 4096]);
  expect(INBOX_LIST_CANDIDATE_LIMIT).toBe(80);
  expect(INBOX_UNREAD_RAW_WINDOW).toBe(201);
  expect(MAX_INBOX_RETAINED_CURSORS).toBe(10);
  const fullCursors = Array.from({ length: MAX_INBOX_RETAINED_CURSORS }, () => 'c'.repeat(MAX_INBOX_CURSOR_LENGTH));
  expect(
    composeInboxWork({
      listRequests: 1,
      countRequests: 1,
      retainedRows: 20,
      priorAddresses: 8,
      cursors: fullCursors,
      visits: 1,
      returnReceipts: 1,
    }).cursorPayloadBytes,
  ).toBe(MAX_INBOX_CURSOR_PAYLOAD_BYTES);

  const pageRows = Array.from({ length: INBOX_PAGE_SIZE }, (_, index) => notice(`page-${index}`));
  const pageWire = JSON.stringify(nativeInboxEnvelope(pageRows, null, 'alice'));
  async function measure(unrelated: number, visits: number) {
    let requests = 0;
    let retainedRows = 0;
    let bytes = 0;
    const client = createKernelClient('http://kernel.local', {
      fetch: (async () => {
        requests += 1;
        return new Response(pageWire, { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    for (let visit = 0; visit < visits; visit += 1) {
      const page = await loadInboxPage(client, 'alice', 'Bearer alice');
      retainedRows = page.items.length;
      bytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
    }
    const work = deriveInboxBrowserWork({
      visits,
      countRequests: visits,
      unrelatedNotices: unrelated,
      retainedRows,
      priorAddresses: 0,
      discardedCandidates: unrelated,
    });
    expect(requests).toBe(visits);
    expect(work).toMatchObject({
      listRequests: visits,
      countRequests: visits,
      hydrationRequests: 0,
      retainedRows: 20,
      discardedCandidates: unrelated,
      unrelatedNotices: unrelated,
      content: INBOX_CONTENT_DISCLOSURE_EVIDENCE,
    });
    expect(retainedRows).toBe(20);
    expect(bytes).toBeLessThan(32_768);
    return bytes;
  }
  const materialized = [];
  for (const unrelated of INBOX_BROWSER_GROWTH_SCALES) materialized.push(await measure(unrelated, 64));
  for (const visits of INBOX_BROWSER_GROWTH_SCALES) materialized.push(await measure(64, visits));
  expect(new Set(materialized).size).toBe(1);
  expect(INBOX_CONTENT_DISCLOSURE_EVIDENCE.growth[0]).toBe('services/kernel/test/content/growth-notice-inbox.test.ts');
  expect(INBOX_CONTENT_DISCLOSURE_EVIDENCE.examined.listCandidateLimit).toBe(80);
}, 60_000);

test('pagination work counts the return receipt inside the 80 KiB cursor payload', () => {
  let state = receiveInboxPage(emptyInboxPagination, readyInboxPage([notice('first')], 'cursor-1', 'alice'));
  for (let index = 1; index <= 8; index += 1)
    state = receiveInboxPage(
      nextInboxPage(state),
      readyInboxPage([notice(`page-${index}`)], index === 8 ? null : `cursor-${index + 1}`, 'alice'),
    );
  const returnCursor = 'r'.repeat(MAX_INBOX_CURSOR_LENGTH);
  const work = inboxPaginationWork(state, {
    listRequests: 9,
    countRequests: 1,
    visits: 2,
    returnCursor,
    unrelatedNotices: 4096,
    discardedCandidates: 4076,
  });
  expect(work.priorAddresses).toBe(MAX_INBOX_PRIOR_ADDRESSES);
  expect(work.returnReceipts).toBe(1);
  expect(work.retainedRows).toBe(1);
  expect(work.cursorPayloadBytes).toBeLessThanOrEqual(MAX_INBOX_CURSOR_PAYLOAD_BYTES);
  expect(work.content.disclosure).toBe(INBOX_CONTENT_DISCLOSURE_EVIDENCE.disclosure);
  expect(() =>
    composeInboxWork({
      listRequests: 1,
      countRequests: 1,
      retainedRows: 20,
      priorAddresses: 8,
      cursors: Array.from({ length: 11 }, () => 'x'),
      visits: 1,
    }),
  ).toThrow('eight prior addresses, the current address and one return receipt');
});
