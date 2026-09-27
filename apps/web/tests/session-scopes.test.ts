import { expect, test } from 'bun:test';
import { resourceScopes } from '../../../services/account/src/oauth-scopes.ts';
import { MAIN_SITE_SCOPE, MAIN_SITE_SCOPES, SCOPES_NOT_REQUESTED } from '../features/auth/scopes.ts';

test('IAM01: the main site requests only declared Main resource scopes, and classifies every one', () => {
  const requested = new Set<string>(MAIN_SITE_SCOPES);
  const excluded = new Set<string>(SCOPES_NOT_REQUESTED);
  expect(requested.size).toBe(MAIN_SITE_SCOPES.length);
  expect(excluded.size).toBe(SCOPES_NOT_REQUESTED.length);
  expect([...requested].filter(scope => excluded.has(scope))).toEqual([]);
  // A new Account scope fails here until someone decides whether the site asks for it.
  expect([...requested, ...excluded].sort()).toEqual([...resourceScopes].sort());
  // Sign-in identity and refresh tokens depend on these two.
  expect(requested.has('openid') && requested.has('offline_access')).toBe(true);
  // Acting-context discovery and Work creation, which every signed-in page uses.
  expect(requested.has('work:create') && requested.has('work:read')).toBe(true);
  expect(MAIN_SITE_SCOPE.split(' ')).toEqual([...MAIN_SITE_SCOPES]);
});
