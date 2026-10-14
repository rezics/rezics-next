import { expect, test } from 'bun:test';
import { betterAuth, type AuthContext, type BetterAuthOptions } from 'better-auth';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import type { GenericEndpointContext } from '@better-auth/core';
import { getEndpoints } from 'better-auth/api';
import { createInternalContext, serializeSignedCookie } from 'better-call';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { authenticationCookies } from '../src/authentication-cookies.ts';
import { prepareAuthentication, type AuthenticationProvider } from '../src/authentication-input.ts';
import { resolveAuthenticationSubject, authenticationPurpose, sensitiveAuthPaths } from '../src/authentication-subject.ts';
import { AccountProblem } from '../src/http.ts';

const secret = 'cookie-selection-secret-at-least-32-characters';
const createdAt = new Date();
const expiresAt = new Date(Date.now() + 7 * 86_400_000);
const signed = async (value: string) =>
  (await serializeSignedCookie('fixture', value, secret)).slice('fixture='.length);

async function provider(baseURL = 'http://issuer.test', advanced?: BetterAuthOptions['advanced']) {
  const auth = betterAuth({ baseURL, secret, advanced,
    emailAndPassword: { enabled: true }, session: { freshAge: 0, cookieCache: { enabled: false } },
    plugins: [twoFactor(), passkey()], logger: { disabled: true } });
  const context = await auth.$context;
  const sessions = new Map<string, {
    session: { id: string; token: string; userId: string; createdAt: Date; updatedAt: Date; expiresAt: Date };
    user: { id: string; email: string; name: string; emailVerified: boolean; createdAt: Date; updatedAt: Date };
  }>();
  for (const owner of ['A', 'B']) sessions.set(`session-${owner}`, {
    session: { id: `session-id-${owner}`, token: `session-${owner}`, userId: owner,
      createdAt, updatedAt: createdAt, expiresAt },
    user: { id: owner, email: `${owner.toLowerCase()}@example.test`, name: owner,
      emailVerified: true, createdAt, updatedAt: createdAt },
  });
  // Better Auth owns name/signature/token selection. Replace only persisted
  // session reads, rather than supplying an Account-selected session callback.
  context.internalAdapter.findSession = async (token) => sessions.get(token) ?? null;
  context.internalAdapter.deleteSession = async (token) => { sessions.delete(token); };
  return { auth, context, sessions };
}

function projection() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const proofs = new Map<string, { value: string; createdAt: Date; expiresAt: Date }>([
    ['challenge-A', { value: 'A', createdAt, expiresAt }],
    ['challenge-B', { value: 'B', createdAt, expiresAt }],
    ['reset-password:A', { value: 'A', createdAt, expiresAt }],
    ['reset-password:B', { value: 'B', createdAt, expiresAt }],
    ['passkey-B', { value: JSON.stringify({ userData: { id: 'B' } }), createdAt, expiresAt }],
    ['passkey-A', { value: JSON.stringify({ userData: { id: 'A' } }), createdAt, expiresAt }],
    ['trust-A', { value: 'A', createdAt, expiresAt }],
    ['trust-B', { value: 'B', createdAt, expiresAt }],
  ]);
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    const key = String(values[0]);
    if (sql.includes('verification')) {
      const proof = proofs.get(key);
      return { rows: proof ? [{ id: key, identifier: key, ...proof }] : [] };
    }
    if (sql.includes('passkey')) return { rows: key === 'credential-B' ? [{ userId: 'B' }] : [] };
    if (sql.includes('user')) {
      const id = ['a@example.test', 'A'].includes(key) ? 'A' : ['b@example.test', 'B'].includes(key) ? 'B' : undefined;
      return { rows: id ? [{ id }] : [] };
    }
    throw new Error(`unexpected projection: ${sql}`);
  } } as unknown as Pool;
  return { pool, queries, proofs };
}

