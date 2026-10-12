import { expect, test } from 'bun:test';
import { authenticationSubject, authenticationSubjectRule } from '../src/authentication-subject.ts';
import type { Pool } from 'pg';
import { createInternalContext, serializeSignedCookie } from 'better-call';
import { createCookieGetter } from 'better-auth/cookies';
import { authenticationCookies } from '../src/authentication-cookies.ts';
import { readdirSync, readFileSync } from 'node:fs';

const signingSecret = 'cookie-selection-secret-at-least-32-characters';
const signed = async (value: string) =>
  (await serializeSignedCookie('fixture', value, signingSecret)).slice('fixture='.length);

for (const scheme of ['https', 'http'])
  for (const reverse of [false, true])
    for (const kind of ['two_factor', 'better-auth-passkey', 'trust_device'] as const) {
      test(`${scheme} ${kind} selects the issuer name in ${reverse ? 'reverse' : 'forward'} order`, async () => {
        const options = { baseURL: `${scheme}://issuer.test`, secret: signingSecret };
        const exact = createCookieGetter(options)(kind).name;
        const other = exact.startsWith('__Secure-')
          ? exact.slice('__Secure-'.length)
          : `__Secure-${exact}`;
        const value = (owner: string) =>
          kind === 'trust_device' ? `token!challenge-${owner}` : `challenge-${owner}`;
        const pairs = [
          `${other}=${await signed(value('A'))}`,
          `${exact}=${await signed(value('B'))}`,
        ];
        if (reverse) pairs.reverse();
        const path =
          kind === 'two_factor'
            ? '/api/auth/two-factor/verify-totp'
            : kind === 'trust_device'
              ? '/api/auth/sign-in/email'
              : '/api/auth/passkey/verify-registration';
        const request = new Request(`http://transport.test${path}`, {
          method: 'POST',
          headers: { cookie: pairs.join('; ') },
          body: '{"email":"b@example.test"}',
        });
        const epoch = new Date();
        const pool = {
          query: async (sql: string, values: string[]) => {
            if (!sql.includes('verification')) return { rows: [{ id: 'B' }] };
            expect(values).toEqual(['challenge-B']);
            return {
              rows: [{ value: 'B', createdAt: epoch, expiresAt: new Date(Date.now() + 60_000) }],
            };
          },
        } as unknown as Pool;
        const subject = await authenticationSubject(
          pool,
          request,
          async () =>
            kind === 'better-auth-passkey'
              ? { user: { id: 'B' }, session: { id: 'session-B' } }
              : null,
          options,
        );
        expect(subject.userId).toBe('B');
        if (kind === 'two_factor') expect(subject.target).toBe('challenge-B');
        else
          expect(
            kind === 'trust_device' ? subject.trustCreatedAt : subject.verificationCreatedAt,
          ).toEqual(epoch);
      });
    }

for (const scheme of ['https', 'http'])
  test(`${scheme} stale trust removal uses the exact provider name and keeps other cookies`, async () => {
    const options = { baseURL: `${scheme}://issuer.test`, secret: signingSecret };
    const exact = createCookieGetter(options)('trust_device').name;
    const other = exact.startsWith('__Secure-')
      ? exact.slice('__Secure-'.length)
      : `__Secure-${exact}`;
    const sessionName = createCookieGetter(options)('session_token').name;
    const session = await signed('session-B');
    const headers = new Headers({
      cookie: `${other}=${await signed('opposite')}; ${exact}=${await signed('old')}; ${sessionName}=${session}; ${exact}=${await signed('duplicate')}`,
    });
    (await authenticationCookies(headers, options)).remove('trust_device');
    const provider = await createInternalContext({ headers }, { options: { method: 'GET' } });
    expect(await provider.getSignedCookie(exact, signingSecret)).toBeNull();
    expect(await provider.getSignedCookie(other, signingSecret)).toBe('opposite');
    expect(await provider.getSignedCookie(sessionName, signingSecret)).toBe('session-B');
  });

