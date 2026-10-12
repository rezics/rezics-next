import { expect, test } from 'bun:test';
import { authenticationSubjectRule } from '../src/authentication-subject.ts';

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