function request(path: string, body?: unknown, headers: HeadersInit = {}, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`http://transport.test${path}`, { method,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function resolve(auth: AuthenticationProvider, pool: Pool, req: Request) {
  const prepared = await prepareAuthentication(auth, req);
  if (prepared.kind !== 'prepared') throw new Error(`unexpected admission: ${prepared.response.status}`);
  return resolveAuthenticationSubject(auth, pool, prepared.input);
}

for (const scheme of ['http', 'https', 'HTTPS']) {
  for (const reverse of [false, true])
    for (const kind of ['two_factor', 'better-auth-passkey', 'trust_device'] as const)
      test(`P08/P16/P17: initialized ${scheme} ${kind} ignores opposite-prefix cookies in ${reverse ? 'reverse' : 'forward'} order`, async () => {
        const { context } = await provider(`${scheme}://issuer.test`);
        const exact = context.createAuthCookie(kind).name;
        const other = exact.startsWith('__Secure-') ? exact.slice('__Secure-'.length) : `__Secure-${exact}`;
        const pairs = [`${other}=${await signed('challenge-A')}`, `${exact}=${await signed('challenge-B')}`];
        if (reverse) pairs.reverse();
        const headers = new Headers({ cookie: pairs.join('; ') });
        const endpoint = await createInternalContext({ headers }, { options: { method: 'GET' } });
        const expected = await endpoint.getSignedCookie(exact, context.secret);
        expect(expected).toBe('challenge-B');
        expect(await (await authenticationCookies(headers, context)).signed(kind)).toBe(typeof expected === 'string' ? expected : undefined);
        if (scheme === 'HTTPS') expect(exact.startsWith('__Secure-')).toBe(true);
      });
  test(`P17: initialized ${scheme} stale trust removal removes every exact name`, async () => {
    const { context } = await provider(`${scheme}://issuer.test`);
    const exact = context.createAuthCookie('trust_device').name;
    const other = exact.startsWith('__Secure-') ? exact.slice('__Secure-'.length) : `__Secure-${exact}`;
    const sessionName = context.authCookies.sessionToken.name;
    const headers = new Headers({ cookie: `${other}=${await signed('decoy')}; ${exact}=${await signed('old')}; ${sessionName}=${await signed('session-B')}; ${exact}=${await signed('duplicate')}` });
    (await authenticationCookies(headers, context)).remove('trust_device');
    const endpoint = await createInternalContext({ headers }, { options: { method: 'GET' } });
    expect(await endpoint.getSignedCookie(exact, context.secret)).toBeNull();
    expect(await endpoint.getSignedCookie(other, context.secret)).toBe('decoy');
    expect(await endpoint.getSignedCookie(sessionName, context.secret)).toBe('session-B');
  });
}

for (const kind of ['two_factor', 'better-auth-passkey', 'trust_device'] as const)
  for (const format of ['same-owner-duplicates', 'quoted', 'encoded', 'malformed-encoding', 'empty-first', 'invalid-first', 'repeated-header', 'repeated-header-separated'] as const)
    test(`P09: initialized provider ${kind} ${format} signed selection parity`, async () => {
      const { context } = await provider('https://issuer.test');
      const exact = context.createAuthCookie(kind).name;
      const value = await signed('challenge-B');
      const headers = new Headers();
      if (format.startsWith('repeated-header')) {
        headers.append('cookie', `${exact}=${value}${format === 'repeated-header-separated' ? ';' : ''}`);
        headers.append('cookie', `${exact}=${value}`);
      } else headers.set('cookie', format === 'quoted' ? ` ${exact} = "${value}" `
        : format === 'encoded' ? `${exact}=${encodeURIComponent(decodeURIComponent(value))}`
        : format === 'malformed-encoding' ? `${exact}=%broken`
        : `${exact}=${format === 'empty-first' ? '' : format === 'invalid-first' ? 'invalid' : value}; ${exact}=${value}`);
      const endpoint = await createInternalContext({ headers }, { options: { method: 'GET' } });
      const expected = await endpoint.getSignedCookie(exact, context.secret);
      expect(await (await authenticationCookies(headers, context)).signed(kind)).toBe(typeof expected === 'string' ? expected : undefined);
    });

test('P08/P16/P17: initialized cookie overrides and passkey challenge option are honored', async () => {
  const auth = betterAuth({ baseURL: 'HTTPS://issuer.test', secret,
    advanced: { cookiePrefix: 'account', cookies: { two_factor: { name: 'factor' } } },
    plugins: [twoFactor(), passkey({ advanced: { webAuthnChallengeCookie: 'custom-passkey' } })], logger: { disabled: true } });
  const context = await auth.$context;
  const factor = context.createAuthCookie('two_factor').name;
  const passkeyName = context.createAuthCookie('custom-passkey').name;
  const headers = new Headers({ cookie: `${factor}=${await signed('factor-B')}; ${passkeyName}=${await signed('passkey-B')}` });
  const selected = await authenticationCookies(headers, context);
  expect(await selected.signed('two_factor')).toBe('factor-B');
  expect(await selected.signed('better-auth-passkey')).toBe('passkey-B');
});

for (const media of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'application/json-invalid', 'text/application/json', 'application/json, application/json'])
  test(`P01: strict admission rejects ${media ?? 'missing media'} before subject lookup`, async () => {
    const { auth } = await provider();
    const result = await prepareAuthentication(auth, new Request('http://transport.test/api/auth/sign-in/email', { method: 'POST',
      headers: media ? { 'content-type': media } : {}, body: '{"email":"b@example.test","password":"wrong"}' }));
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') expect(result.response.status).toBe(415);
  });

for (const body of ['{"email":"a@example.test","\\u0065mail":"b@example.test","password":"wrong"}',
  '{"response":{"id":"A"," ID ":"B"}}', '{"email":"b@example.test","Email":"a@example.test"}',
  'null', '[]', '{"email":1e999}', '{"email":"unfinished}'])
  test(`P02: strict admission refuses ambiguous or invalid JSON ${body}`, async () => {
    const { auth } = await provider();
    const result = await prepareAuthentication(auth, new Request('http://transport.test/api/auth/sign-in/email', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body }));
    expect(result.kind).toBe('reject');
    if (result.kind === 'reject') expect(result.response.status).toBe(400);
  });

