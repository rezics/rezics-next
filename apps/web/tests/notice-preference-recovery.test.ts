import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { NotificationEditor } from '../src/settings/notification-recovery';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import {
  changeNotifications,
  changePreferences,
  loadSettingsPage,
  type NotificationPreferences,
} from '../src/settings/preferences';
import { readingMutation, sendReading } from '../src/settings/reading-preferences';
import { preferenceRetryDeadline } from '../src/settings/preference-failure-retry';
import type { SessionEnv } from '../src/session/client';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadUnreadCount } = await import('../src/inbox/inbox-read');
const { UnreadBadgeView } = await import('../src/inbox/unread-badge');
const { m } = await import('../src/paraglide/messages.js');

const token = 'A'.repeat(22);
const notifications = { reply: true, mention: true, thread_watch: true, board_activity: true };
const initial = settingsPreferencePage(notifications, 7);
const currentDisclosure = { kind: 'current-disclosure' as const, at: '2026-11-04T00:00:00.000Z' };
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
  let current = { notifications: { ...notifications }, version: 7 };
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
        : Response.json({
            spoilerLevel: 1,
            suitability: 'blur',
            ...current,
            page: settingsPreferencePage(current.notifications, current.version),
          });
    expect(request.headers.get('content-type')).toContain('application/merge-patch+json');
    const change = JSON.parse(body) as { expectedVersion: number; notifications: NotificationPreferences | null };
    const original = calls.find((call) => call.method === 'PATCH');
    if (
      original &&
      calls.filter((call) => call.method === 'PATCH').length > 1 &&
      original.key === request.headers.get('idempotency-key')
    ) {
      expect(body).toBe(original.body);
      return Response.json({
        spoilerLevel: 1,
        suitability: 'blur',
        ...receipt,
        page: settingsPreferencePage(receipt.notifications, receipt.version),
      });
    }
    if (change.expectedVersion !== current.version)
      return Response.json(
        { code: 'conflict', page: settingsPreferencePage(current.notifications, current.version) },
        { status: 409 },
      );
    current = {
      version: current.version + 1,
      notifications:
        change.notifications === null ? { ...notifications } : { ...current.notifications, ...change.notifications },
    };
    receipt = current;
    if (lose) {
      lose = false;
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    }
    return Response.json({
      spoilerLevel: 1,
      suitability: 'blur',
      ...current,
      page: settingsPreferencePage(current.notifications, current.version),
    });
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

test('A generic503/deadline/dependency failure renders unavailable with retry rather than inventing a preparing job or resetting settings', async () => {
  for (const [status, code] of [
    [503, undefined],
    [503, 'deadline_exceeded'],
    [503, 'dependency_unavailable'],
    [502, 'dependency_unavailable'],
    [503, 'semantic_not_ready'],
    [503, 'unknown_failure'],
  ] as const) {
    const owner = session();
    const calls: Request[] = [];
    const retryAfter = '30';
    const client = clientWith((request) => {
      calls.push(request);
      expect(new URL(request.url).pathname).toBe('/v1/accounts/alice/preferences');
      expect(request.headers.get('authorization')).toBe('Bearer alice-token');
      return Response.json(
        { code, retryable: true, request_id: 'original-request', detail: 'private diagnostic' },
        { status, headers: { 'retry-after': retryAfter } },
      );
    });
    const failure = {
      status,
      ...(code ? { code } : {}),
      retryable: true,
      requestId: 'original-request',
      retryAfter,
    };
    const page = await loadSettingsPage(client, owner.request(), owner.env);
    expect(page).toEqual({
      signedIn: true,
      accountId: 'alice',
      state: 'unavailable',
      failure,
      securityHref: 'https://auth.example.test/security',
    });
    const reading = { expectedVersion: 7, spoilerLevel: 2 as const, idempotencyKey: crypto.randomUUID() };
    expect(await changePreferences(client, owner.request('POST'), owner.env, reading)).toEqual({
      ok: false,
      reason: 'unavailable',
      failure,
    });
    const notifications = { expectedVersion: 7, notifications: { reply: false }, idempotencyKey: crypto.randomUUID() };
    expect(await changeNotifications(client, owner.request('POST'), owner.env, notifications)).toEqual({
      ok: false,
      reason: 'unavailable',
      failure,
    });
    expect(calls).toHaveLength(3);
    expect(owner.reads()).toBe(3);
    expect(calls[1]!.headers.get('idempotency-key')).toBe(JSON.stringify(reading.idempotencyKey));
    expect(await calls[1]!.json()).toEqual({ expectedVersion: 7, spoilerLevel: 2 });
    expect(calls[2]!.headers.get('idempotency-key')).toBe(JSON.stringify(notifications.idempotencyKey));
    expect(calls[2]!.headers.get('content-type')).toContain('application/merge-patch+json');
    expect(await calls[2]!.json()).toEqual({ expectedVersion: 7, notifications: { reply: false } });
  }
});

