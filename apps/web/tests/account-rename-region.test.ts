import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadAccountRenameRegion } from '../src/settings/account-rename-data';
import { AccountSafetySection } from '../src/settings/account-safety';
import { loadSettingsPage } from '../src/settings/preferences';

const accountId = '123e4567-e89b-42d3-a456-426614174000';
const csrfToken = 'A'.repeat(22);
const origin = 'https://site.example.test';

test('ordinary settings and recovery stay GET-only while the isolated rename read uses current session authority', async () => {
  const calls: string[] = [];
  let sessions = 0;
  let admitted = true;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      expect(request.headers.get('authorization')).toBe('Bearer current-token');
      if (path.endsWith('/preferences')) return Response.json({ spoilerLevel: 0, suitability: 'blur', version: 7 });
      expect(request.headers.get('cache-control')).toBe('no-store');
      if (path.endsWith('/profile'))
        return Response.json({
          profile: {
            id: accountId,
            kind: 'actor',
            handle: null,
            displayName: null,
            bio: null,
            links: [],
            avatar: null,
            publicViews: { posts: true, reviews: true, collections: true, realms: true },
          },
        });
      expect(path).toBe('/v1/viewerActions');
      expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({ resources: [{ type: 'access.account', id: accountId }] });
      return Response.json({
        resources: [
          {
            type: 'access.account',
            id: accountId,
            viewerActions: admitted ? [{ action: 'account:update', operations: ['account.update'] }] : [],
          },
        ],
      });
    }) as typeof fetch,
  });
  const sessionEnv: Partial<SessionEnv> = {
    SITE_ORIGINS: origin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read account:update',
    WEBSITE_CLIENT_ID: 'rezics-web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        async credential() {
          sessions += 1;
          return { status: 'active', subject: accountId, accessToken: 'current-token', csrfToken };
        },
      }),
    } as unknown as DurableObjectNamespace<SessionStore>,
  };
  const request = (method: 'GET' | 'POST', suppliedOrigin = origin) =>
    new Request(`${origin}/en/settings`, {
      method,
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        ...(method === 'POST' ? { origin: suppliedOrigin, 'x-csrf-token': csrfToken } : {}),
      },
    });
  for (let read = 0; read < 2; read += 1) await loadSettingsPage(client, request('GET'), sessionEnv);
  expect(calls).toEqual(Array(2).fill(`GET /v1/accounts/${accountId}/preferences`));
  expect(sessions).toBe(2);
  calls.length = 0;
  expect(await loadAccountRenameRegion(client, request('POST'), sessionEnv)).toEqual({
    accountId,
    handle: null,
    available: true,
  });
  expect(calls.sort()).toEqual([`GET /v1/accounts/${accountId}/profile`, 'POST /v1/viewerActions']);
  expect(sessions).toBe(3);
  admitted = false;
  calls.length = 0;
  expect((await loadAccountRenameRegion(client, request('POST'), sessionEnv))?.available).toBe(false);
  expect(calls).toHaveLength(2);
  expect(sessions).toBe(4);
  calls.length = 0;
  await expect(
    loadAccountRenameRegion(client, request('POST', 'https://foreign.example.test'), sessionEnv),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
  expect(sessions).toBe(4);
});

test('account safety server render starts loading without treating a historical response as current capability', () => {
  const html = renderToStaticMarkup(
    createElement(AccountSafetySection, {
      state: 'signed-in',
      securityHref: 'https://auth.example.test/security',
      csrfToken,
      onReload() {},
      renameAccount: { accountId, handle: 'old', available: true },
    }),
  );
  expect(html).toContain('role="status"');
  expect(html).not.toContain('/account/rename');
  expect(html).not.toContain('@old');
  expect(html).not.toContain('current-token');
});