test('P01/P03/P04: effective email schema accepts uppercase JSON and ignores unrelated identity fields', async () => {
  const { auth } = await provider();
  const subject = await resolve(auth, projection().pool, request('/api/auth/sign-in/email', {
    email: 'B@example.test', password: 'wrong', userId: 'A', token: 'A', response: { id: 'credential-A' },
  }, { 'content-type': 'APPLICATION/JSON; charset=utf-8' }));
  expect(subject).toMatchObject({ purpose: 'email', candidateUserId: 'B', activityUserId: 'B', target: 'b@example.test', signedInBudget: false });
});

for (const email of [' b@example.test ', 42, null, undefined])
  test(`P03: provider-invalid email ${JSON.stringify(email)} never selects a candidate`, async () => {
    const { auth } = await provider();
    expect((await prepareAuthentication(auth, request('/api/auth/sign-in/email', { email, password: 'wrong' }))).kind).toBe('reject');
  });

test('P05/P06: passkey assertion keeps its credential owner and provider record schema', async () => {
  const { auth } = await provider();
  const db = projection();
  const subject = await resolve(auth, db.pool, request('/api/auth/passkey/verify-authentication', {
    response: { id: 'credential-B', arbitrary: true }, email: 'a@example.test', token: 'A', userId: 'A',
  }));
  expect(subject).toMatchObject({ purpose: 'credential', candidateUserId: 'B', activityUserId: 'B', target: 'credential-B' });
  for (const response of [null, 'credential-B', 42])
    expect((await prepareAuthentication(auth, request('/api/auth/passkey/verify-authentication', { response }))).kind).toBe('reject');
  const missing = await resolve(auth, db.pool, request('/api/auth/passkey/verify-authentication', { response: {} }));
  expect(missing.candidateUserId).toBeUndefined();
  expect(missing.activityUserId).toBeUndefined();
});