test('Closed, conflict, unknown-save and actual explicit readiness states preserve their distinct existing native semantics and drafts', async () => {
  for (const [status, code, reason] of [
    [403, 'platform_closed', 'closed'],
    [401, 'authentication_required', 'forbidden'],
    [403, 'forbidden', 'forbidden'],
    [409, 'conflict', 'conflict'],
    [409, undefined, 'unavailable'],
    [422, 'invalid_request', 'invalid'],
  ] as const) {
    const owner = session();
    const client = clientWith(() => Response.json({ code, request_id: 'native-rejection' }, { status }));
    const change = { expectedVersion: 7, idempotencyKey: crypto.randomUUID() };
    for (const result of [
      await changePreferences(client, owner.request('POST'), owner.env, { ...change, spoilerLevel: 2 }),
      await changeNotifications(client, owner.request('POST'), owner.env, { ...change, notifications: null }),
    ]) {
      expect(result).toMatchObject({ ok: false, reason, failure: { status, requestId: 'native-rejection' } });
    }
  }

  // The native account-preference contract has no explicit preparation response. Readiness from other
  // endpoints is not adopted here; ambiguous writes still keep their immutable original command.
  const owner = session();
  const client = clientWith(() => Response.json({ code: 'deadline_exceeded' }, { status: 503 }));
  const original = readingMutation(
    { spoilerLevel: 1, suitability: 'blur', version: 7 },
    { spoilerLevel: 2, suitability: 'blur' },
  )!;
  const io = {
    save: (input: typeof original) => changePreferences(client, owner.request('POST'), owner.env, input),
    read: () => loadSettingsPage(client, owner.request(), owner.env),
  };
  expect(await sendReading(io, original, false, () => 7)).toMatchObject({ kind: 'uncertain', reason: 'unavailable' });
  expect(await sendReading(io, original, true, () => 7)).toMatchObject({ kind: 'uncertain', reason: 'unavailable' });
  expect(Object.isFrozen(original)).toBe(true);

  const editor = new NotificationEditor(initial, {
    save: (input) => changeNotifications(client, owner.request('POST'), owner.env, input),
    read: () => loadSettingsPage(client, owner.request(), owner.env),
  });
  await editor.edit('reply', false, 7);
  const pending = editor.snapshot().pending;
  await editor.edit('mention', false, 7);
  await editor.retry();
  expect(editor.snapshot()).toMatchObject({
    phase: 'uncertain',
    reason: 'unavailable',
    known: { notifications, version: 7 },
    draft: { reply: false, mention: false },
  });
  expect(editor.snapshot().pending).toBe(pending);
  expect(Object.isFrozen(pending!.input)).toBe(true);
  expect(Object.isFrozen(pending!.input.notifications)).toBe(true);
});