test('Account request cookie parsing stays in its provider selector', () => {
  const directory = new URL('../src/', import.meta.url);
  const parsers = readdirSync(directory, { recursive: true })
    .filter((file) => typeof file === 'string' && file.endsWith('.ts'))
    .filter((file) =>
      /\.get\(\s*['"]cookie['"]\s*\)|\bparseCookies\s*\(/.test(
        readFileSync(new URL(String(file), directory), 'utf8'),
      ),
    );
  expect(parsers).toEqual(['authentication-cookies.ts']);
  const selector = readFileSync(new URL('authentication-cookies.ts', directory), 'utf8');
  expect(selector).toContain("from 'better-call'");
  expect(selector).toContain('context.getSignedCookie');
  expect(selector).toContain('createCookieGetter(options)');
});

for (const kind of ['two_factor', 'better-auth-passkey', 'trust_device'] as const) {
  for (const header of [
    'duplicates',
    'quoted',
    'repeated-header',
    'repeated-header-separated',
    'invalid-first',
  ] as const) {
    test(`${kind} ${header} selection matches the provider`, async () => {
      const options = { baseURL: 'https://issuer.test', secret: signingSecret };
      const exact = createCookieGetter(options)(kind).name;
      const first = kind === 'trust_device' ? 'token!challenge-B' : 'challenge-B';
      const headers = new Headers();
      if (header === 'repeated-header' || header === 'repeated-header-separated') {
        headers.append(
          'cookie',
          `${exact}=${await signed(first)}${header === 'repeated-header-separated' ? ';' : ''}`,
        );
        headers.append('cookie', `${exact}=${await signed('challenge-A')}`);
      } else
        headers.set(
          'cookie',
          header === 'quoted'
            ? ` ${exact} = "${await signed(first)}" `
            : `${exact}=${header === 'invalid-first' ? 'invalid' : await signed(first)}; ${exact}=${await signed('challenge-A')}`,
        );
      const provider = await createInternalContext({ headers }, { options: { method: 'GET' } });
      const expected = await provider.getSignedCookie(exact, signingSecret);
      const path =
        kind === 'two_factor'
          ? '/api/auth/two-factor/verify-totp'
          : kind === 'trust_device'
            ? '/api/auth/sign-in/email'
            : '/api/auth/passkey/verify-registration';
      const request = new Request(`http://transport.test${path}`, {
        method: 'POST',
        headers,
        body: '{"email":"b@example.test"}',
      });
      const queried: string[] = [];
      const epoch = new Date();
      const pool = {
        query: async (sql: string, values: string[]) => {
          if (!sql.includes('verification')) return { rows: [{ id: 'B' }] };
          queried.push(values[0]!);
          return {
            rows: [{ value: 'B', createdAt: epoch, expiresAt: new Date(Date.now() + 60_000) }],
          };
        },
      } as unknown as Pool;
      const subject = await authenticationSubject(
        pool,
        request,
        async () =>
          kind === 'better-auth-passkey'
            ? { user: { id: 'B' }, session: { id: 'session-B' } }
            : null,
        options,
      );
      expect(queried).toEqual(
        expected ? [kind === 'trust_device' ? expected.split('!')[1]! : expected] : [],
      );
      if (kind === 'two_factor') expect(subject.userId).toBe(expected ? 'B' : undefined);
      else
        expect(
          kind === 'trust_device' ? subject.trustCreatedAt : subject.verificationCreatedAt,
        ).toEqual(expected ? epoch : undefined);
    });
  }
}

test('signed-cookie selection honors provider cookie overrides and rejects bad signatures without fallback', async () => {
  const options = {
    baseURL: 'http://issuer.test',
    secret: signingSecret,
    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'account',
      cookies: { two_factor: { name: 'factor' } },
    },
  };
  const exact = createCookieGetter(options)('two_factor').name;
  expect(exact).toBe('__Secure-factor');
  const headers = new Headers({
    cookie: `factor=${await signed('A')}; ${exact}=invalid; ${exact}=${await signed('B')}`,
  });
  expect(
    await (await authenticationCookies(headers, options)).signed('two_factor'),
  ).toBeUndefined();
  headers.set('cookie', `factor=${await signed('A')}; ${exact}=${await signed('B')}`);
  expect(await (await authenticationCookies(headers, options)).signed('two_factor')).toBe('B');
});

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
] as const)
  test(`${path} subject is ${rule}`, () => {
    expect(authenticationSubjectRule(path)).toBe(rule);
  });

for (const [path, expected, target] of [
  ['/api/auth/sign-in/email', 'B', 'b@example.test'],
  ['/api/auth/sign-in/magic-link', 'B', 'b@example.test'],
  ['/api/auth/passkey/verify-authentication', 'B', 'credential-B'],
  ['/api/auth/sso/callback/provider', undefined, 'anonymous'],
  ['/api/auth/callback/provider', undefined, 'anonymous'],
] as const)
  test(`${path} never selects the unrelated session owner`, async () => {
    let sessions = 0;
    const pool = {
      query: async (_sql: string, values: unknown[]) => {
        expect(values).toEqual([target]);
        return { rows: [{ id: 'B', userId: 'B' }] };
      },
    } as unknown as Pool;
    const request = new Request(`http://account.test${path}`, {
      method: 'POST',
      headers: { cookie: 'session-A', 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'B@example.test',
        userId: 'A',
        response: { id: 'credential-B' },
      }),
    });
    expect(
      await authenticationSubject(
        pool,
        request,
        async () => {
          sessions++;
          return { user: { id: 'A' }, session: { id: 'session-A' } };
        },
        { baseURL: 'http://account.test' },
      ),
    ).toMatchObject({ userId: expected, target, signedInBudget: false });
    expect(sessions).toBe(0);
  });

for (const path of [
  '/api/auth/two-factor/verify-totp',
  '/api/auth/two-factor/verify-backup-code',
  '/api/account/reauthenticate',
  '/api/account/reauthenticate/passkey',
]) {
  test(`${path} ignores body identities and charges its session's immutable user`, async () => {
    const pool = {
      query: async () => {
        throw new Error('body identity must not be queried');
      },
    } as unknown as Pool;
    const request = new Request(`http://account.test${path}`, {
      method: 'POST',
      body: JSON.stringify({ email: 'B@example.test', userId: 'B' }),
    });
    expect(
      await authenticationSubject(
        pool,
        request,
        async () => ({ user: { id: 'A' }, session: { id: 'session-A' } }),
        { baseURL: 'http://account.test' },
      ),
    ).toMatchObject({ userId: 'A', target: 'A', signedInBudget: true });
  });
}

test('passkey registration keeps its session subject without spending a proof attempt', async () => {
  const pool = {
    query: async () => {
      throw new Error('body identity must not be queried');
    },
  } as unknown as Pool;
  const request = new Request('http://account.test/api/auth/passkey/verify-registration', {
    method: 'POST',
    body: JSON.stringify({ email: 'B@example.test', userId: 'B' }),
  });
  expect(
    await authenticationSubject(
      pool,
      request,
      async () => ({ user: { id: 'A' }, session: { id: 'session-A' } }),
      { baseURL: 'http://account.test' },
    ),
  ).toMatchObject({ userId: 'A', sessionId: 'session-A', signedInBudget: false });
});