for (const [bodyToken, queryToken, owner] of [['A', 'B', 'A'], ['', 'B', 'B'], [undefined, 'B', 'B']] as const)
  test(`P07: reset body ${bodyToken ?? 'absent'} query ${queryToken} selects ${owner}`, async () => {
    const { auth } = await provider();
    const subject = await resolve(auth, projection().pool, request(`/api/auth/reset-password?token=${queryToken}`, {
      token: bodyToken, newPassword: 'new long password', email: 'ignored@example.test',
    }));
    expect(subject).toMatchObject({ purpose: 'reset-token', candidateUserId: owner, verification: { identifier: `reset-password:${owner}` } });
  });
for (const query of ['token=A&token=A', 'token=A&token=B'])
  test(`P07: repeated scalar reset query ${query} refuses even with a body token`, async () => {
    const { auth } = await provider();
    expect((await prepareAuthentication(auth, request(`/api/auth/reset-password?${query}`, { token: 'B', newPassword: 'new long password' }))).kind).toBe('reject');
  });

for (const path of ['/api/auth/two-factor/verify-totp', '/api/auth/two-factor/verify-backup-code'])
  test(`P04/P11/P14: ${path} uses the provider session and immutable budget`, async () => {
    const { auth, context } = await provider();
    const db = projection();
    const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-A')}`;
    const subject = await resolve(auth, db.pool, request(path, { code: 'wrong', email: 'b@example.test', userId: 'B' }, { cookie }));
    expect(subject).toMatchObject({ purpose: 'session-proof', candidateUserId: 'A', activityUserId: 'A', session: { user: { id: 'A' } }, target: 'A', signedInBudget: true });
    expect(db.queries.some(({ values }) => values.includes('b@example.test'))).toBe(false);
  });

test('P11/P12: exact provider session resolution and query coercion stay authoritative', async () => {
  const { auth, context } = await provider('HTTPS://issuer.test');
  const exact = context.authCookies.sessionToken.name;
  const opposite = exact.slice('__Secure-'.length);
  const { api } = getEndpoints(auth.$context as unknown as Promise<AuthContext>, auth.options);
  for (const query of ['', 'disableRefresh=true', 'disableCookieCache=false&disableRefresh=false', 'disableRefresh=invalid', 'disableRefresh=true&disableRefresh=false']) {
    const cookie = `${opposite}=${await signed('session-A')}; ${exact}=${await signed('session-A')}`;
    const params: Record<string, string | string[]> = {};
    for (const [key, value] of new URLSearchParams(query)) {
      const previous = params[key];
      params[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous : [previous]), value];
    }
    const parsed = api.getSession.options.query!.parse(params);
    const expected = await auth.api.getSession({ headers: new Headers({ cookie }), query: parsed });
    const actual = await resolve(auth, projection().pool, request(`/api/auth/two-factor/verify-totp${query ? `?${query}` : ''}`, { code: 'wrong' }, { cookie }));
    expect(actual.session).toEqual(expected);
    expect(actual.candidateUserId).toBe('A');
  }
});

for (const issuer of ['http://issuer.test', 'https://issuer.test', 'HTTPS://issuer.test'])
  for (const reverse of [false, true])
    for (const kind of ['session_token', 'two_factor', 'better-auth-passkey', 'trust_device'] as const)
      test(`P08/P09/P11/P16/P17: ${issuer} ${kind} both-name owners conflict in ${reverse ? 'reverse' : 'forward'} order`, async () => {
        const { auth, context } = await provider(issuer);
        const name = kind === 'session_token' ? context.authCookies.sessionToken.name : context.createAuthCookie(kind).name;
        const opposite = name.startsWith('__Secure-') ? name.slice('__Secure-'.length) : `__Secure-${name}`;
        const value = (owner: string) => kind === 'session_token' ? `session-${owner}`
          : kind === 'better-auth-passkey' ? `passkey-${owner}`
          : kind === 'trust_device' ? `${createHmac('sha256', secret).update(`${owner}!trust-${owner}`).digest('base64url')}!trust-${owner}` : `challenge-${owner}`;
        const pairs = [`${opposite}=${await signed(value('A'))}`, `${name}=${await signed(value('B'))}`];
        if (reverse) pairs.reverse();
        const path = kind === 'better-auth-passkey' ? '/api/auth/passkey/verify-registration'
          : kind === 'trust_device' ? '/api/auth/sign-in/email' : '/api/auth/two-factor/verify-totp';
        const body = kind === 'better-auth-passkey' ? { response: {} }
          : kind === 'trust_device' ? { email: 'b@example.test', password: 'wrong' } : { code: 'wrong' };
        await expect(resolve(auth, projection().pool, request(path, body, { cookie: pairs.join('; ') })))
          .rejects.toEqual(new AccountProblem('invalid_request', 400));
      });

