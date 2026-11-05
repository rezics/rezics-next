import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AccountSafetyCard } from '../src/settings/account-safety';
import { accountSafetyLinks, securityHrefFromIssuer } from '../src/settings/account-safety-links';
import { SectionsNavigation, settingsSections } from '../src/settings/sections-navigation';
import { csrfTokenFromRequest, csrfTokenMatches, isAllowedSiteOrigin, newCsrfToken } from '../src/session/csrf';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import { loadSettingsPage } from '../src/settings/preferences';

const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]!);
const account = (securityHref: string | null, csrfToken: string | null = newCsrfToken()) =>
  renderToStaticMarkup(
    createElement(AccountSafetyCard, { state: 'signed-in', securityHref, csrfToken, onReload() {} }),
  );

test('Phone and desktop users can navigate directly to every available settings section with truthful loading and admission states', () => {
  const sections = settingsSections({ notifications: true, collections: true, verification: true });
  const html = renderToStaticMarkup(createElement(SectionsNavigation, { sections }));
  expect(hrefs(html)).toEqual([
    '#reading',
    '#watches',
    '#notifications',
    '#privacy',
    '#verification',
    '#profile',
    '#public-activity',
    '#account',
  ]);
  // The same ordinary anchors are present at both widths, before JavaScript handles any click.
  expect(html).not.toContain('hidden');
  expect(html).not.toContain('role="tab"');
  expect(html).not.toContain('role="menu"');
  const closed = settingsSections({
    notifications: false,
    collections: false,
    verification: false,
    readingState: 'closed',
  });
  const pending = renderToStaticMarkup(createElement(SectionsNavigation, { sections: closed, pending: true }));
  expect(hrefs(pending)).toEqual(['#reading', '#watches', '#profile', '#public-activity', '#account']);
  expect(pending).toContain('role="status"');
  expect(closed[0]?.status).toBeTruthy();
  for (const readingState of ['preparing', 'unavailable'] as const) {
    const available = settingsSections({ notifications: false, collections: false, verification: false, readingState });
    expect(available[0]?.status).toBeTruthy();
    expect(available[0]?.status).not.toBe(closed[0]?.status);
    expect(hrefs(renderToStaticMarkup(createElement(SectionsNavigation, { sections: available })))).toContain(
      '#account',
    );
  }
});

test('Account safety uses the configured Auth security and account-delete pages and never fabricates deletion completion', () => {
  const security = securityHrefFromIssuer('https://accounts.example.test:8443/oidc');
  expect(security).toBe('https://accounts.example.test:8443/security');
  const html = account(security);
  expect(hrefs(html)).toEqual([
    'https://accounts.example.test:8443/security',
    'https://accounts.example.test:8443/account/delete',
  ]);
  expect([...html.matchAll(/<form\b[^>]*action="([^"]*)"/g)].map((match) => match[1])).toEqual(['/auth/sign-out']);
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('account:delete');
  expect(html).not.toContain('access_token');
});

test.each([
  undefined,
  '',
  'not a URL',
  '//untrusted.example',
  'http://auth.example.test',
  'javascript:alert(1)',
  'ftp://auth.example.test',
  'https://user:password@auth.example.test',
  'https://auth.example.test?return_to=https://untrusted.example',
  'https://auth.example.test#fragment',
])('unusable issuer %s leaves security and deletion unavailable', (issuer) => {
  const security = securityHrefFromIssuer(issuer);
  expect(security).toBeNull();
  const html = account(security);
  expect(hrefs(html)).toEqual([]);
  expect(html).toContain('role="status"');
  expect(html).toContain('action="/auth/sign-out"');
});

test('only the configured security page can supply the deletion origin; the BFF loopback exception stays local', () => {
  expect(accountSafetyLinks('https://accounts.example.test/security?return_to=https://untrusted.example')).toBeNull();
  expect(accountSafetyLinks('https://accounts.example.test/other')).toBeNull();
  expect(accountSafetyLinks('http://auth.example.test/security')).toBeNull();
  expect(accountSafetyLinks('/security')).toBeNull();
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const security = securityHrefFromIssuer(`http://${host}:3001/auth`);
    expect(accountSafetyLinks(security)?.deletion).toBe(`http://${host}:3001/account/delete`);
  }
  expect(securityHrefFromIssuer('http://localhost.untrusted.example')).toBeNull();
});

