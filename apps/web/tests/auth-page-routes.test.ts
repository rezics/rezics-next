import { expect, test } from 'bun:test';
import { authManagementPageHref, type AuthManagementPagePath } from '../src/session/auth-page-routes';
import { accountRenameNavigation } from '../src/settings/account-rename-actions';
import { accountSafetyLinks, securityHrefFromIssuer } from '../src/settings/account-safety-links';

const issuer = 'https://auth.example.test/auth';
const target = '123e4567-e89b-42d3-a456-426614174000';
const routes: AuthManagementPagePath[] = [
  '/account/rename',
  '/organizations/members',
  '/operators/transfer',
  '/organizations/delete',
];
const env = { AUTH_ISSUER: issuer, AUTH_MANAGEMENT_PAGE_ROUTES: JSON.stringify(routes) };

test('new Auth management hrefs require trusted explicit route deployment configuration and valid issuer, missing invalid or undeclared routes remain unavailable', () => {
  expect(authManagementPageHref(env, '/account/rename')).toBe('https://auth.example.test/account/rename');
  for (const raw of [
    undefined,
    '',
    'not JSON',
    'null',
    '{}',
    '"/account/rename"',
    '[]',
    '["*"]',
    '["/account/rename","/unknown"]',
    '["/account/rename","/account/rename"]',
    '["/account/rename",null]',
    JSON.stringify([...routes, '/account/rename']),
    JSON.stringify(['/organizations/members']),
  ]) {
    expect(authManagementPageHref({ ...env, AUTH_MANAGEMENT_PAGE_ROUTES: raw }, '/account/rename')).toBeNull();
  }
  const single = JSON.stringify(['/account/rename']);
  expect(authManagementPageHref({ ...env, AUTH_MANAGEMENT_PAGE_ROUTES: single.padEnd(1024) }, '/account/rename')).toBe(
    'https://auth.example.test/account/rename',
  );
  expect(
    authManagementPageHref({ ...env, AUTH_MANAGEMENT_PAGE_ROUTES: single.padEnd(1025) }, '/account/rename'),
  ).toBeNull();
  expect(authManagementPageHref(env, '/unknown' as AuthManagementPagePath)).toBeNull();
});

test('management hrefs use only a trusted issuer origin with the existing loopback exception', () => {
  for (const AUTH_ISSUER of [
    undefined,
    '',
    '/auth',
    'http://auth.example.test',
    'ftp://auth.example.test',
    'https://user:password@auth.example.test',
    `${issuer}?return_to=https://other.test`,
    `${issuer}#fragment`,
    `${issuer}?`,
    `${issuer}#`,
    'http://localhost.other.test',
    'http://127.0.0.2',
  ]) {
    expect(authManagementPageHref({ ...env, AUTH_ISSUER }, '/account/rename')).toBeNull();
  }
  for (const origin of ['http://localhost:4200', 'http://127.0.0.1:4200', 'http://[::1]:4200']) {
    expect(authManagementPageHref({ ...env, AUTH_ISSUER: `${origin}/auth` }, '/account/rename')).toBe(
      `${origin}/account/rename`,
    );
  }
});

test('each management route accepts only its fixed target query and a real UUID', () => {
  expect(authManagementPageHref(env, '/account/rename', target)).toBeNull();
  expect(authManagementPageHref(env, '/account/rename', '')).toBeNull();
  for (const path of routes.slice(1)) {
    const href = new URL(authManagementPageHref(env, path, target)!);
    expect(href.origin).toBe('https://auth.example.test');
    expect(href.pathname).toBe(path);
    expect([...href.searchParams]).toEqual([[path === '/operators/transfer' ? 'accountId' : 'organizationId', target]]);
    expect(href.hash).toBe('');
    for (const invalid of [
      undefined,
      '',
      'not-a-uuid',
      '00000000-0000-0000-0000-000000000000',
      '123e4567-e89b-42d3-7456-426614174000',
      `${target}&return_to=https://other.test`,
      `${target} `,
    ])
      expect(authManagementPageHref(env, path, invalid)).toBeNull();
    expect(authManagementPageHref({ ...env, AUTH_MANAGEMENT_PAGE_ROUTES: '[]' }, path, target)).toBeNull();
  }
});

test('server rename composition requires both deployment availability and current native capability', () => {
  const context = { accountId: target, handle: null, available: true };
  expect(accountRenameNavigation(env, context)).toEqual({
    ...context,
    href: 'https://auth.example.test/account/rename',
  });
  expect(accountRenameNavigation({ AUTH_ISSUER: issuer }, context)).toEqual({ ...context, href: null });
  expect(accountRenameNavigation(env, { ...context, available: false })?.href).toBeNull();
  expect(accountRenameNavigation({ ...env, AUTH_ISSUER: 'http://other.test' }, context)?.href).toBeNull();
  expect(accountRenameNavigation(env, null)).toBeNull();
  expect(context).toEqual({ accountId: target, handle: null, available: true });
});

test('existing security and account deletion links do not depend on new management deployment configuration', () => {
  const security = securityHrefFromIssuer(issuer);
  expect(accountSafetyLinks(security)).toEqual({
    security: 'https://auth.example.test/security',
    deletion: 'https://auth.example.test/account/delete',
  });
});
