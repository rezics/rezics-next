import { expect, test } from 'bun:test';
import { authenticationSubject, authenticationSubjectRule } from '../src/authentication-subject.ts';
import type { Pool } from 'pg';

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
  ['/api/auth/passkey/verify-registration', 'session'],
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