for (const issuer of ['http://issuer.test', 'https://issuer.test', 'HTTPS://issuer.test'])
  for (const kind of ['session_token', 'two_factor', 'better-auth-passkey', 'trust_device'] as const)
    test(`P08/P16/P17: ${issuer} wrong-prefix-only ${kind} never becomes the primary candidate`, async () => {
      const { auth, context } = await provider(issuer);
      const name = kind === 'session_token' ? context.authCookies.sessionToken.name : context.createAuthCookie(kind).name;
      const opposite = name.startsWith('__Secure-') ? name.slice('__Secure-'.length) : `__Secure-${name}`;
      const value = kind === 'session_token' ? 'session-A' : kind === 'better-auth-passkey' ? 'passkey-A'
        : kind === 'trust_device' ? `${createHmac('sha256', secret).update('A!trust-A').digest('base64url')}!trust-A` : 'challenge-A';
      const path = kind === 'better-auth-passkey' ? '/api/auth/passkey/verify-registration'
        : kind === 'trust_device' ? '/api/auth/sign-in/email' : '/api/auth/two-factor/verify-totp';
      const body = kind === 'better-auth-passkey' ? { response: {} }
        : kind === 'trust_device' ? { email: 'absent@example.test', password: 'wrong' } : { code: 'wrong' };
      const subject = await resolve(auth, projection().pool, request(path, body, { cookie: `${opposite}=${await signed(value)}` }));
      expect(subject.candidateUserId).toBeUndefined();
      expect(subject.activityUserId).toBeUndefined();
      expect(subject.trust).toBeUndefined();
      expect(subject.verification).toBeUndefined();
    });

for (const reverse of [false, true])
  test(`P09/P12: exact-name session owners conflict in ${reverse ? 'reverse' : 'forward'} order`, async () => {
    const { auth, context } = await provider();
    const name = context.authCookies.sessionToken.name;
    const pairs = [`${name}=${await signed('session-A')}`, `${name}=${await signed('session-B')}`];
    if (reverse) pairs.reverse();
    await expect(resolve(auth, projection().pool, request('/api/auth/two-factor/verify-totp', { code: 'wrong' }, { cookie: pairs.join('; ') })))
      .rejects.toEqual(new AccountProblem('invalid_request', 400));
  });

for (const path of ['/api/auth/sign-in/email', '/api/auth/passkey/verify-authentication'])
  test(`P04/P05/P06: ${path} refuses a target B proof with a live session A`, async () => {
    const { auth, context } = await provider();
    const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-A')}`;
    const body = path.endsWith('/email') ? { email: 'b@example.test', password: 'wrong' }
      : { response: { id: 'credential-B' } };
    await expect(resolve(auth, projection().pool, request(path, body, { cookie })))
      .rejects.toEqual(new AccountProblem('invalid_request', 400));
  });

