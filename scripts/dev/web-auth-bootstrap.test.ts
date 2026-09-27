import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_SITE_SCOPE } from '../../apps/web/features/auth/scopes.ts';
import { parseWebAuthOptions, retiredOperator, webClientCurrent, webClientRegistration } from './web-auth-bootstrap.ts';

test('IAM01: local web auth bootstrap accepts only a disposable run and exact loopback callback', () => {
  expect(parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri',
    'http://localhost:3000/auth/callback', '--redirect-uri',
    'http://127.0.0.1:3003/auth/callback'])).toEqual({
    runId: 'web-demo', redirectUris: ['http://localhost:3000/auth/callback',
      'http://127.0.0.1:3003/auth/callback'],
  });
  for (const redirect of [
    'https://localhost:3000/auth/callback', 'http://example.test:3000/auth/callback',
    'http://localhost.evil.test:3000/auth/callback', 'http://localhost/auth/callback',
    'http://localhost:3000/auth/callback?next=evil',
    'http://localhost:3000/auth/callback#fragment',
  ]) {
    expect(() => parseWebAuthOptions(['--run-id', 'web-demo', '--redirect-uri', redirect]))
      .toThrow();
  }
  expect(() => parseWebAuthOptions(['--run-id', '../dev', '--redirect-uri',
    'http://localhost:3000/auth/callback'])).toThrow();
});

test('IAM01: re-registration reuses an authorized retired fixture operator', async () => {
  const stack = mkdtempSync('.temp/web-auth-retired-');
  try {
    for (const [time, id] of [['100', 'old'], ['200', 'new']]) {
      const directory = join(stack, `web-auth.retired-${time}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'private.json'), JSON.stringify({
        operator: { id, email: `${id}@example.test`, password: `password-${id}` },
      }));
    }
    const tried: string[] = [];
    const chosen = await retiredOperator(stack, async operator => {
      tried.push(operator.id);
      return operator.id === 'old' ? operator : undefined;
    });
    expect(tried).toEqual(['new', 'old']);
    expect(chosen?.email).toBe('old@example.test');
  } finally { rmSync(stack, { recursive: true, force: true }); }
});

test('IAM01: the local web client asks for the main site\'s scopes with PKCE and refresh, and older registrations are replaced', () => {
  const registration = webClientRegistration(['http://localhost:3000/auth/callback']);
  expect(registration).toMatchObject({ client_name: 'REZICS', application_type: 'native', token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], scope: MAIN_SITE_SCOPE,
    require_pkce: true, redirect_uris: ['http://localhost:3000/auth/callback'] });
  const current = { scope: MAIN_SITE_SCOPE, name: 'REZICS', firstParty: true, installationState: 'active',
    installationScopes: MAIN_SITE_SCOPE.split(' '), grantTypes: ['authorization_code', 'refresh_token'] };
  expect(webClientCurrent(current)).toBe(true);
  expect(webClientCurrent({ ...current, installationScopes: current.installationScopes.filter(scope => scope !== 'follow:read') })).toBe(false);
  expect(webClientCurrent({ ...current, installationState: 'revoked' })).toBe(false);
  expect(webClientCurrent({ ...current, name: 'QA-only loopback PKCE' })).toBe(false);
  expect(webClientCurrent({ ...current, firstParty: false })).toBe(false);
  expect(webClientCurrent({ ...current, grantTypes: ['authorization_code'] })).toBe(false);
});