test('Sign out remains a CSRF-protected POST and unavailable Auth configuration is visible without an invented destination', async () => {
  const token = newCsrfToken();
  const html = account(null, token);
  expect(html).toContain('method="post"');
  expect(html).toContain('action="/auth/sign-out"');
  expect(html).toContain(`name="csrf_token" value="${token}"`);
  expect(hrefs(html)).toEqual([]);
  const request = new Request('https://web.example.test/auth/sign-out', {
    method: 'POST',
    headers: { origin: 'https://web.example.test' },
    body: new URLSearchParams({ csrf_token: token }),
  });
  expect(csrfTokenMatches(token, await csrfTokenFromRequest(request))).toBe(true);
  expect(csrfTokenMatches(token, null)).toBe(false);
  expect(csrfTokenMatches(token, newCsrfToken())).toBe(false);
  expect(isAllowedSiteOrigin(request, request.headers.get('origin'), 'https://web.example.test')).toBe(true);
  expect(isAllowedSiteOrigin(request, 'https://untrusted.example', 'https://web.example.test')).toBe(false);
  const missingCsrf = account('https://accounts.example.test/security', null);
  expect(missingCsrf).toMatch(/<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/);
  expect(missingCsrf).toContain('aria-describedby=');
  // A missing website CSRF token cannot disable navigation to Auth's own fresh-auth flows.
  expect(hrefs(missingCsrf)).toHaveLength(2);
});

test('signed-out entry uses the existing sign-in and return-to flow without exposing account actions', () => {
  const html = renderToStaticMarkup(
    createElement(AccountSafetyCard, { state: 'signed-out', returnTo: '/fr/settings#account' }),
  );
  expect(hrefs(html)).toEqual(['/auth/sign-in?return_to=%2Ffr%2Fsettings%23account']);
  expect(html).not.toContain('<form');
  expect(html).not.toContain('/account/delete');
});

test('the signed-out Settings account journey renders its real main content and sign-in continuation in the normal page composition, with no personal controls or fabricated session', async () => {
  // This reviews the fallback composition, not access to the guarded production route.
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ AppShell }, { SettingsPageView }, { m }] = await Promise.all([
    import('../src/shell/shell'),
    import('../src/settings/settings-page'),
    import('../src/paraglide/messages.js'),
  ]);
  const queryClient = new QueryClient();
  const root = createRootRoute({
    component: () =>
      createElement(AppShell, {
        children: createElement(SettingsPageView, { page: { signedIn: false }, csrfToken: null }),
      }),
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ['/en/settings#account'] }),
  });
  try {
    await router.load();
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
    );
    expect(html.match(/<main\b/g)).toHaveLength(1);
    const main = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/)?.[0];
    expect(main).toBeDefined();
    expect(main).toContain('id="main-content"');
    expect(main).toContain('tabindex="-1"');
    expect(main).not.toMatch(/<main[^>]*(?:hidden|aria-busy="true")/);
    expect(main).toMatch(new RegExp(`<h1\\b[^>]*>${m.settings_heading()}</h1>`));
    expect(main).toContain(m.settings_account_heading());
    expect(main).toContain(m.settings_account_sign_in_text());
    expect(hrefs(main!)).toEqual(['/auth/sign-in?return_to=%2Fen%2Fsettings%23account']);
    for (const privateSection of [
      'reading',
      'notifications',
      'privacy',
      'verification',
      'profile',
      'public-activity',
    ]) {
      expect(main).not.toContain(`id="${privateSection}"`);
    }
    expect(main).not.toMatch(/<nav\b|<form\b|role="(?:radio|switch)"/);
    expect(html).not.toContain('/auth/sign-out');
    expect(html).not.toContain('/account/delete');
    expect(queryClient.getQueryData(['session'])).toBeUndefined();
    expect(queryClient.isFetching()).toBe(0);
  } finally {
    queryClient.clear();
  }
});