test('P11: provider-selected session A and signed challenge B refuse before proof', async () => {
  const { auth, context } = await provider();
  const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-A')}; ${context.createAuthCookie('two_factor').name}=${await signed('challenge-B')}`;
  await expect(resolve(auth, projection().pool, request('/api/auth/two-factor/verify-totp', { code: 'wrong' }, { cookie }))).rejects.toEqual(new AccountProblem('invalid_request', 400));
});
for (const reverse of [false, true])
  test(`P09: different-owner exact-name challenge duplicates refuse in ${reverse ? 'reverse' : 'forward'} order`, async () => {
    const { auth, context } = await provider();
    const name = context.createAuthCookie('two_factor').name;
    const pairs = [`${name}=${await signed('challenge-A')}`, `${name}=${await signed('challenge-B')}`];
    if (reverse) pairs.reverse();
    await expect(resolve(auth, projection().pool, request('/api/auth/two-factor/verify-totp', { code: 'wrong' }, { cookie: pairs.join('; ') }))).rejects.toEqual(new AccountProblem('invalid_request', 400));
  });

test('P12: real provider session-store failure cannot fall through to a signed challenge', async () => {
  const { auth, context } = await provider();
  const db = projection();
  context.internalAdapter.findSession = async () => { throw new Error('session store unavailable'); };
  const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-A')}; ${context.createAuthCookie('two_factor').name}=${await signed('challenge-B')}`;
  await expect(resolve(auth, db.pool, request('/api/auth/two-factor/verify-totp', { code: 'wrong' }, { cookie }))).rejects.toThrow();
  expect(db.queries.filter(({ sql }) => sql.includes('verification'))).toEqual([]);
});

test('P10/P18: stale, missing and deleted-user challenges have no activity subject', async () => {
  const { auth, context } = await provider();
  for (const state of ['missing', 'expired', 'deleted-user']) {
    const db = projection();
    if (state === 'missing') db.proofs.delete('challenge-B');
    else db.proofs.set('challenge-B', { value: state === 'deleted-user' ? 'deleted' : 'B',
      createdAt, expiresAt: state === 'expired' ? new Date(Date.now() - 1_000) : expiresAt });
    const cookie = `${context.createAuthCookie('two_factor').name}=${await signed('challenge-B')}`;
    const subject = await resolve(auth, db.pool, request('/api/auth/two-factor/verify-totp', {
      code: 'wrong', email: 'a@example.test', userId: 'A',
    }, { cookie }));
    expect(subject.activityUserId).toBeUndefined();
    expect(subject.candidateUserId).toBeUndefined();
  }
});

test('P12/P21: embedded provider session-store outage refuses without charging a mail target', async () => {
  const { auth, context } = await provider();
  context.internalAdapter.findSession = async () => { throw new Error('session store unavailable'); };
  const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-A')}`;
  const raw = await createInternalContext({ headers: new Headers({ cookie }), body: { email: 'a@example.test' },
    query: {}, method: 'POST' }, { options: { method: 'POST' } });
  const providerContext = { ...raw, path: '/send-verification-email', context } as unknown as GenericEndpointContext;
  const prepared = await prepareAuthentication(auth, { kind: 'provider-context', context: providerContext });
  expect(prepared.kind).toBe('prepared');
  const db = projection();
  if (prepared.kind === 'prepared') await expect(resolveAuthenticationSubject(auth, db.pool, prepared.input)).rejects.toThrow();
  expect(db.queries).toEqual([]);
});

test('P16: registration keeps its provider session without charging a proof attempt', async () => {
  const { auth, context } = await provider();
  const cookie = `${context.authCookies.sessionToken.name}=${await signed('session-B')}; ${context.createAuthCookie('better-auth-passkey').name}=${await signed('passkey-B')}`;
  const subject = await resolve(auth, projection().pool, request('/api/auth/passkey/verify-registration', { response: {}, email: 'a@example.test' }, { cookie }));
  expect(subject).toMatchObject({ purpose: 'registration', candidateUserId: 'B', signedInBudget: false });
});

