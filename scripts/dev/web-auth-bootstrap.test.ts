import { expect, test } from 'bun:test';
import { MAIN_SITE_SCOPE } from '../../apps/web/features/auth/scopes.ts';
import { parseWebAuthOptions, webClientCurrent, webClientRegistration } from './web-auth-bootstrap.ts';

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

test('IAM01: the local web client asks for the main site\'s scopes with PKCE and refresh, and older registrations are replaced', () => {
  const registration = webClientRegistration(['http://localhost:3000/auth/callback']);
  expect(registration).toMatchObject({ application_type: 'native', token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], scope: MAIN_SITE_SCOPE,
    require_pkce: true, redirect_uris: ['http://localhost:3000/auth/callback'] });
  expect(webClientCurrent({ scope: MAIN_SITE_SCOPE, grantTypes: ['authorization_code', 'refresh_token'] })).toBe(true);
  expect(webClientCurrent({ scope: 'openid work:create work:read' })).toBe(false);
  expect(webClientCurrent({ scope: MAIN_SITE_SCOPE, grantTypes: ['authorization_code'] })).toBe(false);
});