test('an unknown hydration session cannot mount a prepared account preference form, even with a seeded session cache', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ SettingsPageView }, { sessionQuery }, { m }] = await Promise.all([
    import('../src/settings/settings-page'),
    import('../src/session/query'),
    import('../src/paraglide/messages.js'),
  ]);
  const queryClient = new QueryClient();
  queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'current-alice' });
  const root = createRootRoute({
    component: () =>
      createElement(SettingsPageView, {
        page: {
          signedIn: true,
          accountId: 'alice',
          preferences: { spoilerLevel: 2, suitability: 'show', version: 77 },
          notifications: { reply: false, mention: true },
          csrfToken: 'loader-alice',
          securityHref: 'https://accounts.example.test/security',
        },
        csrfToken: 'current-alice',
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/en/settings'] }) });
  try {
    await router.load();
    const html = renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
    );
    expect(html).toContain(m.settings_heading());
    expect(html).toContain(m.settings_sections_loading());
    expect(html).toContain(m.settings_display_heading());
    expect(html).not.toContain(m.settings_account_sign_in_text());
    expect(html).not.toMatch(/id="(?:reading|notifications|account)"|name="(?:expectedVersion|csrf_token)"/);
    expect(html).not.toContain('loader-alice');
    expect(html).not.toContain('current-alice');
    expect(queryClient.isFetching()).toBe(0);
  } finally {
    queryClient.clear();
  }
});

test('the prepared preference loader carries only an established native account identity, including failures', async () => {
  let sessionUnavailable = false;
  let preferencesUnavailable = false;
  const paths: string[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      paths.push(new URL(request.url).pathname);
      expect(request.headers.get('authorization')).toBe('Bearer current-viewer');
      if (preferencesUnavailable) throw new Error('Preferences unavailable');
      return Response.json({ spoilerLevel: 1, suitability: 'blur', version: 7 });
    }) as typeof fetch,
  });
  const env = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.rezics.test',
    WEBSITE_SCOPES: 'openid account:read',
    WEBSITE_CLIENT_ID: 'settings-viewer',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        async credential() {
          if (sessionUnavailable) throw new Error('Session unavailable');
          return {
            status: 'active',
            subject: 'immutable-account',
            accessToken: 'current-viewer',
            csrfToken: 'current',
          };
        },
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.example.test/en/settings', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  expect(await loadSettingsPage(client, request(), env)).toMatchObject({
    signedIn: true,
    accountId: 'immutable-account',
    preferences: { version: 7 },
  });
  preferencesUnavailable = true;
  expect(await loadSettingsPage(client, request(), env)).toMatchObject({
    signedIn: true,
    accountId: 'immutable-account',
    state: 'unavailable',
  });
  sessionUnavailable = true;
  expect(await loadSettingsPage(client, request(), env)).toMatchObject({ accountId: null, state: 'unavailable' });
  expect(paths).toEqual(['/v1/accounts/immutable-account/preferences', '/v1/accounts/immutable-account/preferences']);
});

