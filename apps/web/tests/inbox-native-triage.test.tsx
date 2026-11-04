import { expect, mock, test } from 'bun:test';
import { createKernelClient, type NoticeInboxItem } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLocale } from '../src/paraglide/runtime.js';
import { threadLocation } from '../src/threads/thread-href';
import {
  emptyInboxPagination,
  nextInboxPage,
  receiveInboxPage,
  readableInboxPage,
  confirmInboxNoticeSeen,
} from '../src/inbox/inbox-pagination';
mock.module('cloudflare:workers', () => ({ env: {} }));
const {
  decodeInboxPage,
  inboxReadFailure,
  loadInboxPage,
  markInboxNoticeSeen,
  nativeInboxEnvelope,
  resolveInboxItems,
} = await import('../src/inbox/inbox-read');
const { InboxRows } = await import('../src/inbox/inbox-page');
const { InboxNoticeDetailView } = await import('../src/inbox/inbox-notice-detail');
type Notice = NoticeInboxItem;

function notice(id: string, kind: Notice['kind']): Notice {
  const report = kind === 'moderation_decision';
  const board = kind === 'board_activity';
  const threadId = report ? null : kind === 'thread_watch' ? 'watched-thread' : 'thread-1';
  const postId = report ? null : 'post-1';
  const reportId = report ? 'report-1' : null;
  const decisionId = report ? null : null;
  const target = report
    ? { state: 'withheld' as const, threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null }
    : {
        state: 'available' as const,
        threadId,
        postId,
        boardId: board ? 'board-1' : null,
        threadTitle: threadId ? 'Current discussion' : null,
        boardTitle: board ? 'Current board' : null,
      };
  const actor = report
    ? { state: 'system' as const, displayName: 'Moderation team' as const, handle: null, avatarUrl: null }
    : id === 'mention-1'
      ? {
          state: 'withheld' as const,
          displayName: 'Former or unavailable account' as const,
          handle: null,
          avatarUrl: null,
        }
      : {
          state: 'available' as const,
          accountId: 'actor-1',
          displayName: 'Momo',
          handle: 'momo',
          avatarUrl: null,
          automated: false,
        };
  const open = report
    ? { kind: 'report_outcome' as const, reportId: reportId! }
    : { kind: 'thread_post' as const, threadId: threadId!, postId: postId! };
  return {
    id,
    kind,
    createdAt: '2026-11-03T10:00:00.000Z',
    unread: true,
    actorId: actor.state === 'available' ? actor.accountId : null,
    threadId,
    postId,
    decisionId,
    reportId,
    actor,
    target,
    summary: report ? 'Your report was actioned' : `Update ${id}`,
    actions: {
      open,
      markSeen: { method: 'POST', path: `/v1/accounts/alice/notifications/${id}:markSeen` },
    },
  };
}

const composed = [
  notice('reply-1', 'reply'),
  notice('mention-1', 'mention'),
  notice('thread-watch-1', 'thread_watch'),
  notice('board-activity-1', 'board_activity'),
  notice('report-1', 'moderation_decision'),
];

test('Inbox uses one composed page for current disclosure, installed kinds and admitted localized destinations', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json(nativeInboxEnvelope(composed, 'opaque/+continuation==', 'alice'));
    }) as typeof fetch,
  });
  const page = await loadInboxPage(client, 'alice', 'Bearer alice', 'opaque/+input==');
  expect(page.items.map(({ kind }) => kind)).toEqual([
    'reply',
    'mention',
    'thread_watch',
    'board_activity',
    'moderation_decision',
  ]);
  expect(page.items[0]).toMatchObject({ actorName: 'Momo', context: 'Current discussion', text: 'Update reply-1' });
  expect(page.items[1]).toMatchObject({ actorId: null, actor: { state: 'withheld' }, href: expect.any(String) });
  expect(page.items[0]?.href).toBe(
    threadLocation(getLocale(), { id: 'thread-1', title: 'Current discussion' }, undefined, 'post-1'),
  );
  expect(page.items[2]?.href).toBe(
    threadLocation(getLocale(), { id: 'watched-thread', title: 'Current discussion' }, undefined, 'post-1'),
  );
  expect(page.items[3]?.href).toBe(
    threadLocation(getLocale(), { id: 'thread-1', title: 'Current discussion' }, undefined, 'post-1'),
  );
  expect(page.items[3]?.context).toBe('Current discussion · Current board');
  expect(page.items[4]).toMatchObject({
    href: `/${getLocale()}/moderation/reports/report-1`,
    unavailable: true,
    target: { state: 'withheld', threadId: null, postId: null, boardId: null },
  });
  expect(page.next).toBe('opaque/+continuation==');
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]!.url).searchParams.toString()).toBe(
    'limit=20&selection=all&cursor=opaque%2F%2Binput%3D%3D',
  );
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer alice');
});

