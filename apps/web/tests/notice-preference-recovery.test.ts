import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { NotificationEditor } from '../src/settings/notification-recovery';
import { changeNotifications, loadSettingsPage, type NotificationPreferences } from '../src/settings/preferences';
import type { SessionEnv } from '../src/session/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadInboxPage, loadUnreadCount } = await import('../src/inbox/inbox-read');
const { UnreadBadgeView } = await import('../src/inbox/unread-badge');
const { InboxRows } = await import('../src/inbox/inbox-page');
const { m } = await import('../src/paraglide/messages.js');

const token = 'A'.repeat(22);
const initial = { notifications: { reply: true, mention: true }, version: 7 };
function session(fail = false) {
  let reads = 0;
  const credential = async () => {
    reads += 1;
    if (fail) throw new Error('session dependency unavailable');
    return { status: 'active', subject: 'alice', accessToken: 'alice-token', csrfToken: token };
  };
  const env = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'notices',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
  } as Partial<SessionEnv>;
  const request = (method = 'GET', csrf = token) =>
    new Request('https://site.example.test/en/settings', {
      method,
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        ...(method === 'POST' ? { origin: 'https://site.example.test', 'x-csrf-token': csrf } : {}),
      },
    });
  return { env, request, reads: () => reads };
}
function clientWith(fetcher: (request: Request) => Promise<Response> | Response) {
  return createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => fetcher(new Request(input, init))) as typeof fetch,
  });
}
function preferenceJourney() {
  let current = { ...initial, notifications: { ...initial.notifications } };
  let receipt = current;
  let lose = true;
  let unavailableRead = false;
  const calls: { method: string; key: string | null; body: string }[] = [];
  const owner = session();
  const client = clientWith(async (request) => {
    expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/preferences');
    expect(request.headers.get('authorization')).toBe('Bearer alice-token');
    const body = await request.text();
    calls.push({ method: request.method, key: request.headers.get('idempotency-key'), body });
    if (request.method === 'GET')
      return unavailableRead
        ? Response.json({ code: 'dependency_unavailable', retryable: true }, { status: 503 })
        : Response.json({ spoilerLevel: 1, suitability: 'blur', ...current });
    expect(request.headers.get('content-type')).toContain('application/merge-patch+json');
    const change = JSON.parse(body) as { expectedVersion: number; notifications: NotificationPreferences | null };
    const original = calls.find((call) => call.method === 'PATCH');
    if (
      original &&
      calls.filter((call) => call.method === 'PATCH').length > 1 &&
      original.key === request.headers.get('idempotency-key')
    ) {
      expect(body).toBe(original.body);
      return Response.json({ spoilerLevel: 1, suitability: 'blur', ...receipt });
    }
    if (change.expectedVersion !== current.version) return Response.json({ code: 'conflict' }, { status: 409 });
    current = {
      version: current.version + 1,
      notifications:
        change.notifications === null
          ? { reply: true, mention: true }
          : { ...current.notifications, ...change.notifications },
    };
    receipt = current;
    if (lose) {
      lose = false;
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    }
    return Response.json({ spoilerLevel: 1, suitability: 'blur', ...current });
  });
  const editor = new NotificationEditor(initial, {
    save: (change) => changeNotifications(client, owner.request('POST'), owner.env, change),
    read: () => loadSettingsPage(client, owner.request(), owner.env),
  });
  return {
    editor,
    client,
    owner,
    calls,
    current: (notifications: NotificationPreferences, version: number) => {
      current = { notifications, version };
    },
    readFails: (value: boolean) => {
      unavailableRead = value;
    },
  };
}

test('a lost save replays its original key and exact input, reads current native values, and preserves a separate draft for deliberate resubmission', async () => {
  const journey = preferenceJourney();
  const { editor, calls } = journey;
  await editor.edit('reply', false, 7);
  expect(editor.snapshot().phase).toBe('uncertain');
  const pending = editor.snapshot().pending;
  await editor.edit('mention', false, 7);
  expect(calls).toHaveLength(1);
  expect(editor.snapshot().pending).toBe(pending);
  journey.current({ reply: true, mention: true }, 9);
  await editor.retry();
  expect(calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET']);
  expect(calls[1]).toEqual(calls[0]);
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    known: { notifications: { reply: true, mention: true }, version: 9 },
    draft: { reply: false, mention: false },
  });
  await editor.submit(9);
  expect(JSON.parse(calls[3]!.body)).toEqual({ expectedVersion: 9, notifications: { reply: false, mention: false } });
  expect(calls[3]!.key).not.toBe(calls[0]!.key);
  expect(editor.snapshot().phase).toBe('saved');
  expect(journey.owner.reads()).toBe(4);
});

