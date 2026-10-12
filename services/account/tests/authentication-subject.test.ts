import { expect, test } from 'bun:test';
import { authenticationSubject, authenticationSubjectRule } from '../src/authentication-subject.ts';
import type { Pool } from 'pg';
import { createHMAC } from '@better-auth/utils/hmac';
import { createInternalContext } from 'better-call';
import { createCookieGetter } from 'better-auth/cookies';

const signingSecret = 'cookie-selection-secret-at-least-32-characters';
const signed = async (value: string) => encodeURIComponent(`${value}.${await createHMAC('SHA-256', 'base64').sign(signingSecret, value)}`);

for (const scheme of ['https', 'http']) for (const reverse of [false, true]) {
  test(`${scheme} two-factor subject selects the issuer name in ${reverse ? 'reverse' : 'forward'} order`, async () => {
    const options = { baseURL: `${scheme}://issuer.test`, secret: signingSecret };
    const exact = createCookieGetter(options)('two_factor').name;
    const other = exact.startsWith('__Secure-') ? 'better-auth.two_factor' : '__Secure-better-auth.two_factor';
    const pairs = [`${other}=${await signed('challenge-A')}`, `${exact}=${await signed('challenge-B')}`];
    if (reverse) pairs.reverse();
    const request = new Request('http://transport.test/api/auth/two-factor/verify-totp', {
      method: 'POST', headers: { cookie: pairs.join('; ') }, body: '{"code":"invalid"}',
    });
    const pool = { query: async (_sql: string, values: string[]) => ({ rows: [{ value: values[0] === 'challenge-B' ? 'B' : 'A',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }] }) } as unknown as Pool;
    expect(await authenticationSubject(pool, request, async () => null, signingSecret, options))
      .toMatchObject({ userId: 'B', target: 'challenge-B' });
  });
}

for (const kind of ['two_factor', 'better-auth-passkey', 'trust_device'] as const) {
  for (const header of ['duplicates', 'quoted', 'repeated-header', 'repeated-header-separated', 'invalid-first'] as const) {
    test(`${kind} ${header} selection matches the provider`, async () => {
      const options = { baseURL: 'https://issuer.test', secret: signingSecret };
      const exact = createCookieGetter(options)(kind).name;
      const first = kind === 'trust_device' ? 'token!challenge-B' : 'challenge-B';
      const headers = new Headers();
      if (header === 'repeated-header' || header === 'repeated-header-separated') {
        headers.append('cookie', `${exact}=${await signed(first)}${header === 'repeated-header-separated' ? ';' : ''}`);
        headers.append('cookie', `${exact}=${await signed('challenge-A')}`);
      } else headers.set('cookie', header === 'quoted' ? ` ${exact} = "${await signed(first)}" `
        : `${exact}=${header === 'invalid-first' ? 'invalid' : await signed(first)}; ${exact}=${await signed('challenge-A')}`);
      const provider = await createInternalContext({ headers }, { options: { method: 'GET' } });
      const expected = await provider.getSignedCookie(exact, signingSecret);
      const path = kind === 'two_factor' ? '/api/auth/two-factor/verify-totp'
        : kind === 'trust_device' ? '/api/auth/sign-in/email' : '/api/auth/passkey/verify-registration';
      const request = new Request(`http://transport.test${path}`, { method: 'POST', headers,
        body: '{"email":"b@example.test"}' });
      const queried: string[] = [];
      const epoch = new Date();
      const pool = { query: async (sql: string, values: string[]) => {
        if (!sql.includes('verification')) return { rows: [{ id: 'B' }] };
        queried.push(values[0]!);
        return { rows: [{ value: 'B', createdAt: epoch, expiresAt: new Date(Date.now() + 60_000) }] };
      } } as unknown as Pool;
      const subject = await authenticationSubject(pool, request, async () => kind === 'better-auth-passkey'
        ? { user: { id: 'B' }, session: { id: 'session-B' } } : null, signingSecret, options);
      expect(queried).toEqual(expected ? [kind === 'trust_device' ? expected.split('!')[1]! : expected] : []);
      if (kind === 'two_factor') expect(subject.userId).toBe(expected ? 'B' : undefined);
      else expect(kind === 'trust_device' ? subject.trustCreatedAt : subject.verificationCreatedAt).toEqual(expected ? epoch : undefined);
    });
  }
}

