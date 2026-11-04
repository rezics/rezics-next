import { expect, spyOn, test } from 'bun:test';
import { accountProfileEditing, createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { loadAccountRenameRegion } from '../src/settings/account-rename-data';
import type { AccountRenameResult } from '../src/settings/account-rename-actions';
import { AccountRenameRegion, AccountSafetySection } from '../src/settings/account-safety';
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
          editing: accountProfileEditing(accountId, { id: accountId, kind: 'actor' }),
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

test('Preserve native failure guidance while loading account safety preserving native identity and exact recovery bounds', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(10_000);
  let calls = 0;
  const ready: AccountRenameResult = {
    context: { accountId, handle: 'alice', available: true, href: 'https://auth.example.test/account/rename' },
  };
  let resolve!: (value: AccountRenameResult) => void;
  const region = new AccountRenameRegion(() => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  }, accountId);
  let unmount = region.mount();
  try {
    unmount();
    unmount = region.mount(); // Strict Mode effect replay shares the pending read.
    const initial = region.reload();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve({
      context: null,
      failures: [
        { kind: 'failed', status: 503, retryAfter: '2' },
        { kind: 'failed', status: 429, retryAfter: '7' },
      ],
    });
    await initial;
    expect(region.snapshot().retryAt).toBe(17_000);
    clock.mockReturnValue(16_999);
    await region.reload(); // The actual handler enforces the longest real native wait.
    expect(calls).toBe(1);
    clock.mockReturnValue(17_000);
    await Promise.resolve();
    expect(calls).toBe(1); // Expiry performs no IO.
    const explicit = region.reload();
    const coalesced = region.reload();
    expect(explicit).toBe(coalesced);
    expect(region.snapshot()).toEqual({ loading: true, context: null, retryAt: 0 });
    await Promise.resolve();
    expect(calls).toBe(2);
    resolve(ready);
    await explicit;
    expect(region.snapshot().context).toEqual(ready.context);
    const refresh = region.reload();
    expect(region.snapshot().context).toBeNull(); // Remove the old identity/link before awaiting.
    await Promise.resolve();
    unmount(); // An actor or CSRF lifetime change unmounts this keyed region.
    resolve(ready);
    await refresh;
    expect(region.snapshot().context).toBeNull();
    await region.reload();
    expect(calls).toBe(3);
    const nextActor = new AccountRenameRegion(async () => ready, 'another-actor');
    const leaveNext = nextActor.mount();
    await nextActor.reload();
    expect(nextActor.snapshot().context).toBeNull();
    leaveNext();
    const nextCsrf = new AccountRenameRegion(async () => ready, accountId);
    const leaveCsrf = nextCsrf.mount();
    await nextCsrf.reload();
    expect(nextCsrf.snapshot().context).toEqual(ready.context);
    leaveCsrf();
  } finally {
    unmount();
    clock.mockRestore();
  }
});

test('account safety honors HTTP-date waits exactly and never invents a wait for invalid or missing Retry-After', async () => {
  const clock = spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1));
  try {
    for (const retryAfter of [new Date(Date.now() + 60_000).toUTCString(), 'invalid', undefined]) {
      let calls = 0;
      const region = new AccountRenameRegion(async () => {
        calls++;
        return { context: null, failures: [{ kind: 'failed', status: 503, ...(retryAfter ? { retryAfter } : {}) }] };
      }, accountId);
      const leave = region.mount();
      await region.reload();
      const deadline = retryAfter?.endsWith('GMT') ? Date.now() + 60_000 : 0;
      expect(region.snapshot().retryAt).toBe(deadline);
      await region.reload();
      expect(calls).toBe(deadline ? 1 : 2);
      leave();
    }
  } finally {
    clock.mockRestore();
  }
});
