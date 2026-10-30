import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { changePreferences, loadSettingsPage } from '../src/settings/preferences';

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
        expect(request.headers.get('idempotency-key')).toBe('123e4567-e89b-42d3-a456-426614174000');
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
