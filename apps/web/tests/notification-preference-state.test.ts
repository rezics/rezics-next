import { expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { withPlatformClosedRecognition } from '../src/kernel/platform-closed';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import {
  changeNotifications,
  loadSettingsPage,
  optionalNotifications,
  type NotificationChange,
  type NotificationPreferences,
  type PreferencePage,
  type NotificationWriteResult,
  type SettingsPage,
} from '../src/settings/preferences';
import { NotificationEditor } from '../src/settings/notification-recovery';

mock.module('cloudflare:workers', () => ({ env: {} }));

const csrfToken = 'A'.repeat(22);
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const reading = { spoilerLevel: 1, suitability: 'blur', version: 7, shelf: {} };
const optional = { reply: true, mention: true, thread_watch: true, board_activity: true };
const page = settingsPreferencePage(optional, 7);
const advice = {
  viewerState: 'current',
  allowedActions: { read: { allowed: true }, update: { allowed: true } },
  reading: {
    supported: { spoilerLevels: [0, 1, 2], suitability: ['blur', 'show'] },
    effective: { spoilerLevel: 1, suitability: 'blur' },
    defaults: { spoilerLevel: 0, suitability: 'blur' },
  },
};

function accountEnvelope(notifications: NotificationPreferences, version: number, writable = true) {
  const currentPage = settingsPreferencePage(notifications, version);
  return {
    spoilerLevel: 1,
    suitability: 'blur',
    shelf: {},
    notifications,
    version,
    page: writable ? currentPage : { ...currentPage, actions: [] },
    viewerState: 'current',
    allowedActions: {
      read: { allowed: true },
      update: writable ? { allowed: true } : { allowed: false, reason: 'not_authorized' },
    },
    reading: advice.reading,
  };
}

const envelope = accountEnvelope(optional, 7);

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

test('Settings keeps owner-supplied optional kinds and writes only the submitted merge patch', async () => {
  const read = harness(() => Response.json(envelope));
  expect(await loadSettingsPage(read.client, read.request, read.env)).toEqual({
    signedIn: true,
    accountId: 'alice',
    preferences: { ...reading, advice },
    notifications: optional,
    page,
    securityHref: 'https://auth.example.test/security',
  });
  expect(read.calls).toHaveLength(1);
  expect(read.sessionReads()).toBe(1);

  const next = settingsPreferencePage({ ...optional, reply: false }, 8);
  const saved = { ...optional, reply: false };
  const write = harness(() => Response.json(accountEnvelope(saved, 8)), 'POST');
  expect(
    await changeNotifications(write.client, write.request, write.env, {
      expectedVersion: 7,
      notifications: { reply: false },
      idempotencyKey,
    }),
  ).toEqual({ ok: true, notifications: optionalNotifications(next), version: 8, page: next });
  expect(write.calls).toHaveLength(1);
  expect(write.sessionReads()).toBe(1);
  expect(write.calls[0]!.method).toBe('PATCH');
  expect(write.calls[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
  expect(write.calls[0]!.headers.get('content-type')).toContain('application/merge-patch+json');
  expect(await write.calls[0]!.json()).toEqual({ expectedVersion: 7, notifications: { reply: false } });
});

test('missing pages and malformed maps never become enabled controls or a confirmed save', async () => {
  for (const body of [
    { ...reading, notifications: optional },
    { ...reading, notifications: null, page: { version: 7, kinds: [], actions: [] } },
    {
      ...reading,
      page: {
        version: 7,
        kinds: [{ kind: 'moderation_decision', optional: false, default: true, enabled: false }],
        actions: [],
      },
    },
    { ...accountEnvelope(optional, 7), viewerState: 'retired' },
    { ...accountEnvelope(optional, 7), page: { ...page, actions: [] } },
  ]) {
    const read = harness(() => Response.json(body));
    const result = await loadSettingsPage(read.client, read.request, read.env);
    expect(result).toMatchObject({
      signedIn: true,
      accountId: 'alice',
      preferences: reading,
      securityHref: 'https://auth.example.test/security',
    });
    expect(result.signedIn && 'page' in result ? result.page : undefined).toBeUndefined();
    expect(result.signedIn && 'notifications' in result ? result.notifications : undefined).toBeUndefined();
    const write = harness(() => Response.json(body), 'POST');
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

test('a readable account with denied update keeps confirmed values and receives no edit or reset actions', async () => {
  const read = harness(() => Response.json(accountEnvelope(optional, 7, false)));
  expect(await loadSettingsPage(read.client, read.request, read.env)).toMatchObject({
    signedIn: true,
    preferences: { version: 7, advice: { viewerState: 'current', allowedActions: { update: { allowed: false } } } },
    notifications: optional,
    page: { version: 7, kinds: page.kinds, actions: [] },
  });
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

test('compulsory and unknown kinds never become edits; missing actions refuse write and reset', async () => {
  const gated: PreferencePage = {
    ...page,
    actions: [{ name: 'edit', expectedVersion: 7 }],
  };
  const transport = harness(() => Response.json({ ...envelope, page: gated }), 'POST');
  const editor = new NotificationEditor(gated, {
    save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
    read: () => loadSettingsPage(transport.client, transport.request, transport.env),
  });
  await editor.edit('moderation_decision', false, 7);
  await editor.edit('unknown', false, 7);
  await editor.restore(7);
  expect(transport.calls).toHaveLength(0);
  expect(editor.snapshot().draft).toEqual(optional);
  expect(editor.snapshot().intent).toBeUndefined();

  const locked: PreferencePage = {
    ...settingsPreferencePage({ ...optional, reply: true }, 7),
    actions: [],
  };
  const idle = new NotificationEditor(locked, {
    save: async () => {
      throw new Error('unadmitted write');
    },
    read: async () => ({ signedIn: false }),
  });
  await idle.edit('reply', false, 7);
  await idle.restore(7);
  expect(idle.snapshot().draft.reply).toBe(true);
  expect(idle.snapshot().intent).toBeUndefined();
});

test('a definite notification refusal guards row autosave, Restore and Reload until the native deadline', async () => {
  for (const retryAfter of ['30', 'Sat, 31 Oct 2026 00:00:30 GMT']) {
    let now = Date.parse('2026-10-31T00:00:00Z');
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let refused = true;
      const next = settingsPreferencePage({ ...optional, reply: false }, 8);
      const transport = harness(
        () =>
          refused
            ? Response.json(
                { code: 'invalid_request', retryable: false, request_id: 'native-refusal', detail: 'private' },
                { status: 422, headers: { 'retry-after': retryAfter } },
              )
            : Response.json(accountEnvelope({ ...optional, reply: false }, 8)),
        'POST',
      );
      const editor = new NotificationEditor(page, {
        save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
        read: () => loadSettingsPage(transport.client, transport.request, transport.env),
      });
      await editor.edit('reply', false, 7);
      const failed = editor.snapshot();
      expect(failed).toMatchObject({
        phase: 'failed',
        pending: null,
        draft: { ...optional, reply: false },
        commandRetryAt: now + 30_000,
        commandFailure: { status: 422, code: 'invalid_request', retryAfter, requestId: 'native-refusal' },
      });
      await editor.edit('mention', false, 7);
      await editor.restore(7);
      await editor.submit(7);
      await editor.retry();
      await editor.reload();
      const retryDeadline = now + 30_000;
      const readFailed = editor.snapshot();
      expect(readFailed).toMatchObject({
        phase: 'failed',
        currentAdvice: null,
        readOrigin: 'review',
        readReason: 'unavailable',
        readFailure: { status: 422, retryAfter },
        readRetryAt: retryDeadline,
        commandRetryAt: retryDeadline,
      });
      expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'GET']);
      now += 29_999;
      await editor.edit('thread_watch', false, 7);
      await editor.restore(7);
      await editor.reload();
      expect(editor.snapshot()).toMatchObject({
        draft: { ...optional, reply: false, thread_watch: false },
        intent: { reply: false, thread_watch: false },
        currentAdvice: null,
        readRetryAt: retryDeadline,
        commandRetryAt: retryDeadline,
      });
      now++;
      await Promise.resolve();
      expect(transport.calls).toHaveLength(2);
      refused = false;
      await editor.reload();
      await editor.submit(8);
      expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'GET', 'GET', 'PATCH']);
      expect(transport.sessionReads()).toBe(4);
      expect(transport.calls[3]!.headers.get('idempotency-key')).not.toBe(
        transport.calls[0]!.headers.get('idempotency-key'),
      );
      expect(await transport.calls[3]!.json()).toEqual({
        expectedVersion: 8,
        notifications: { reply: false, thread_watch: false },
      });
      expect(editor.snapshot()).toMatchObject({
        phase: 'saved',
        draft: { ...optional, reply: false },
      });
    } finally {
      clock.mockRestore();
    }
  }
});

test('delayed original and recovery reads preserve local drafts, exact replay and deliberate review actions', async () => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const receiptNotifications = { ...optional, reply: false };
    const receipt = accountEnvelope(receiptNotifications, 8);
    const currentNotifications = { ...optional, reply: false, mention: false, thread_watch: false };
    let step = 0;
    const transport = harness(() => {
      step++;
      if (step === 1)
        return Response.json(
          { code: 'dependency_unavailable', retryable: true, request_id: `native-${step}` },
          { status: 503, headers: { 'retry-after': '30' } },
        );
      if (step === 2) return Response.json(receipt);
      if (step === 3)
        return Response.json(
          { code: 'platform_closed', retryable: false, request_id: `native-${step}` },
          { status: 403, headers: { 'retry-after': '20' } },
        );
      return Response.json(accountEnvelope(currentNotifications, step === 4 ? 10 : 11));
    }, 'POST');
    const confirmed: number[] = [];
    const editor = new NotificationEditor(page, {
      save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
      read: () => loadSettingsPage(transport.client, transport.request, transport.env),
      confirmed: (version) => confirmed.push(version),
    });
    await editor.edit('reply', false, 7);
    const pending = editor.snapshot().pending;
    now += 10_000;
    await editor.edit('mention', false, 7);
    await editor.restore(7);
    await editor.submit(7);
    await editor.retry();
    expect(transport.calls).toHaveLength(1);
    expect(editor.snapshot().commandRetryAt).toBe(now + 20_000);
    expect(editor.snapshot().pending).toBe(pending);
    now += 20_000;
    expect(transport.calls).toHaveLength(1);
    await editor.retry();
    expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET']);
    expect(editor.snapshot()).toMatchObject({
      phase: 'failed',
      known: { notifications: optional, version: 7 },
      draft: { ...optional, reply: false, mention: false },
      readReason: 'closed',
      readFailure: { status: 403, code: 'platform_closed', retryAfter: '20', requestId: 'native-3' },
    });
    expect(editor.snapshot().currentAdvice).toBeNull();
    expect(editor.snapshot().readRetryAt).toBe(now + 20_000);
    expect(editor.snapshot()).toMatchObject({
      commandRetryAt: 0,
      pending: null,
      confirmedReceipt: { attempt: { input: pending!.input }, receipt: { notifications: receiptNotifications, version: 8 } },
    });
    expect(confirmed).toEqual([]);
    await editor.edit('thread_watch', false, 7);
    await editor.edit('thread_watch', true, 7);
    await editor.retry();
    await editor.restore(7);
    await editor.reload();
    expect(transport.calls).toHaveLength(3);
    now += 20_000;
    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      known: { notifications: currentNotifications, version: 10 },
      pending: null,
      confirmedReceipt: null,
      draft: { ...currentNotifications, thread_watch: true },
      intent: { mention: false, thread_watch: true },
    });
    expect(transport.calls.map((call) => call.method)).toEqual(['PATCH', 'PATCH', 'GET', 'GET']);
    expect(transport.calls[1]!.headers.get('idempotency-key')).toBe(transport.calls[0]!.headers.get('idempotency-key'));
    expect(await transport.calls[1]!.clone().text()).toBe(await transport.calls[0]!.clone().text());
    await editor.edit('thread_watch', false, 9);
    await editor.submit(9);
    expect(await transport.calls[4]!.json()).toEqual({
      expectedVersion: 10,
      notifications: { mention: false, thread_watch: false },
    });
    expect(transport.calls[4]!.headers.get('idempotency-key')).not.toBe(
      transport.calls[0]!.headers.get('idempotency-key'),
    );
    expect(transport.calls.map((call) => call.method)).toEqual([
      'PATCH',
      'PATCH',
      'GET',
      'GET',
      'PATCH',
    ]);
    expect(transport.sessionReads()).toBe(5);
    expect(confirmed).toEqual([10, 11]);
    expect(editor.snapshot()).toMatchObject({
      phase: 'saved',
      draft: { ...optional, reply: false, mention: false, thread_watch: false },
      known: { version: 11 },
    });
  } finally {
    clock.mockRestore();
  }
});

