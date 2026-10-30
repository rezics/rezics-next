import { expect, mock, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import { changeNotifications, loadSettingsPage } from '../src/settings/preferences';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadInboxPage } = await import('../src/inbox/inbox-read');

const csrfToken = 'A'.repeat(22);
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const reading = { spoilerLevel: 1, suitability: 'blur', version: 7 };

function harness(reply: () => Response, method: 'GET' | 'POST' = 'GET') {
  const calls: Request[] = [];
  let sessionReads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/preferences');
      expect(request.headers.get('authorization')).toBe('Bearer alice-token');
      return reply();
    }) as typeof fetch,
  });
  const env = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'notifications-state',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        async credential() {
          sessionReads += 1;
          return { status: 'active', subject: 'alice', accessToken: 'alice-token', csrfToken };
        },
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = new Request('https://site.example.test/en/settings', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      ...(method === 'POST' ? { origin: 'https://site.example.test', 'x-csrf-token': csrfToken } : {}),
    },
  });
  return { client, env, request, calls, sessionReads: () => sessionReads };
}

test('Settings keeps the native per-kind values and writes only the submitted merge patch', async () => {
  const notifications = { reply: false, mention: true, weekly_digest: false };
  const read = harness(() => Response.json({ ...reading, notifications }));
  expect(await loadSettingsPage(read.client, read.request, read.env)).toEqual({
    signedIn: true,
    preferences: reading,
    notifications,
    securityHref: 'https://auth.example.test/security',
  });
  expect(read.calls).toHaveLength(1);
  expect(read.sessionReads()).toBe(1);

  const write = harness(() => Response.json({ ...reading, version: 8, notifications }), 'POST');
  expect(
    await changeNotifications(write.client, write.request, write.env, {
      expectedVersion: 7,
      notifications: { reply: false },
      idempotencyKey,
    }),
  ).toEqual({ ok: true, notifications, version: 8 });
  expect(write.calls).toHaveLength(1);
  expect(write.sessionReads()).toBe(1);
  expect(write.calls[0]!.method).toBe('PATCH');
  expect(write.calls[0]!.headers.get('idempotency-key')).toBe(idempotencyKey);
  expect(write.calls[0]!.headers.get('content-type')).toContain('application/merge-patch+json');
  expect(await write.calls[0]!.json()).toEqual({ expectedVersion: 7, notifications: { reply: false } });
});

test('missing and malformed preference maps never become enabled controls or a confirmed save', async () => {
  for (const notifications of [undefined, null, [], { reply: 'true' }]) {
    const read = harness(() => Response.json({ ...reading, notifications }));
    expect(await loadSettingsPage(read.client, read.request, read.env)).toEqual({
      signedIn: true,
      preferences: reading,
      securityHref: 'https://auth.example.test/security',
    });
    const write = harness(() => Response.json({ ...reading, notifications }), 'POST');
    expect(
      await changeNotifications(write.client, write.request, write.env, {
        expectedVersion: 7,
        notifications: { reply: false },
        idempotencyKey,
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable', failure: { status: 200 } });
    expect(read.calls).toHaveLength(1);
    expect(write.calls).toHaveLength(1);
  }
});

test('Settings preserves preparing, closed and unavailable native read and write failures', async () => {
  for (const [status, code, state] of [
    [503, 'dependency_unavailable', 'preparing'],
    [403, 'platform_closed', 'closed'],
    [500, 'internal_error', 'unavailable'],
  ] as const) {
    const problem = { status, code, retryable: status !== 403, request_id: `notice-${status}` };
    const response = () => Response.json(problem, { status });
    const failure = { status, code, retryable: problem.retryable, requestId: problem.request_id };
    const read = harness(response);
    expect(await loadSettingsPage(read.client, read.request, read.env)).toMatchObject({
      signedIn: true,
      state,
      failure,
    });
    const write = harness(response, 'POST');
    expect(
      await changeNotifications(write.client, write.request, write.env, {
        expectedVersion: 7,
        notifications: { reply: false },
        idempotencyKey,
      }),
    ).toEqual({ ok: false, reason: state, failure });
    expect(read.calls).toHaveLength(1);
    expect(write.calls).toHaveLength(1);
  }

  const closed = harness(() => Response.json({ code: 'platform_closed', retryable: false }, { status: 403 }));
  expect(
    await loadSettingsPage(withPlatformClosedRecognition(closed.client), closed.request, closed.env),
  ).toMatchObject({
    signedIn: true,
    state: 'closed',
    failure: { status: 403, code: 'platform_closed', retryable: false },
  });
});

test('Inbox resolves native document snapshots, order, cursor and bylines with one read per distinct target', async () => {
  const calls: string[] = [];
  const notices = ['newest', 'oldest'].map((id) => ({
    id,
    kind: 'reply',
    createdAt: '2026-10-30T08:00:00.000Z',
    actorId: 'bob',
    threadId: 'thread',
    postId: 'post',
    decisionId: null,
    reportId: null,
    unread: true,
  }));
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/v1/accounts') return Response.json({ accounts: [{ id: 'bob', displayName: 'Bob' }] });
      expect(request.headers.get('authorization')).toBe('Bearer alice-token');
      if (url.pathname === '/v1/accounts/alice/notifications') {
        expect(url.searchParams.get('limit')).toBe('20');
        expect(url.searchParams.get('cursor')).toBe('previous-cursor');
        return Response.json({ items: notices, next: 'native-next' });
      }
      expect(url.pathname).toBe('/v1/posts/post');
      return Response.json({ post: { threadId: 'thread', body: fromPlainText('A native reply\nSecond paragraph') } });
    }) as typeof fetch,
  });
  const page = await loadInboxPage(client, 'alice', 'Bearer alice-token', 'previous-cursor');
  expect(page.next).toBe('native-next');
  expect(page.items.map(({ id }) => id)).toEqual(['newest', 'oldest']);
  for (const item of page.items)
    expect(item).toMatchObject({
      actorName: 'Bob',
      text: 'A native reply\nSecond paragraph',
      href: '/threads/thread#post',
      unavailable: false,
    });
  expect(calls).toHaveLength(3);
  expect(calls.filter((path) => path === '/v1/posts/post')).toHaveLength(1);
});

test('Inbox conceals denied target text and preserves native dependency failures', async () => {
  for (const status of [404, 503]) {
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const url = new URL(new Request(input, init).url);
        if (url.pathname === '/v1/accounts') return Response.json({ accounts: [] });
        if (url.pathname.endsWith('/notifications'))
          return Response.json({
            items: [{ id: 'notice', kind: 'mention', actorId: null, threadId: 'thread', postId: 'post' }],
            next: null,
          });
        return Response.json(
          { code: status === 404 ? 'not_found' : 'dependency_unavailable', request_id: 'target-read' },
          { status },
        );
      }) as typeof fetch,
    });
    if (status === 404) {
      const page = await loadInboxPage(client, 'alice', 'Bearer alice-token');
      expect(page.items[0]).toMatchObject({ unavailable: true, text: '' });
      expect(page.items[0]?.href).toBeUndefined();
    } else {
      await expect(loadInboxPage(client, 'alice', 'Bearer alice-token')).rejects.toMatchObject({
        failure: { status: 503, code: 'dependency_unavailable', requestId: 'target-read' },
      });
    }
  }
});
