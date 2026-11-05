import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { idempotencyKeyOf } from '../../../services/kernel/src/http/request.ts';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { changeNotifications, changePreferences, loadSettingsPage } from '../src/settings/preferences';

const bound = { D: 1, K: 1, R: 0, A: 0 };
const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
// The stored version grows with every change a person has ever made; the cost must not.
const versions = [1, 1_000, 1_000_000];

function harness(version: number, method: 'GET' | 'POST') {
  const counts = { D: 0, K: 0, R: 0, A: 0 };
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      counts.K += 1;
      const request = new Request(input, init);
      paths.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get('authorization')).toBe('Bearer page-token');
      if (method === 'POST') {
        expect(request.headers.get('idempotency-key')).toBe('"123e4567-e89b-42d3-a456-426614174000"');
        expect(await request.json()).toEqual({ expectedVersion: version, spoilerLevel: 2 });
        return Response.json({ spoilerLevel: 2, suitability: 'blur', version: version + 1 });
      }
      return Response.json({ spoilerLevel: 1, suitability: 'show', version });
    }) as typeof fetch,
  });
  const session = {
    async credential() {
      counts.D += 1;
      return { status: 'active', subject: 'alice', accessToken: 'page-token', csrfToken };
    },
    async signedIn() {
      counts.D += 1;
      return { signedIn: true, subject: 'alice', csrfToken };
    },
  };
  const env = {
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'rezics-web-cost',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => session,
    } as unknown as DurableObjectNamespace<SessionStore>,
  } as Partial<SessionEnv>;
  const request = new Request('https://site.example.test/en/settings', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(method === 'POST' ? { origin: 'https://site.example.test', 'x-csrf-token': csrfToken } : {}),
    },
  });
  return { client, env, request, counts, paths };
}

test('the settings page stays within its bound as the stored version grows', async () => {
  for (const version of versions) {
    const { client, env, request, counts, paths } = harness(version, 'GET');
    const page = await loadSettingsPage(client, request, env);
    expect(page).toEqual({
      signedIn: true,
      accountId: 'alice',
      preferences: { spoilerLevel: 1, suitability: 'show', version },
      securityHref: 'https://auth.example.test/security',
    });
    expect(paths).toEqual(['GET /v1/accounts/alice/preferences']);
    expect(counts).toEqual(bound);
  }
});

test('a settings change is one write however often the settings changed before', async () => {
  for (const version of versions) {
    const { client, env, request, counts, paths } = harness(version, 'POST');
    const result = await changePreferences(client, request, env, {
      expectedVersion: version,
      spoilerLevel: 2,
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
    });
    expect(result).toEqual({ ok: true, preferences: { spoilerLevel: 2, suitability: 'blur', version: version + 1 } });
    expect(paths).toEqual(['PATCH /v1/accounts/alice/preferences']);
    expect(counts).toEqual(bound);
  }
});

test('three repeated loads each cost the same', async () => {
  const seen: unknown[] = [];
  for (let load = 0; load < 3; load += 1) {
    const { client, env, request, counts } = harness(7, 'GET');
    await loadSettingsPage(client, request, env);
    seen.push({ ...counts });
  }
  expect(seen).toEqual([bound, bound, bound]);
});

test('Send Settings command keys in the native Structured Field syntax preserving exact original semantic input, native authority and bounded requests', async () => {
  for (const idempotencyKey of ['123e4567-e89b-42d3-a456-426614174000', '  command "quoted" \\ path  ', '123']) {
    const reading = Object.freeze({ expectedVersion: 9, spoilerLevel: 2 as const, idempotencyKey });
    const notificationChanges = [
      Object.freeze({ expectedVersion: 9, notifications: { reply: false, future_kind: null }, idempotencyKey }),
      Object.freeze({ expectedVersion: 9, notifications: null, idempotencyKey }),
    ];
    const commands = [
      {
        input: reading,
        body: { expectedVersion: 9, spoilerLevel: 2 },
        contentType: 'application/json',
        send: (client: ReturnType<typeof createKernelClient>, request: Request, env: Partial<SessionEnv>) =>
          changePreferences(client, request, env, reading),
      },
      ...notificationChanges.map((change) => ({
        input: change,
        body: { expectedVersion: 9, notifications: change.notifications },
        contentType: 'application/merge-patch+json',
        send: (client: ReturnType<typeof createKernelClient>, request: Request, env: Partial<SessionEnv>) =>
          changeNotifications(client, request, env, change),
      })),
    ];
    for (const command of commands) {
      const original = structuredClone(command.input);
      const calls: Request[] = [];
      const { env, request, counts } = harness(9, 'POST');
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input, init) => {
          counts.K += 1;
          calls.push(new Request(input, init));
          return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
        }) as typeof fetch,
      });
      for (const attempt of [1, 2]) {
        expect(await command.send(client, request.clone(), env)).toMatchObject({ ok: false, reason: 'unavailable' });
        expect(calls).toHaveLength(attempt);
        expect(counts).toEqual({ D: attempt, K: attempt, R: 0, A: 0 });
        const sent = calls[attempt - 1]!;
        expect(sent.method).toBe('PATCH');
        expect(new URL(sent.url).pathname).toBe('/v1/accounts/alice/preferences');
        expect(sent.headers.get('authorization')).toBe('Bearer page-token');
        expect(sent.headers.get('content-type')).toBe(command.contentType);
        expect(idempotencyKeyOf(sent.headers.get('idempotency-key'))).toBe(idempotencyKey);
        expect(await sent.clone().json()).toEqual(command.body);
        expect(command.input).toEqual(original);
      }
      expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
    }
  }
});