test('a shorter current-read refusal keeps the original wait and current advice can only restrict its replay', async () => {
  let now = Date.parse('2026-10-31T00:00:00Z');
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const settings = (notifications: NotificationPreferences, version: number, writable = true): SettingsPage => {
      const nativePage = settingsPreferencePage(notifications, version);
      const currentPage = writable ? nativePage : { ...nativePage, actions: [] };
      return {
        signedIn: true,
        preferences: { spoilerLevel: 1, suitability: 'blur', version },
        notifications: optionalNotifications(currentPage),
        page: currentPage,
        securityHref: null,
      };
    };
    const writes: NotificationChange[] = [];
    let reads = 0;
    const saved = { ...optional, reply: false };
    const editor = new NotificationEditor(page, {
      save: async (input) => {
        writes.push(input);
        return writes.length === 1
          ? {
              ok: false,
              reason: 'unavailable',
              failure: { status: 503, code: 'dependency_unavailable', retryAfter: '120' },
            }
          : { ok: true, notifications: saved, version: 8, page: settingsPreferencePage(saved, 8) };
      },
      read: async () => {
        reads++;
        if (reads === 1)
          return {
            signedIn: true,
            state: 'unavailable',
            failure: { status: 403, code: 'forbidden', retryable: false, retryAfter: '20' },
            securityHref: null,
          };
        if (reads === 4) return settings(saved, 8);
        return settings(optional, 7, reads !== 2);
      },
    });
    await editor.edit('reply', false, 7);
    const pending = editor.snapshot().pending!;
    const original = pending.input;
    const commandDeadline = Date.parse('2026-10-31T00:00:00Z') + 120_000;
    const retryFromRetainedCallback = () => editor.retry();
    expect(editor.snapshot().commandRetryAt).toBe(commandDeadline);
    await retryFromRetainedCallback();
    expect(writes).toHaveLength(1);

    await editor.reload();
    expect(editor.snapshot()).toMatchObject({
      phase: 'uncertain',
      currentAdvice: null,
      pending,
      confirmedReceipt: null,
      readReason: 'forbidden',
      readRetryAt: now + 20_000,
      commandRetryAt: commandDeadline,
    });
    await editor.edit('mention', false, 7);
    expect(editor.snapshot().pending?.input).toBe(original);
    expect(editor.snapshot().commandRetryAt).toBe(commandDeadline);
    expect(editor.snapshot().readRetryAt).toBe(now + 20_000);
    await retryFromRetainedCallback();
    await editor.reload();
    expect(reads).toBe(1);

    now += 19_999;
    await editor.reload();
    expect(reads).toBe(1);
    now++;
    await editor.reload();
    expect(reads).toBe(2);
    expect(editor.snapshot()).toMatchObject({ phase: 'review', pending, known: { version: 7 } });
    expect(editor.snapshot().currentAdvice?.actions).toEqual([]);
    expect(editor.snapshot().commandRetryAt).toBe(commandDeadline);

    now += 100_000;
    await retryFromRetainedCallback();
    expect(writes).toHaveLength(1);
    expect(editor.snapshot().pending?.input).toBe(original);
    await editor.reload();
    expect(reads).toBe(3);
    expect(editor.snapshot().currentAdvice?.actions).toHaveLength(2);
    expect(editor.snapshot().commandRetryAt).toBe(commandDeadline);
    await retryFromRetainedCallback();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toBe(original);
    expect(editor.snapshot()).toMatchObject({
      phase: 'review',
      pending: null,
      known: { version: 8, notifications: saved },
      draft: { ...optional, reply: false, mention: false },
    });
    expect(reads).toBe(4);
  } finally {
    clock.mockRestore();
  }
});

