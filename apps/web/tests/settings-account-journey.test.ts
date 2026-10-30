import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { AccountSafetyCard } from '../src/settings/account-safety';
import { accountSafetyLinks, securityHrefFromIssuer } from '../src/settings/account-safety-links';
import { SectionsNavigation, settingsSections } from '../src/settings/sections-navigation';
import { csrfTokenFromRequest, csrfTokenMatches, isAllowedSiteOrigin, newCsrfToken } from '../src/session/csrf';

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
  expect(hrefs(pending)).toEqual(['#reading', '#profile', '#public-activity', '#account']);
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