test('malformed bodies and transport loss never confirm a save or supply preference defaults', async () => {
  for (const response of [
    () => new Response('temporarily unavailable', { status: 503 }),
    () => Response.json({ code: 'unknown_failure' }),
    () => Response.json({ spoilerLevel: 3, suitability: 'blur', version: 8, notifications }),
    () => Response.json({ spoilerLevel: 1, suitability: 'show', version: -1, notifications }),
    () => {
      throw new TypeError('network connection lost');
    },
  ]) {
    const owner = session();
    let calls = 0;
    const client = clientWith(() => {
      calls++;
      return response();
    });
    expect(await loadSettingsPage(client, owner.request(), owner.env)).toMatchObject({
      signedIn: true,
      state: 'unavailable',
    });
    const change = { expectedVersion: 7, idempotencyKey: crypto.randomUUID() };
    expect(
      await changePreferences(client, owner.request('POST'), owner.env, { ...change, spoilerLevel: 2 }),
    ).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(
      await changeNotifications(client, owner.request('POST'), owner.env, { ...change, notifications: null }),
    ).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(calls).toBe(3);
  }
  for (const notifications of [{}, { reply: false }, { reply: false, mention: null }]) {
    const owner = session();
    const reading = { spoilerLevel: 2, suitability: 'show', version: 8 };
    const client = clientWith(() => Response.json({ ...reading, notifications }));
    const page = await loadSettingsPage(client, owner.request(), owner.env);
    expect(page).toMatchObject({ preferences: reading });
    expect(page).not.toHaveProperty('notifications');
    expect(
      await changeNotifications(client, owner.request('POST'), owner.env, {
        expectedVersion: 7,
        notifications: null,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toMatchObject({ ok: false, reason: 'unavailable' });
  }
});

test('Retry-After supplies a finite manual retry delay without treating failures as preparation', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  expect(preferenceRetryDeadline('30', now)).toBe(now + 30_000);
  expect(preferenceRetryDeadline('Sat, 31 Oct 2026 00:01:00 GMT', now)).toBe(now + 60_000);
  for (const value of [undefined, '', 'invalid', '-1', '-3000', '0', '1'.repeat(400), 'Fri, 30 Oct 2026 00:00:00 GMT'])
    expect(preferenceRetryDeadline(value, now)).toBe(0);
});

test('a refused Reading CSRF request remains forbidden without reaching the native writer', async () => {
  const owner = session();
  let calls = 0;
  const client = clientWith(() => {
    calls++;
    return Response.json({ spoilerLevel: 2, suitability: 'show', version: 8 });
  });
  expect(
    await changePreferences(client, owner.request('POST', 'B'.repeat(22)), owner.env, {
      expectedVersion: 7,
      spoilerLevel: 2,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toMatchObject({ ok: false, reason: 'forbidden', failure: { status: 403, code: 'forbidden' } });
  expect(calls).toBe(0);
});

test('closed or unavailable recovery reads retain the original notification command, confirmed fields and later draft', async () => {
  for (const [status, code, reason] of [
    [403, 'platform_closed', 'closed'],
    [503, 'deadline_exceeded', 'unavailable'],
  ] as const) {
    const owner = session();
    const calls: { method: string; body: string; key: string | null }[] = [];
    const client = clientWith(async (request) => {
      calls.push({ method: request.method, body: await request.text(), key: request.headers.get('idempotency-key') });
      return request.method === 'GET'
        ? Response.json({ code, retryable: status === 503, request_id: 'readback-request' }, { status })
        : calls.length === 1
          ? Response.json({ code: 'deadline_exceeded' }, { status: 503 })
          : Response.json({
              spoilerLevel: 2,
              suitability: 'show',
              version: 8,
              notifications: { reply: false, mention: true },
              page: settingsPreferencePage({ reply: false, mention: true }, 8),
            });
    });
    const editor = new NotificationEditor(initial, {
      save: (input) => changeNotifications(client, owner.request('POST'), owner.env, input),
      read: () => loadSettingsPage(client, owner.request(), owner.env),
    });
    await editor.edit('reply', false, 7);
    const pending = editor.snapshot().pending;
    await editor.edit('mention', false, 7);
    await editor.retry();
    expect(calls.map(({ method }) => method)).toEqual(['PATCH', 'PATCH', 'GET']);
    expect(calls[1]).toEqual(calls[0]);
    expect(editor.snapshot()).toMatchObject({
      phase: 'uncertain',
      reason,
      known: { notifications, version: 7 },
      draft: { reply: false, mention: false },
      failure: { status, code, requestId: 'readback-request' },
    });
    expect(editor.snapshot().pending).toBe(pending);
  }
});

test('automatic notification readback preserves edits made while the native GET is in flight', async () => {
  let calls = 0;
  let release = () => {};
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const editor = new NotificationEditor(initial, {
    save: async () =>
      ++calls === 1
        ? { ok: false, reason: 'unavailable', failure: { status: 503, code: 'deadline_exceeded' } }
        : {
            ok: true,
            notifications: { reply: false, mention: true },
            version: 8,
            page: settingsPreferencePage({ reply: false, mention: true }, 8),
          },
    read: async () => {
      began();
      await delayed;
      return {
        signedIn: true,
        preferences: { spoilerLevel: 2, suitability: 'show', version: 8 },
        notifications: { reply: false, mention: true },
        page: settingsPreferencePage({ reply: false, mention: true }, 8),
        securityHref: null,
      };
    },
  });
  await editor.edit('reply', false, 7);
  const recovery = editor.retry();
  await started;
  await editor.edit('mention', false, 7);
  release();
  await recovery;
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    known: { version: 8, notifications: { reply: false, mention: true } },
    draft: { reply: false, mention: false },
  });
  expect(calls).toBe(2);
});

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

test('authorization refusal during recovery does not establish the original outcome or discard its input', async () => {
  const sent: string[] = [];
  let count = 0;
  const editor = new NotificationEditor(initial, {
    save: async (input) => {
      sent.push(JSON.stringify(input));
      count += 1;
      return count === 1
        ? { ok: false, reason: 'unavailable' }
        : { ok: false, reason: 'forbidden', failure: { status: 403, code: 'forbidden' } };
    },
    read: async () => {
      throw new Error('A refused replay cannot establish current state');
    },
  });
  await editor.edit('reply', false, 7);
  const pending = editor.snapshot().pending;
  await editor.edit('mention', false, 7);
  await editor.retry();
  expect(editor.snapshot().pending).toBe(pending);
  expect(editor.snapshot()).toMatchObject({ phase: 'uncertain', draft: { reply: false, mention: false } });
  expect(sent[1]).toBe(sent[0]);
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
    expect(markup).toContain('role="img"');
    expect(markup).not.toContain('?');
    expect(data).not.toHaveProperty('count');
    expect(requests).toBe(1);
    expect(owner.reads()).toBe(1);
  }
  const brokenSession = session(true);
  let requests = 0;
  const client = clientWith(() => {
    requests += 1;
    return Response.json({
      count: 0,
      capped: false,
      basis: 'current-visible-unread',
      witness: currentDisclosure,
    });
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
    basis: 'current-visible-unread',
    witness: expect.objectContaining({ kind: 'current-disclosure' }),
  });
  expect(
    renderToStaticMarkup(
      createElement(UnreadBadgeView, {
        data: {
          signedIn: true,
          state: 'ready',
          count: 0,
          capped: false,
          basis: 'current-visible-unread',
          witness: currentDisclosure,
        },
      }),
    ),
  ).toBe('');
});

test('unknown and pending unread counts use the same honest dot while ready counts retain their native value', () => {
  for (const props of [{}, { failed: true }, { data: { signedIn: false } as const, failed: true }]) {
    const markup = renderToStaticMarkup(createElement(UnreadBadgeView, props));
    expect(markup).toContain('role="img"');
    expect(markup).toContain(m.inbox_unread_unavailable());
    expect(markup).not.toMatch(/>[^<]+<|\?/);
  }
  expect(renderToStaticMarkup(createElement(UnreadBadgeView, { data: { signedIn: false } }))).toBe('');
  for (const [count, capped, label] of [
    [3, false, '3'],
    [100, true, '99+'],
  ] as const) {
    const markup = renderToStaticMarkup(
      createElement(UnreadBadgeView, {
        data: {
          signedIn: true,
          state: 'ready',
          count,
          capped,
          basis: 'current-visible-unread',
          witness: currentDisclosure,
        },
      }),
    );
    expect(markup).toContain(m.inbox_unread_count({ count: label }));
    expect(markup).toContain(`>${label}</span>`);
  }
});
