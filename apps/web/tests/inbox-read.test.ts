import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  decodeInboxPage,
  inboxPageActions,
  nativeInboxEnvelope,
  readyInboxPage,
  type InboxNotice,
} from '../src/inbox/inbox-read';

function notice(id: string, unread = true, accountId = 'alice'): InboxNotice {
  return {
    id,
    kind: 'reply',
    createdAt: '2026-11-03T10:00:00.000Z',
    unread,
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
      avatarUrl: null,
      automated: false,
    },
    target: {
      state: 'available',
      threadId: 'thread-1',
      postId: 'post-1',
      boardId: null,
      threadTitle: 'Current discussion',
      boardTitle: null,
    },
    summary: `Update ${id}`,
    actions: {
      open: { kind: 'thread_post', threadId: 'thread-1', postId: 'post-1' },
      markSeen: { method: 'POST', path: `/v1/accounts/${accountId}/notifications/${id}:markSeen` },
    },
  };
}

test('closed Inbox pages bind viewer, selection and owner-admitted page actions', () => {
  const items = [notice('newest'), notice('older', false)];
  const page = decodeInboxPage(nativeInboxEnvelope(items, null, 'alice', 'all'), 'alice');
  expect(page.viewer).toEqual({ accountId: 'alice' });
  expect(page.selection).toBe('all');
  expect(page.actions.markSeen).toEqual({
    method: 'POST',
    path: '/v1/accounts/alice/notifications:markSeen',
    through: 'newest',
  });
  expect(() => decodeInboxPage({ items, next: null }, 'alice')).toThrow();
  expect(() => decodeInboxPage({ ...nativeInboxEnvelope(items, null, 'alice'), extra: true }, 'alice')).toThrow();
});

test('unread continuation cannot admit bulk mark-through from the loaded array', () => {
  const items = [notice('visible-unread')];
  expect(inboxPageActions(items, 'opaque-next', 'unread', 'alice')).toEqual({ markSeen: null });
  expect(() =>
    decodeInboxPage(
      {
        ...nativeInboxEnvelope(items, 'opaque-next', 'alice', 'unread'),
        actions: {
          markSeen: { method: 'POST', path: '/v1/accounts/alice/notifications:markSeen', through: 'visible-unread' },
        },
      },
      'alice',
    ),
  ).toThrow();
  const exhausted = decodeInboxPage(nativeInboxEnvelope(items, null, 'alice', 'unread'), 'alice');
  expect(exhausted.actions.markSeen?.through).toBe('visible-unread');
});

test('a guessed timestamp or non-newest through fails the page', () => {
  const items = [notice('newest'), notice('older')];
  const envelope = nativeInboxEnvelope(items, null, 'alice');
  expect(() =>
    decodeInboxPage(
      {
        ...envelope,
        actions: {
          markSeen: { method: 'POST', path: '/v1/accounts/alice/notifications:markSeen', through: 'older' },
        },
      },
      'alice',
    ),
  ).toThrow();
  expect(() =>
    decodeInboxPage(
      {
        ...envelope,
        actions: {
          markSeen: {
            method: 'POST',
            path: '/v1/accounts/alice/notifications:markSeen',
            through: '2026-11-04T00:00:00.000Z',
          },
        },
      },
      'alice',
    ),
  ).toThrow();
});

test('loadInboxPage sends All or Unread with the page size and retries the same selection and cursor', async () => {
  const queries: string[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: (async (input) => {
      const url = new URL(new Request(input).url);
      queries.push(url.searchParams.toString());
      return Response.json(nativeInboxEnvelope([notice('unread-1')], 'opaque-next', 'alice', 'unread'));
    }) as typeof fetch,
  });
  const { loadInboxPage } = await import('../src/inbox/inbox-read');
  const page = await loadInboxPage(client, 'alice', 'Bearer alice', {
    selection: 'unread',
    cursor: 'opaque/+input==',
  });
  expect(page.selection).toBe('unread');
  expect(page.actions.markSeen).toBeNull();
  await loadInboxPage(client, 'alice', 'Bearer alice', { selection: 'unread', cursor: 'opaque/+input==' });
  expect(queries).toEqual([
    'limit=20&selection=unread&cursor=opaque%2F%2Binput%3D%3D',
    'limit=20&selection=unread&cursor=opaque%2F%2Binput%3D%3D',
  ]);
});

test('readyInboxPage is the consumer envelope for a retained current page', () => {
  const page = readyInboxPage([notice('row')], 'next', 'alice', 'unread');
  expect(page).toMatchObject({
    signedIn: true,
    state: 'ready',
    selection: 'unread',
    viewer: { accountId: 'alice' },
    next: 'next',
    actions: { markSeen: null },
  });
});
