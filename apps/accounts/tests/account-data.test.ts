import { describe, expect, test } from 'bun:test';
import { list, parseActivity, parseConnectedApps, parseMethods, parsePublicClient, parseSession,
  parseSessions } from '../features/api/account-data.ts';
import { classifyFailure } from '../features/api/errors.ts';
import { pendingAuthorization, safeReturnPath, signedOAuthQuery } from '../features/api/oauth-query.ts';

const at = '2026-09-27T12:00:00.000Z';

describe('Account responses', () => {
  test('a session narrows to the fields the pages show', () => {
    expect(parseSession({ session: { id: 's1', token: 'secret' }, user: { id: 'u1', email: 'a@example.test',
      name: 'Ada', emailVerified: true, image: 'javascript:alert(1)', createdAt: at, role: 'x', locale: 'zh-CN',
      twoFactorEnabled: true } })).toEqual({
      sessionId: 's1', user: { id: 'u1', email: 'a@example.test', name: 'Ada', emailVerified: true,
        image: null, createdAt: at, locale: 'zh-Hans', twoFactorEnabled: true } });
    expect(parseSession({ session: { id: 's2' }, user: { id: 'u2', email: 'b@example.test', createdAt: at,
      locale: 'ja' } })?.user.locale).toBe('ja');
    expect(parseSession({ session: { id: 's1' }, user: { id: 'u1', email: 'a@example.test', createdAt: at,
      locale: 'fr' } })?.user).toMatchObject({ locale: 'fr', twoFactorEnabled: false });
    expect(parseSession({ session: { id: 's1' }, user: { id: 'u1', email: 'a@example.test', createdAt: at,
      locale: 'it' } })?.user.locale).toBeNull();
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ user: { id: 'u1' }, session: { id: 's1' } })).toBeNull();
  });

  test('sign-in methods keep what an older service omits as unknown', () => {
    const passkey = { id: 'p1', name: ' ', createdAt: at, backedUp: true, deviceType: 'multiDevice' };
    expect(parseMethods({ password: true, passkeys: [passkey], totp: null })).toEqual({ password: true,
      passwordChangedAt: null, totp: null,
      passkeys: [{ id: 'p1', name: null, provider: null, createdAt: at, lastUsedAt: null, backedUp: true }] });
    expect(parseMethods({ password: false, passwordChangedAt: null, totp: { id: 't', name: 'Phone', verified: true },
      passkeys: [{ ...passkey, name: 'Laptop', provider: 'iCloud Keychain', lastUsedAt: at }] })).toMatchObject({
      totp: { name: 'Phone', verified: true }, passkeys: [{ name: 'Laptop', provider: 'iCloud Keychain', lastUsedAt: at }] });
    expect(parseMethods({ password: true, passkeys: [{ id: 'p1' }], totp: null })).toBeNull();
  });

  test('devices, activity and apps are pages; one malformed item fails the page', () => {
    const device = { id: 'd1', createdAt: at, lastActiveAt: at, expiresAt: at, thisDevice: true, network: '192.0.2.0/24',
      device: { browser: 'Unknown browser', platform: 'Linux', label: 'Unknown browser' } };
    expect(parseSessions({ items: [device], nextCursor: null })).toEqual({ nextCursor: null, items: [{ id: 'd1',
      createdAt: at, lastActiveAt: at, browser: null, platform: 'Linux', network: '192.0.2.0/24', thisDevice: true }] });
    expect(parseSessions({ items: [device, { id: 'd2' }], nextCursor: null })).toBeNull();
    expect(list('nope', item => item)).toBeNull();
    expect(parseActivity({ items: [{ id: 'e1', action: 'sign_in', occurredAt: at, detail: { method: 'email',
      device: { browser: 'Chrome', platform: 'macOS' }, network: '192.0.2.0/24' } }], nextCursor: 'c',
    failedAttemptsLast24Hours: { count: 2, capped: false } })).toEqual({ nextCursor: 'c',
      failedLast24Hours: { count: 2, capped: false }, items: [{ id: 'e1', action: 'sign_in', occurredAt: at,
        method: 'email', browser: 'Chrome', platform: 'macOS', network: '192.0.2.0/24', clientId: null }] });
    const app = { clientId: 'reader', name: '', uri: 'https://reader.example', icon: 'javascript:x', trusted: true,
      scopes: [{ scope: 'openid', description: { en: 'Identify your REZICS account', 'zh-CN': '识别你的 REZICS 账号' } }],
      grantedAt: at, lastUsedAt: null, installationId: 'i1', installationState: 'revoked' };
    expect(parseConnectedApps({ items: [app], nextCursor: null })?.items[0]).toEqual({ clientId: 'reader',
      name: 'reader', uri: 'https://reader.example', icon: null, trusted: true, withdrawn: true, grantedAt: at,
      lastUsedAt: null, scopes: app.scopes });
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

  test('name the steps a sensitive change or a second factor needs', () => {
    expect(classifyFailure(403, { error: 'step_up_required' })).toBe('step-up-required');
    expect(classifyFailure(403, { code: 'STEP_UP_REQUIRED' })).toBe('step-up-required');
    expect(classifyFailure(409, { error: 'last_sign_in_method' })).toBe('last-method');
    expect(classifyFailure(403, { error: 'stale_request' })).toBe('stale');
    expect(classifyFailure(401, { code: 'INVALID_CODE' })).toBe('invalid-code');
    expect(classifyFailure(401, { code: 'INVALID_BACKUP_CODE' })).toBe('invalid-code');
    expect(classifyFailure(401, { code: 'INVALID_TWO_FACTOR_COOKIE' })).toBe('stale');
    expect(classifyFailure(401, { code: 'PASSKEY_NOT_FOUND' })).toBe('invalid-credentials');
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
