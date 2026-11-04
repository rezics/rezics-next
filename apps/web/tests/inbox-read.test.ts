import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test/en/inbox'),
  setResponseHeader: () => {},
}));
import {
  decodeInboxPage,
  inboxPageActions,
  loadUnreadCount,
  nativeInboxEnvelope,
  readyInboxPage,
  type InboxNotice,
} from '../src/inbox/inbox-read';
import type { SessionEnv } from '../src/session/client';
import { preferenceRetryDeadline } from '../src/settings/preference-failure-retry';

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

function countSession(signedIn = true) {
  const credential = async () =>
    signedIn
      ? { status: 'active' as const, subject: 'alice', accessToken: 'alice-token', csrfToken: 'A'.repeat(22) }
      : { status: 'absent' as const };
  const env = {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'inbox-read',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
  } as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.test/en/inbox', {
      headers: signedIn ? { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } : {},
    });
  return { env, request };
}

function countClient(handler: (request: Request) => Response) {
  return createKernelClient('http://kernel.local', {
    fetch: (async (input, init) => handler(new Request(input, init))) as typeof fetch,
  });
}

const currentDisclosure = { kind: 'current-disclosure' as const, at: '2026-11-04T00:00:00.000Z' };

test('unread count keeps native zero, lower-bound, bounded Retry-After and signed-out without inventing delay or a zero', async () => {
  const owner = countSession();
  const ready = {
    count: 0,
    capped: false,
    basis: 'current-visible-unread' as const,
    witness: currentDisclosure,
  };
  expect(await loadUnreadCount(countClient(() => Response.json(ready)), owner.request(), owner.env)).toEqual({
    signedIn: true,
    state: 'ready',
    ...ready,
  });
  const capped = {
    count: 100,
    capped: true,
    basis: 'current-visible-lower-bound' as const,
    witness: currentDisclosure,
  };
  expect(await loadUnreadCount(countClient(() => Response.json(capped)), owner.request(), owner.env)).toEqual({
    signedIn: true,
    state: 'ready',
    ...capped,
  });
  const now = Date.parse('2026-10-31T00:00:00.000Z');
  for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:01:00 GMT', 'invalid', undefined, `${'9'.repeat(200)}`] as const) {
    const result = await loadUnreadCount(
      countClient(
        () =>
          Response.json(
            { status: 503, code: 'deadline_exceeded', retryable: true, request_id: 'count-wait' },
            { status: 503, headers: retryAfter === undefined ? {} : { 'Retry-After': retryAfter } },
          ),
      ),
      owner.request(),
      owner.env,
    );
    const kept = typeof retryAfter === 'string' && retryAfter.length <= 128 ? retryAfter : undefined;
    expect(result).toEqual({
      signedIn: true,
      state: 'unavailable',
      failure: {
        status: 503,
        code: 'deadline_exceeded',
        retryable: true,
        requestId: 'count-wait',
        ...(kept && (retryAfter === '30' || retryAfter?.endsWith('GMT') || retryAfter === 'invalid')
          ? { retryAfter: kept }
          : {}),
      },
    });
    expect(preferenceRetryDeadline(result.signedIn && result.state === 'unavailable' ? result.failure.retryAfter : undefined, now)).toBe(
      retryAfter === '30' ? now + 30_000 : retryAfter?.endsWith('GMT') ? now + 60_000 : 0,
    );
  }
  let nativeReads = 0;
  expect(
    await loadUnreadCount(
      countClient(() => {
        nativeReads += 1;
        return Response.json(ready);
      }),
      countSession(false).request(),
      countSession(false).env,
    ),
  ).toEqual({ signedIn: false });
  expect(nativeReads).toBe(0);
});
