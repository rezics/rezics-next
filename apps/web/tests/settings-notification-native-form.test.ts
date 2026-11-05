import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import type { SessionEnv } from '../src/session/client';

const token = 'A'.repeat(22);
const key = '123e4567-e89b-42d3-a456-426614174000';
const calls: Request[] = [];
let respond: (request: Request) => Response = () => new Response(null, { status: 503 });
const client = createKernelClient('https://kernel.example.test', {
  fetch: (async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return respond(request);
  }) as typeof fetch,
});
const env = {
  SITE_ORIGINS: 'https://site.example.test',
  AUTH_ISSUER: 'https://auth.example.test',
  API_RESOURCE: 'https://api.rezics.test',
  WEBSITE_SCOPES: 'openid account:read account:update',
  WEBSITE_CLIENT_ID: 'notification-form',
  WEBSITE_CLIENT_KEY: 'unused-by-this-read',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => ({
        status: 'active',
        subject: 'alice',
        accessToken: 'alice-token',
        csrfToken: token,
      }),
    }),
  },
} as unknown as Partial<SessionEnv>;
mock.module('cloudflare:workers', () => ({ env }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => client }));
const { submitNotificationForm } = await import('../src/settings/actions.server');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

function native(version: number, writable = true, includeDigest = false) {
  return {
    spoilerLevel: 1,
    suitability: 'blur',
    shelf: {},
    version,
    status: 200,
    notifications: { reply: false },
    viewerState: 'current',
    allowedActions: {
      read: { allowed: true },
      update: writable ? { allowed: true } : { allowed: false, reason: 'not_authorized' },
    },
    reading: {
      supported: { spoilerLevels: [0, 1, 2], suitability: ['blur', 'show'] },
      effective: { spoilerLevel: 1, suitability: 'blur' },
      defaults: { spoilerLevel: 0, suitability: 'blur' },
    },
    page: {
      version,
      kinds: [
        { kind: 'reply', optional: true, default: true, enabled: false },
        ...(includeDigest ? [{ kind: 'digest', optional: true, default: false, enabled: false }] : []),
        { kind: 'moderation_decision', optional: false, default: true, enabled: true },
      ],
      actions: writable ? [{ name: 'edit', expectedVersion: version }] : [],
    },
  };
}

function post(form: URLSearchParams) {
  return submitNotificationForm(
    new Request('https://site.example.test/en/settings', {
      method: 'POST',
      body: form,
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}`, origin: 'https://site.example.test' },
    }),
  );
}
function original(mode: string, notifications = { reply: false } as Record<string, boolean | null>) {
  return new URLSearchParams({
    csrf_token: token,
    expectedVersion: '7',
    action: 'save',
    notificationRecovery: mode,
    idempotencyKey: key,
    notificationPatch: JSON.stringify(notifications),
    notificationStep: 'read',
  });
}
async function recovery(response: Response) {
  const window = new Window();
  window.document.body.innerHTML = await response.text();
  const form = new URLSearchParams(
    [...window.document.querySelectorAll<HTMLInputElement>('input')].map((input) => [input.name, input.value]),
  );
  const send = window.document.querySelector<HTMLButtonElement>('button[value="send"]');
  return { form, send, text: window.document.body.textContent };
}

test('form review retains every choice across missing kinds and denied advice before a deliberate whole-patch save', async () => {
  calls.length = 0;
  const patch = { reply: false, digest: null };
  let current = native(9);
  respond = () => Response.json(current);
  let result = await recovery(await post(original('review', patch)));
  expect(result.send?.disabled).toBe(true);
  expect(result.form.get('notificationPatch')).toBe(JSON.stringify(patch));
  expect(result.form.get('idempotencyKey')).toBe(key);
  current = native(10, false, true);
  result = await recovery(await post(result.form));
  expect(result.send?.disabled).toBe(true);
  expect(result.form.get('notificationPatch')).toBe(JSON.stringify(patch));
  current = native(11, true, true);
  result = await recovery(await post(result.form));
  expect(result.send?.disabled).toBe(false);
  expect(result.form.get('expectedVersion')).toBe('11');
  expect(result.form.get('idempotencyKey')).not.toBe(key);
  result.form.set('notificationStep', 'send');
  expect((await post(result.form)).status).toBe(303);
  const writes = calls.filter((call) => call.method === 'PATCH');
  expect(writes).toHaveLength(1);
  expect(await writes[0]!.json()).toEqual({ expectedVersion: 11, notifications: patch });
});

test('failed current reads preserve the exact original; an acknowledged replay recovers reads without another write', async () => {
  calls.length = 0;
  respond = () => Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  let result = await recovery(await post(original('retry')));
  expect(result.send?.disabled).toBe(true);
  expect(result.form.get('idempotencyKey')).toBe(key);
  expect(result.form.get('expectedVersion')).toBe('7');
  let reads = 0;
  respond = (request) =>
    request.method === 'PATCH' || ++reads === 1
      ? Response.json(native(9))
      : Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  result.form.set('notificationStep', 'send');
  result = await recovery(await post(result.form));
  expect(result.text).toContain('Saved');
  expect(result.send).toBeNull();
  expect(result.form.get('notificationRecovery')).toBe('confirmed');
  expect(result.form.get('confirmedVersion')).toBe('9');
  const write = calls.find((call) => call.method === 'PATCH')!;
  expect(write.headers.get('authorization')).toBe('Bearer alice-token');
  expect(write.headers.get('idempotency-key')).toBe(JSON.stringify(key));
  expect(await write.json()).toEqual({ expectedVersion: 7, notifications: { reply: false } });
  result.form.set('notificationStep', 'send');
  result = await recovery(await post(result.form));
  expect(result.send).toBeNull();
  respond = () => Response.json(native(10));
  expect((await post(result.form)).status).toBe(303);
  expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
});