test('account transitions fence late preference receipts, recovery reads and saves from retired sections', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ accountPreferenceIO }, { NotificationEditor }, { readReading }, { sessionQuery }] = await Promise.all([
    import('../src/settings/settings-page'),
    import('../src/settings/notification-recovery'),
    import('../src/settings/reading-preferences'),
    import('../src/session/query'),
  ]);
  const client = new QueryClient();
  const confirmed: number[] = [];
  const writes: string[] = [];
  let mounted = true;
  const credential = () => {
    const session = client.getQueryData(sessionQuery.queryKey);
    return mounted && session?.state === 'signed-in' && session.subject === 'alice' ? session.csrfToken : null;
  };
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'alice-current' });
  const receipt = Promise.withResolvers<{
    ok: true;
    notifications: { reply: boolean; mention: boolean };
    version: number;
  }>();
  const readback = Promise.withResolvers<import('../src/settings/preferences').SettingsPage>();
  const io = accountPreferenceIO('alice', credential, (version) => confirmed.push(version), {
    read: () => readback.promise,
    saveReading: async (_input, token) => {
      writes.push(token);
      return { ok: true, preferences: { spoilerLevel: 2, suitability: 'show', version: 78 } };
    },
    saveNotifications: async (_input, token) => {
      writes.push(token);
      return receipt.promise;
    },
  });
  try {
    const old = new NotificationEditor(
      { notifications: { reply: true, mention: true }, version: 77 },
      io.notifications,
    );
    const saving = old.edit('reply', false, 77);
    const reloading = readReading(io.reading, 77);
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob-current' });
    mounted = false;
    receipt.resolve({ ok: true, notifications: { reply: false, mention: true }, version: 78 });
    // A read that finishes with another account's data cannot become Alice's recovery baseline.
    readback.resolve({
      signedIn: true,
      accountId: 'bob',
      preferences: { spoilerLevel: 0, suitability: 'blur', version: 100 },
      securityHref: null,
    });
    await saving;
    expect(await reloading).toEqual({ ok: false, reason: 'unavailable' });
    io.notifications.confirmed(999);
    expect(confirmed).toEqual([]);
    await old.restore(77);
    expect(
      await io.reading.save({ expectedVersion: 77, spoilerLevel: 2, idempotencyKey: crypto.randomUUID() }),
    ).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(writes).toEqual(['alice-current']);
    // Returning to the original subject does not revive an unmounted section's callbacks.
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'alice-new' });
    io.notifications.confirmed(1_000);
    expect(confirmed).toEqual([]);
  } finally {
    client.clear();
  }
});

test('same-account recovery uses the current token and rejects unowned prepared readbacks without resetting the draft', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const [{ accountPreferenceIO }, { NotificationEditor }] = await Promise.all([
    import('../src/settings/settings-page'),
    import('../src/settings/notification-recovery'),
  ]);
  let token: string | null = 'current-token';
  let owner: string | null = 'alice';
  const tokens: string[] = [];
  const versions: number[] = [];
  const io = accountPreferenceIO(
    'alice',
    () => token,
    (version) => versions.push(version),
    {
      read: async () => ({
        signedIn: true,
        accountId: owner,
        preferences: { spoilerLevel: 1, suitability: 'blur', version: 8 },
        notifications: { reply: true, mention: true },
        securityHref: null,
      }),
      saveReading: async () => ({ ok: false, reason: 'conflict' }),
      saveNotifications: async (_input, csrfToken) => {
        tokens.push(csrfToken);
        return { ok: false, reason: 'conflict' };
      },
    },
  );
  const editor = new NotificationEditor(
    { notifications: { reply: true, mention: true }, version: 7 },
    io.notifications,
  );
  await editor.edit('reply', false, 7);
  token = 'rotated-current-token';
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({ phase: 'review', draft: { reply: false }, known: { version: 8 } });
  editor.useCurrent();
  expect(editor.snapshot()).toMatchObject({ phase: 'idle', draft: { reply: true } });
  await editor.edit('reply', false, 8);
  expect(tokens).toEqual(['current-token', 'rotated-current-token']);
  owner = null;
  await editor.reload();
  expect(editor.snapshot()).toMatchObject({ phase: 'failed', draft: { reply: false }, known: { version: 8 } });
  expect(versions).toEqual([8]);
  token = null;
  await editor.restore(8);
  expect(tokens).toHaveLength(2);
});