test('P19: verify-email is provider-owned and unsigned tokens cannot select an outer lock', async () => {
  const { auth } = await provider();
  for (const token of ['malformed', 'eyJhbGciOiJub25lIn0.eyJlbWFpbCI6IkJAZXhhbXBsZS50ZXN0In0.']) {
    const db = projection();
    const prepared = await prepareAuthentication(auth, request(`/api/auth/verify-email?token=${token}`));
    if (prepared.kind === 'prepared') {
      const subject = await resolveAuthenticationSubject(auth, db.pool, prepared.input);
      expect(subject.purpose).toBe('provider-owned');
      expect(subject.candidateUserId).toBeUndefined();
    }
    expect(db.queries).toEqual([]);
  }
});

test('P24: effective provider endpoint methods define the credential purpose matrix', async () => {
  const { auth } = await provider();
  const { api } = getEndpoints(auth.$context as unknown as Promise<AuthContext>, auth.options);
  const cases = [
    ['signInEmail', 'email', { email: 'b@example.test', password: 'wrong' }],
    ['requestPasswordReset', 'email', { email: 'b@example.test' }],
    ['resetPassword', 'reset-token', { token: 'B', newPassword: 'new long password' }],
    ['verifyTOTP', 'session-proof', { code: 'wrong' }],
    ['verifyBackupCode', 'session-proof', { code: 'wrong' }],
    ['verifyPasskeyAuthentication', 'credential', { response: { id: 'credential-B' } }],
    ['verifyPasskeyRegistration', 'registration', { response: {} }],
  ] as const;
  for (const [name, purpose, body] of cases) {
    const endpoint = api[name];
    expect(endpoint).toBeDefined();
    const methods = Array.isArray(endpoint.options.method) ? endpoint.options.method : [endpoint.options.method];
    expect(methods).toContain('POST');
    expect((await resolve(auth, projection().pool, request(`/api/auth${endpoint.path}`, body))).purpose).toBe(purpose);
    const wrong = await prepareAuthentication(auth, request(`/api/auth${endpoint.path}`, undefined, {}, 'GET'));
    if (wrong.kind === 'prepared') expect((await resolveAuthenticationSubject(auth, projection().pool, wrong.input)).purpose).toBe('provider-owned');
  }
  for (const [name, endpoint] of Object.entries(api)) {
    if (!endpoint.path) continue; // server-only APIs have no HTTP admission surface
    const input = { kind: 'http' as const, path: `/api/auth${endpoint.path}`,
      endpointPath: endpoint.path, method: Array.isArray(endpoint.options.method)
        ? endpoint.options.method[0]! : endpoint.options.method,
      body: {}, query: {}, sessionQuery: {}, headers: new Headers() };
    if (endpoint.path.startsWith('/two-factor/verify-')) expect(authenticationPurpose(input), name).toBe('session-proof');
    else if (sensitiveAuthPaths.has(input.path)) expect(['registration', 'session-mutation']).toContain(authenticationPurpose(input));
    if (!endpoint.path || !['/sign-out', '/change-password', '/set-password', '/update-user',
      '/two-factor/enable', '/two-factor/disable', '/revoke-session', '/revoke-sessions',
      '/revoke-other-sessions', '/passkey/delete-passkey', '/passkey/update-passkey'].includes(endpoint.path)) continue;
    const method = Array.isArray(endpoint.options.method) ? endpoint.options.method[0] : endpoint.options.method;
    const prepared = await prepareAuthentication(auth, request(`/api/auth${endpoint.path}`, undefined, {}, method));
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind === 'prepared') {
      expect((await resolveAuthenticationSubject(auth, projection().pool, prepared.input)).purpose,
        `effective endpoint ${name}`).toBe('session-mutation');
    }
  }
  for (const path of ['/api/auth/two-factor/verify-unknown', '/api/auth/sign-in/email/', '/api/auth//sign-in/email', '/api/auth/sign-in/%65mail', '/api/auth/sign-in/magic-link', '/api/auth/sso/callback/provider']) {
    const prepared = await prepareAuthentication(auth, request(path, { email: 'b@example.test', password: 'wrong' }));
    if (prepared.kind === 'prepared') expect((await resolveAuthenticationSubject(auth, projection().pool, prepared.input)).purpose).toBe('provider-owned');
  }
});