test('list and detail share available actor identity while withheld and system labels stay distinct', async () => {
  const resolved = await resolveInboxItems(nativeInboxEnvelope(composed, null, 'alice'));
  const list = renderToStaticMarkup(createElement(InboxRows, { page: resolved }));
  const availableDetail = renderToStaticMarkup(
    createElement(InboxNoticeDetailView, { notice: composed[0]!, selection: 'all' }),
  );
  const withheldDetail = renderToStaticMarkup(
    createElement(InboxNoticeDetailView, { notice: composed[1]!, selection: 'all' }),
  );
  const systemDetail = renderToStaticMarkup(
    createElement(InboxNoticeDetailView, { notice: composed[4]!, selection: 'all' }),
  );

  expect(list).toContain('Momo');
  expect(availableDetail).toContain('Momo');
  expect(availableDetail).toContain('@momo');
  expect(list).toContain('Community member');
  expect(list).not.toContain('Former or unavailable account');
  expect(withheldDetail).toContain('Community member');
  expect(withheldDetail).toContain('Actor details are unavailable.');
  expect(list).toContain('Moderation team');
  expect(systemDetail).toContain('Moderation team');
});

test('sparse continuation preserves its cursor and a failed page remains unavailable', async () => {
  const cursor = 'opaque/+continuation==';
  const cursors: (string | null)[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      cursors.push(url.searchParams.get('cursor'));
      return Response.json(nativeInboxEnvelope([], url.searchParams.has('cursor') ? null : cursor, 'alice'));
    }) as typeof fetch,
  });
  const firstPage = await loadInboxPage(client, 'alice', 'Bearer alice');
  let state = receiveInboxPage(emptyInboxPagination, { signedIn: true, state: 'ready', ...firstPage });
  expect(readableInboxPage(state)).toMatchObject({ items: [], next: cursor });
  state = nextInboxPage(state);
  expect(state.cursor).toBe(cursor);
  const continued = await loadInboxPage(client, 'alice', 'Bearer alice', state.cursor);
  state = receiveInboxPage(state, { signedIn: true, state: 'ready', ...continued });
  expect(readableInboxPage(state)).toMatchObject({ items: [], next: null });
  expect(cursors).toEqual([null, cursor]);

  const unavailable = createKernelClient('http://kernel.local', {
    fetch: (async () => Response.json({ code: 'dependency_unavailable' }, { status: 503 })) as typeof fetch,
  });
  const failure = await loadInboxPage(unavailable, 'alice', 'Bearer alice').catch(inboxReadFailure);
  expect(failure).toMatchObject({ signedIn: true, state: 'unavailable', failure: { status: 503 } });
  expect(failure).not.toHaveProperty('items');
});

test('a successful continuation replaces the prior page window', async () => {
  const first = await resolveInboxItems(
    nativeInboxEnvelope(
      Array.from({ length: 20 }, (_, index) => notice(`first-${index}`, 'reply')),
      'opaque-next',
      'alice',
    ),
  );
  let state = receiveInboxPage(emptyInboxPagination, { signedIn: true, state: 'ready', ...first });
  state = nextInboxPage(state);
  const second = await resolveInboxItems(
    nativeInboxEnvelope(
      Array.from({ length: 20 }, (_, index) => notice(`second-${index}`, 'reply')),
      null,
      'alice',
    ),
  );
  state = receiveInboxPage(state, { signedIn: true, state: 'ready', ...second });
  expect(state.earlier).toBeNull();
  expect(readableInboxPage(state)?.items.map(({ id }) => id)).toEqual(
    Array.from({ length: 20 }, (_, index) => `second-${index}`),
  );
});