test('disposal clears retained notification state and ignores late reads, writes and callbacks', async () => {
  let current = true;
  const fenced = new NotificationEditor(
    page,
    { save: async () => ({ ok: false, reason: 'unavailable' }), read: async () => ({ signedIn: false }) },
    false,
    () => 7,
    () => current,
    () => current,
  );
  let invalidations = 0;
  fenced.subscribe(() => invalidations++);
  const retainedSessionCallback = () => fenced.retry();
  current = false;
  await retainedSessionCallback();
  expect(fenced.snapshot()).toMatchObject({ currentAdvice: null, pending: null, known: { notifications: {} } });
  expect(invalidations).toBe(1);

  let finishWrite!: (result: NotificationWriteResult) => void;
  const writes: NotificationChange[] = [];
  const writer = new NotificationEditor(page, {
    save: (input) => {
      writes.push(input);
      return new Promise<NotificationWriteResult>((resolve) => {
        finishWrite = resolve;
      });
    },
    read: async () => ({ signedIn: false }),
  });
  const saving = writer.edit('reply', false, 7);
  const retainedRetry = () => writer.retry();
  writer.dispose();
  expect(writer.snapshot()).toMatchObject({
    currentAdvice: null,
    pending: null,
    intent: undefined,
    known: { notifications: {} },
    draft: {},
  });
  finishWrite({
    ok: true,
    notifications: { ...optional, reply: false },
    version: 8,
    page: settingsPreferencePage({ ...optional, reply: false }, 8),
  });
  await saving;
  await retainedRetry();
  expect(writer.snapshot()).toMatchObject({ currentAdvice: null, pending: null, known: { notifications: {} } });
  expect(writes).toHaveLength(1);

  let finishRead!: (result: SettingsPage) => void;
  let reads = 0;
  const reader = new NotificationEditor(page, {
    save: async () => ({ ok: false, reason: 'unavailable' }),
    read: () => {
      reads++;
      return new Promise<SettingsPage>((resolve) => {
        finishRead = resolve;
      });
    },
  });
  const reloading = reader.reload();
  const retainedReload = () => reader.reload();
  reader.dispose();
  finishRead({ signedIn: false });
  await reloading;
  await retainedReload();
  expect(reads).toBe(1);
  expect(reader.snapshot()).toMatchObject({ currentAdvice: null, known: { notifications: {} }, draft: {} });
});

