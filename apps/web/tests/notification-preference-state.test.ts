import { expect, mock, spyOn, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import { changeNotifications, loadSettingsPage } from '../src/settings/preferences';
import { NotificationEditor } from '../src/settings/notification-recovery';

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
    accountId: 'alice',
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
      accountId: 'alice',
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
    [503, 'dependency_unavailable', 'unavailable'],
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

test('a definite notification refusal guards row autosave, Restore and Reload until the native deadline', async () => {
  for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:00:30 GMT']) {
    let now = Date.parse('2026-10-31T00:00:00Z');
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const notifications = { reply: true, mention: true, weekly_digest: false };
      let refused = true;
      const transport = harness(
        () =>
          refused
            ? Response.json(
                { code: 'invalid_request', retryable: false, request_id: 'native-refusal', detail: 'private' },
                { status: 422, headers: { 'retry-after': retryAfter } },
              )
            : Response.json({ ...reading, version: 8, notifications: { ...notifications, reply: false } }),
        'POST',
      );
      const editor = new NotificationEditor(
        { notifications, version: 7 },
        {
          save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
          read: () => loadSettingsPage(transport.client, transport.request, transport.env),
        },
      );
      await editor.edit('reply', false, 7);
      const failed = editor.snapshot();
      expect(failed).toMatchObject({
        phase: 'failed',
        pending: null,
        draft: { ...notifications, reply: false },
        retryAt: now + 30_000,
        failure: { status: 422, code: 'invalid_request', retryAfter, requestId: 'native-refusal' },
      });
      await editor.edit('mention', false, 7);
      await editor.restore(7);
      await editor.submit(7);
      await editor.retry();
      await editor.reload();
      expect(editor.snapshot()).toBe(failed);
      expect(transport.calls).toHaveLength(1);
      now += 29_999;
      await editor.edit('weekly_digest', true, 7);
      await editor.restore(7);
      await editor.reload();
      expect(editor.snapshot()).toBe(failed);
      now++;
      await Promise.resolve();
      expect(transport.calls).toHaveLength(1);
      refused = false;
      await editor.reload();
      await editor.submit(8);
      expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'GET', 'PATCH']);
      expect(transport.sessionReads()).toBe(3);
      expect(transport.calls[2]!.headers.get('idempotency-key')).not.toBe(
        transport.calls[0]!.headers.get('idempotency-key'),
      );
      expect(await transport.calls[2]!.json()).toEqual({ expectedVersion: 8, notifications: { reply: false } });
      expect(editor.snapshot()).toMatchObject({ phase: 'saved', draft: { ...notifications, reply: false } });
    } finally {
      clock.mockRestore();
    }
  }
});

test('delayed original and recovery reads preserve local drafts, exact replay and deliberate review actions', async () => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const notifications = { reply: true, mention: true, weekly_digest: false };
    const receipt = { ...reading, version: 8, notifications: { ...notifications, reply: false } };
    let step = 0;
    const transport = harness(() => {
      step++;
      if (step === 1 || step === 3)
        return Response.json(
          { code: 'dependency_unavailable', retryable: true, request_id: `native-${step}` },
          { status: 503, headers: { 'retry-after': step === 1 ? '30' : '20' } },
        );
      if (step === 2 || step === 4) return Response.json(receipt);
      return Response.json({
        ...reading,
        version: step === 5 ? 9 : 10,
        notifications: { ...notifications, reply: step === 5, mention: step === 5, weekly_digest: step === 6 },
      });
    }, 'POST');
    const confirmed: number[] = [];
    const editor = new NotificationEditor(
      { notifications, version: 7 },
      {
        save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
        read: () => loadSettingsPage(transport.client, transport.request, transport.env),
        confirmed: (version) => confirmed.push(version),
      },
    );
    await editor.edit('reply', false, 7);
    const pending = editor.snapshot().pending;
    now += 10_000;
    await editor.edit('mention', false, 7);
    await editor.restore(7);
    await editor.submit(7);
    await editor.reload();
    await editor.retry();
    expect(transport.calls).toHaveLength(1);
    expect(editor.snapshot().retryAt).toBe(now + 20_000);
    expect(editor.snapshot().pending).toBe(pending);
    now += 20_000;
    expect(transport.calls).toHaveLength(1);
    await editor.retry();
    expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET']);
    expect(editor.snapshot()).toMatchObject({
      phase: 'uncertain',
      known: { notifications, version: 7 },
      draft: { ...notifications, reply: false, mention: false },
      failure: { status: 503, retryAfter: '20', requestId: 'native-3' },
    });
    expect(editor.snapshot().pending).toBe(pending);
    expect(confirmed).toEqual([]);
    await editor.edit('weekly_digest', true, 7);
    await editor.edit('weekly_digest', false, 7);
    await editor.retry();
    await editor.restore(7);
    await editor.reload();
    expect(transport.calls).toHaveLength(3);
    now += 20_000;
    await editor.retry();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      pending: null,
      known: { notifications, version: 9 },
      draft: { ...notifications, reply: false, mention: false },
    });
    for (const index of [1, 3]) {
      expect(transport.calls[index]!.headers.get('idempotency-key')).toBe(
        transport.calls[0]!.headers.get('idempotency-key'),
      );
      expect(await transport.calls[index]!.clone().text()).toBe(await transport.calls[0]!.clone().text());
    }
    await editor.edit('weekly_digest', true, 9);
    expect(transport.calls).toHaveLength(5);
    await editor.submit(9);
    expect(await transport.calls[5]!.json()).toEqual({
      expectedVersion: 9,
      notifications: { reply: false, mention: false, weekly_digest: true },
    });
    expect(transport.calls[5]!.headers.get('idempotency-key')).not.toBe(
      transport.calls[0]!.headers.get('idempotency-key'),
    );
    expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET', 'PATCH', 'GET', 'PATCH']);
    expect(transport.sessionReads()).toBe(6);
    expect(confirmed).toEqual([9, 10]);
    expect(editor.snapshot()).toMatchObject({
      phase: 'saved',
      draft: { reply: false, mention: false, weekly_digest: true },
    });
  } finally {
    clock.mockRestore();
  }
});

test('a delayed conflict keeps local review edits and Reload and Use current retain their distinct outcomes', async () => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const notifications = { reply: true, mention: true, weekly_digest: false };
    let step = 0;
    const transport = harness(
      () =>
        ++step === 1
          ? Response.json({ code: 'conflict' }, { status: 409, headers: { 'retry-after': '30' } })
          : Response.json({ ...reading, version: 8, notifications: { ...notifications, mention: false } }),
      'POST',
    );
    const editor = new NotificationEditor(
      { notifications, version: 7 },
      {
        save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
        read: () => loadSettingsPage(transport.client, transport.request, transport.env),
      },
    );
    await editor.edit('reply', false, 7);
    await editor.edit('weekly_digest', true, 7);
    await editor.restore(7);
    await editor.submit(7);
    await editor.reload();
    expect(transport.calls).toHaveLength(1);
    now += 30_000;
    expect(transport.calls).toHaveLength(1);
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      known: { version: 8, notifications: { ...notifications, mention: false } },
      draft: { ...notifications, reply: false, weekly_digest: true },
    });
    editor.useCurrent();
    expect(editor.snapshot()).toMatchObject({ phase: 'idle', draft: { ...notifications, mention: false } });
    expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'GET']);
    expect(transport.sessionReads()).toBe(2);
  } finally {
    clock.mockRestore();
  }
});
