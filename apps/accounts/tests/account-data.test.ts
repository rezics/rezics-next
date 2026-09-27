import { describe, expect, test } from 'bun:test';
import { list, parseConsent, parseDeviceSession, parsePublicClient,
  parseSession } from '../features/api/account-data.ts';
import { classifyFailure } from '../features/api/errors.ts';
import { pendingAuthorization, safeReturnPath, signedOAuthQuery } from '../features/api/oauth-query.ts';

const at = '2026-09-27T12:00:00.000Z';

describe('Account responses', () => {
  test('a session narrows to the fields the pages show', () => {
    expect(parseSession({ session: { id: 's1', token: 'secret' }, user: { id: 'u1', email: 'a@example.test',
      name: 'Ada', emailVerified: true, image: null, createdAt: at, role: 'x' } })).toEqual({
      sessionId: 's1', user: { id: 'u1', email: 'a@example.test', name: 'Ada', emailVerified: true,
        image: null, createdAt: at } });
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ user: { id: 'u1' }, session: { id: 's1' } })).toBeNull();
  });

  test('lists fail as a whole when any item is malformed', () => {
    const device = { id: 'd1', token: 't1', createdAt: at, updatedAt: at, ipAddress: '', userAgent: 'UA' };
    expect(list([device], parseDeviceSession)).toEqual([{ ...device, ipAddress: null }]);
    expect(list([device, { id: 'd2' }], parseDeviceSession)).toBeNull();
    expect(list('nope', parseDeviceSession)).toBeNull();
  });

  test('consents accept array or space-separated scopes', () => {
    expect(parseConsent({ id: 'c1', clientId: 'app', scopes: ['openid', 'work:read'], createdAt: at }))
      .toEqual({ id: 'c1', clientId: 'app', scopes: ['openid', 'work:read'], createdAt: at });
    expect(parseConsent({ id: 'c1', clientId: 'app', scopes: 'openid profile', createdAt: at })?.scopes)
      .toEqual(['openid', 'profile']);
  });

  test('a public client links only to web pages', () => {
    expect(parsePublicClient({ client_id: 'app', client_name: 'App', logo_uri: 'javascript:alert(1)',
      client_uri: 'https://app.example', policy_uri: 'not a url', tos_uri: 'http://app.example/tos' }))
      .toEqual({ clientId: 'app', name: 'App', logo: null, uri: 'https://app.example', policy: null,
        terms: 'http://app.example/tos' });
  });
});

describe('Account failures', () => {
  test('map to outcomes without the server’s wording', () => {
    expect(classifyFailure(401, { code: 'INVALID_EMAIL_OR_PASSWORD' })).toBe('invalid-credentials');
    expect(classifyFailure(403, { code: 'EMAIL_NOT_VERIFIED' })).toBe('email-not-verified');
    expect(classifyFailure(400, { code: 'RESET_PASSWORD_DISABLED' })).toBe('not-enabled');
    expect(classifyFailure(400, { message: "Verification email isn't enabled" })).toBe('not-enabled');
    expect(classifyFailure(404, {})).toBe('not-enabled');
    expect(classifyFailure(403, { code: 'SESSION_NOT_FRESH' })).toBe('stale');
    expect(classifyFailure(400, { error: 'invalid_signature' })).toBe('expired-request');
    expect(classifyFailure(409, { message: 'transfer OAuth clients before deletion' })).toBe('conflict');
    expect(classifyFailure(429, {})).toBe('rate-limited');
    expect(classifyFailure(503, { error: 'temporarily_unavailable' })).toBe('unavailable');
    // An existing email at sign-up is an ordinary failure, never a distinct outcome.
    expect(classifyFailure(422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' })).toBe('failed');
  });
});

describe('OAuth continuation', () => {
  const signed = 'response_type=code&client_id=app&scope=openid+work%3Aread&state=s&exp=1&ba_iat=2'
    + '&ba_param=ba_iat&ba_param=ba_param&ba_param=client_id&ba_param=exp&ba_param=response_type'
    + '&ba_param=scope&ba_param=state&sig=abc';

  test('posts back exactly the signed parameters', () => {
    expect(signedOAuthQuery(`?${signed}&hl=zh-CN&next=%2Fx`)).toBe(signed);
    expect(signedOAuthQuery('client_id=app&scope=openid')).toBeUndefined();
    expect(signedOAuthQuery('client_id=app&sig=abc')).toBeUndefined();
  });

  test('reads the pending request for display', () => {
    expect(pendingAuthorization(signed)).toEqual({ clientId: 'app', scopes: ['openid', 'work:read'] });
    expect(pendingAuthorization('')).toBeUndefined();
  });

  test('returns only to same-origin paths', () => {
    expect(safeReturnPath('/security?x=1')).toBe('/security?x=1');
    for (const value of [null, '', 'https://evil.example/', '//evil.example', '/\\evil.example', '/a\r\nb']) {
      expect(safeReturnPath(value)).toBe('/');
    }
  });
});