// Every provider class has one subject rule, shared by activity and wrappers.
for (const [path, rule] of [
  ['/api/auth/two-factor/verify-totp', 'session'],
  ['/api/account/reauthenticate', 'session'],
  ['/api/account/reauthenticate/passkey', 'session'],
  ['/api/auth/two-factor/verify-backup-code', 'session'],
  ['/api/auth/sign-in/email', 'email'],
  ['/api/auth/sign-in/magic-link', 'email'],
  ['/api/auth/passkey/verify-authentication', 'credential'],
  ['/api/auth/sso/callback/provider', 'provider'],
  ['/api/auth/callback/provider', 'provider'],
  ['/api/auth/request-password-reset', 'email'],
  ['/api/auth/reset-password', 'reset-token'],
  ['/api/auth/verify-email', 'verified-email'],
  ['/api/auth/passkey/verify-registration', 'registration'],
] as const) test(`${path} subject is ${rule}`, () => {
  expect(authenticationSubjectRule(path)).toBe(rule);
});

for (const [path, expected, target] of [
  ['/api/auth/sign-in/email', 'B', 'b@example.test'],
  ['/api/auth/sign-in/magic-link', 'B', 'b@example.test'],
  ['/api/auth/passkey/verify-authentication', 'B', 'credential-B'],
  ['/api/auth/sso/callback/provider', undefined, 'anonymous'],
  ['/api/auth/callback/provider', undefined, 'anonymous'],
] as const) test(`${path} never selects the unrelated session owner`, async () => {
  let sessions = 0;
  const pool = { query: async (_sql: string, values: unknown[]) => {
    expect(values).toEqual([target]);
    return { rows: [{ id: 'B', userId: 'B' }] };
  } } as unknown as Pool;
  const request = new Request(`http://account.test${path}`, { method: 'POST',
    headers: { cookie: 'session-A', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'B@example.test', userId: 'A', response: { id: 'credential-B' } }) });
  expect(await authenticationSubject(pool, request, async () => {
    sessions++; return { user: { id: 'A' }, session: { id: 'session-A' } };
  })).toMatchObject({ userId: expected, target, signedInBudget: false });
  expect(sessions).toBe(0);
});

for (const path of ['/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code',
  '/api/account/reauthenticate', '/api/account/reauthenticate/passkey']) {
  test(`${path} ignores body identities and charges its session's immutable user`, async () => {
    const pool = { query: async () => { throw new Error('body identity must not be queried'); } } as unknown as Pool;
    const request = new Request(`http://account.test${path}`, { method: 'POST',
      body: JSON.stringify({ email: 'B@example.test', userId: 'B' }) });
    expect(await authenticationSubject(pool, request, async () => ({ user: { id: 'A' }, session: { id: 'session-A' } })))
      .toMatchObject({ userId: 'A', target: 'A', signedInBudget: true });
  });
}

test('passkey registration keeps its session subject without spending a proof attempt', async () => {
  const pool = { query: async () => { throw new Error('body identity must not be queried'); } } as unknown as Pool;
  const request = new Request('http://account.test/api/auth/passkey/verify-registration', { method: 'POST',
    body: JSON.stringify({ email: 'B@example.test', userId: 'B' }) });
  expect(await authenticationSubject(pool, request, async () => ({ user: { id: 'A' }, session: { id: 'session-A' } })))
    .toMatchObject({ userId: 'A', sessionId: 'session-A', signedInBudget: false });
});