test('conflict returns the current page, prunes forbidden kinds and keeps a still-valid draft for review', async () => {
  const extra: PreferencePage = {
    version: 7,
    kinds: [...page.kinds, { kind: 'legacy_digest', optional: true, default: false, enabled: false }],
    actions: page.actions,
  };
  const current = settingsPreferencePage({ ...optional, mention: false }, 8);
  const transport = harness(
    () => Response.json({ code: 'conflict', page: current }, { status: 409, headers: { 'retry-after': '30' } }),
    'POST',
  );
  const editor = new NotificationEditor(extra, {
    save: (input) => changeNotifications(transport.client, transport.request, transport.env, input),
    read: () => loadSettingsPage(transport.client, transport.request, transport.env),
  });
  expect(editor.snapshot().draft.legacy_digest).toBe(false);
  await editor.edit('reply', false, 7);
  expect(editor.snapshot()).toMatchObject({
    phase: 'review',
    pending: null,
    known: { version: 8, notifications: { ...optional, mention: false } },
    draft: { ...optional, reply: false, mention: true },
  });
  expect(editor.snapshot().draft.legacy_digest).toBeUndefined();
  expect(editor.snapshot().intent).toEqual({ reply: false });
  editor.useCurrent();
  expect(editor.snapshot()).toMatchObject({ phase: 'idle', draft: { ...optional, mention: false } });
  expect(transport.calls.map((call) => call.method)).toEqual(['PATCH']);
  expect(transport.sessionReads()).toBe(1);
});