test('reset recovery keeps null and its original version/key until a fresh read succeeds; conflict requires reload and CSRF refusal never saves', async () => {
  const journey = preferenceJourney();
  await journey.editor.restore(7);
  journey.readFails(true);
  await journey.editor.retry();
  expect(journey.editor.snapshot()).toMatchObject({
    phase: 'uncertain',
    pending: { input: { expectedVersion: 7, notifications: null } },
  });
  journey.readFails(false);
  await journey.editor.retry();
  expect(journey.calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET', 'PATCH', 'GET']);
  expect(journey.calls[3]).toEqual(journey.calls[0]);
  expect(journey.editor.snapshot().phase).toBe('saved');

  journey.current({ reply: true, mention: false }, 12);
  await journey.editor.edit('reply', false, 8);
  expect(journey.editor.snapshot().phase).toBe('conflict');
  await journey.editor.reload();
  expect(journey.editor.snapshot()).toMatchObject({
    phase: 'review',
    known: { version: 12 },
    draft: { reply: false, mention: true },
  });
  const before = journey.calls.length;
  const refused = await changeNotifications(
    journey.client,
    journey.owner.request('POST', 'B'.repeat(22)),
    journey.owner.env,
    { expectedVersion: 12, notifications: { reply: false }, idempotencyKey: crypto.randomUUID() },
  );
  expect(refused).toMatchObject({ ok: false, reason: 'forbidden' });
  expect(journey.calls).toHaveLength(before);
});

test('unread failures remain unavailable rather than a zero badge, with one private session preparation and at most one native count request', async () => {
  for (const response of [
    () => Response.json({ code: 'dependency_unavailable', request_id: 'count-read' }, { status: 503 }),
    () => Response.json({ count: 0 }),
    () => Response.json({ count: 101, capped: true }),
    () => {
      throw new Error('transport unavailable');
    },
  ]) {
    const owner = session();
    let requests = 0;
    const client = clientWith((request) => {
      requests += 1;
      expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/notifications/count');
      return response();
    });
    const data = await loadUnreadCount(client, owner.request(), owner.env);
    expect(data).toMatchObject({ signedIn: true, state: 'unavailable' });
    const markup = renderToStaticMarkup(createElement(UnreadBadgeView, { data }));
    expect(markup).toContain(m.inbox_unread_unavailable());
    expect(markup).toContain('?');
    expect(data).not.toHaveProperty('count');
    expect(requests).toBe(1);
    expect(owner.reads()).toBe(1);
  }
  const brokenSession = session(true);
  let requests = 0;
  const client = clientWith(() => {
    requests += 1;
    return Response.json({ count: 0, capped: false });
  });
  expect(await loadUnreadCount(client, brokenSession.request(), brokenSession.env)).toMatchObject({
    signedIn: true,
    state: 'unavailable',
  });
  expect(requests).toBe(0);
  const owner = session();
  expect(await loadUnreadCount(client, owner.request(), owner.env)).toEqual({
    signedIn: true,
    state: 'ready',
    count: 0,
    capped: false,
  });
  expect(
    renderToStaticMarkup(
      createElement(UnreadBadgeView, { data: { signedIn: true, state: 'ready', count: 0, capped: false } }),
    ),
  ).toBe('');
});

test('Inbox retains native privacy, moderation targets, bylines and cursor bounds without converting dependency or unread failure to successful rows', async () => {
  const calls: string[] = [];
  const notices = [
    {
      id: 'hidden',
      kind: 'reply',
      actorId: 'bob',
      threadId: 'thread',
      postId: 'post',
      decisionId: null,
      reportId: null,
    },
    {
      id: 'decision',
      kind: 'moderation_decision',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: 'decision',
      reportId: null,
    },
    {
      id: 'report',
      kind: 'moderation_decision',
      actorId: null,
      threadId: null,
      postId: null,
      decisionId: null,
      reportId: 'report',
    },
  ].map((item) => ({ ...item, createdAt: '2026-10-29T10:00:00.000Z', unread: true }));
  let dependencyFails = false;
  let malformed = false;
  const client = clientWith((request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname === '/v1/accounts') return Response.json({ accounts: [{ id: 'bob', displayName: 'Bob' }] });
    if (url.pathname.endsWith('/notifications')) {
      expect(url.searchParams.get('limit')).toBe('20');
      expect(url.searchParams.get('cursor')).toBe('native-cursor');
      return Response.json({ items: malformed ? [{ ...notices[0], unread: null }] : notices, next: 'native-next' });
    }
    if (url.pathname === '/v1/posts/post')
      return Response.json(
        { code: dependencyFails ? 'dependency_unavailable' : 'not_found' },
        { status: dependencyFails ? 503 : 404 },
      );
    if (url.pathname === '/v1/moderation-decisions/decision') return Response.json({ statement: 'The appeal outcome' });
    expect(url.pathname).toBe('/v1/reports/report');
    return Response.json({ report: { outcome: 'actioned' } });
  });
  const page = await loadInboxPage(client, 'alice', 'Bearer alice-token', 'native-cursor');
  expect(page.next).toBe('native-next');
  expect(page.items[0]).toMatchObject({ unavailable: true, text: '', actorName: 'Bob', unread: true });
  expect(page.items[0]?.href).toBeUndefined();
  expect(page.items[1]?.href).toBe('/moderation/decisions/decision');
  expect(page.items[2]?.href).toBe('/moderation/reports/report');
  const markup = renderToStaticMarkup(createElement(InboxRows, { page }));
  expect(markup).toContain(m.inbox_unavailable_item());
  expect(markup).toContain('The appeal outcome');
  expect(calls).toHaveLength(5);
  dependencyFails = true;
  await expect(loadInboxPage(client, 'alice', 'Bearer alice-token', 'native-cursor')).rejects.toMatchObject({
    failure: { status: 503 },
  });
  malformed = true;
  const before = calls.length;
  await expect(loadInboxPage(client, 'alice', 'Bearer alice-token', 'native-cursor')).rejects.toThrow();
  expect(calls.length - before).toBe(1);
});