test('one-item acknowledgement uses only its notice identity and changes no neighboring row', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const attempt = Object.freeze({
    accountId: 'alice',
    noticeId: 'chosen',
    idempotencyKey: '01a17a3b-0884-721b-91ef-d7ffd7bb58f8',
  });
  await markInboxNoticeSeen(client, 'alice', 'Bearer alice', attempt);
  const request = requests[0]!;
  expect(request.method).toBe('POST');
  expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/notifications/chosen:markSeen');
  expect(request.headers.get('authorization')).toBe('Bearer alice');
  expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(attempt.idempotencyKey));
  expect(await request.text()).toBe('');

  const resolved = await resolveInboxItems(
    nativeInboxEnvelope([notice('chosen', 'reply'), notice('neighbor', 'mention')], null, 'alice'),
  );
  const initial = receiveInboxPage(emptyInboxPagination, { signedIn: true, state: 'ready', ...resolved });
  const confirmed = confirmInboxNoticeSeen(initial, 'chosen');
  expect(confirmed.current?.items.map(({ id, unread }) => [id, unread])).toEqual([
    ['chosen', false],
    ['neighbor', true],
  ]);
  expect(confirmInboxNoticeSeen(confirmed, 'chosen')).toBe(confirmed);
});

test('fixed 20-row visits do not fan out or retain unrelated notices across 1, 10 and 100 visits', async () => {
  const pageRows = Array.from({ length: 20 }, (_, index) => notice(`page-${index}`, 'reply'));
  const materializedSizes: number[] = [];
  for (const unrelated of [0, 10, 100]) {
    const serverRows = [
      ...pageRows,
      ...Array.from({ length: unrelated }, (_, index) => notice(`unrelated-${index}`, 'reply')),
    ];
    const pageWire = JSON.stringify(nativeInboxEnvelope(serverRows.slice(0, 20), null, 'alice'));
    for (const visits of [1, 10, 100]) {
      let requests = 0;
      let wireBytes = 0;
      let retainedRows = 0;
      let materializedBytes = 0;
      const client = createKernelClient('http://kernel.local', {
        fetch: (async () => {
          requests++;
          wireBytes += new TextEncoder().encode(pageWire).byteLength;
          return new Response(pageWire, { headers: { 'content-type': 'application/json' } });
        }) as typeof fetch,
      });
      for (let visit = 0; visit < visits; visit++) {
        const page = await loadInboxPage(client, 'alice', 'Bearer alice');
        retainedRows = page.items.length;
        materializedBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
      }
      expect(requests).toBe(visits);
      expect(retainedRows).toBe(20);
      expect(materializedBytes).toBeLessThan(20_000);
      expect(wireBytes).toBe(new TextEncoder().encode(pageWire).byteLength * visits);
      materializedSizes.push(materializedBytes);
    }
  }
  expect(new Set(materializedSizes).size).toBe(1);
});

test('unknown native rows fail closed instead of becoming replies', () => {
  const valid = notice('valid', 'reply');
  for (const invalid of [
    { ...valid, kind: 'unknown' },
    { ...valid, actions: { ...valid.actions!, open: { kind: 'url', href: 'https://outside.test' } } },
    { ...valid, extra: true },
  ])
    expect(() => decodeInboxPage(nativeInboxEnvelope([valid, invalid], null, 'alice'), 'alice')).toThrow();

  const genericOutcome = {
    ...notice('generic-outcome', 'moderation_decision'),
    reportId: null,
    summary: 'A moderation outcome was recorded',
    actions: {
      open: null,
      markSeen: { method: 'POST' as const, path: '/v1/accounts/alice/notifications/generic-outcome:markSeen' },
    },
  };
  expect(
    decodeInboxPage(nativeInboxEnvelope([genericOutcome], null, 'alice'), 'alice').items[0]?.actions?.open,
  ).toBeNull();
});
