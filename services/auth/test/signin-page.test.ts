import { expect, test } from 'bun:test';
import { signInPage } from '../src/signin-page.ts';

const origin = 'https://auth.example.test';
const signedOut = { kind: 'signed-out' } as const;

test('sign-in page projects installed methods and a safe interactive continuation', () => {
  expect(
    signInPage('client_id=search&scope=work%3Aread&prompt=login&sig=old&exp=1', origin, {
      kind: 'signed-in',
      account_id: 'account-a',
      email: 'person@example.test',
    }),
  ).toEqual({
    methods: { password: true, passkey: true },
    viewer: { kind: 'signed-in', account_id: 'account-a', email: 'person@example.test' },
    continuation: { href: '/authorize?client_id=search&scope=work%3Aread', requires_sign_in: true },
  });
});

test('sign-in page bounds its query and drops unsafe local returns', () => {
  expect(signInPage('return_to=https%3A%2F%2Fevil.example', origin, signedOut)?.continuation.href).toBe('/security');
  expect(signInPage('x'.repeat(4097), origin, signedOut)).toBeNull();
});
