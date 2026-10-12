import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';
import type { Pool } from 'pg';
import { authenticationBody, withRecoveryAuthentication } from '../src/recovery-auth.ts';

test('form sign-in cannot admit an old-password session after recovery during verification', async () => {
  const f = await accountFixture();
  let resume = () => {};
  try {
    const member = await f.signup('form-recovery@example.test');
    const guardian = await f.signup('form-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const context = await f.auth.$context;
    const verify = context.password.verify;
    let entered = () => {};
    const paused = new Promise<'paused'>(resolve => { entered = () => resolve('paused'); });
    const released = new Promise<void>(resolve => { resume = resolve; });
    context.password.verify = async input => {
      // The provider has already read the old hash when it calls verify.
      entered();
      await released;
      return verify(input);
    };
    const pending = fetch(`${f.baseURL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { origin: f.baseURL,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: member.email, password: member.password }),
    });
    const state = await Promise.race([paused, pending.then(() => 'rejected' as const)]);
    expect((await proof.activate()).status).toBe(200);
    resume();
    const response = await pending;
    const session = cookies(response)
      ? await (await f.request('/api/auth/get-session', undefined, cookies(response))).json()
      : null;
    expect(session).toBeNull();
    expect(state).toBe('rejected');
    expect(response.status).toBe(415);
    context.password.verify = verify;
    expect((await f.request('/api/auth/sign-in/email', {
      email: member.email, password: 'new independently bound password',
    })).status).toBe(200);
  } finally { resume(); await f.close(); }
}, 60_000);

test('every JSON authentication admission rejects ambiguous keys before lock or provider selection', async () => {
  const f = await accountFixture();
  const handler = f.auth.handler;
  let providerCalls = 0;
  try {
    // Every request below is rejected before the provider runs. Finish its
    // background initialization before teardown closes the fixture database.
    await f.auth.$context;
    f.auth.handler = async request => { providerCalls++; return handler(request); };
    const ambiguous = [
      '{"email":"first@example.test","email":"last@example.test"}',
      '{"email":"first@example.test","\\u0065mail":"last@example.test"}',
      '{"email":"first@example.test","Email":"last@example.test"}',
      '{"email":"first@example.test"," email ":"last@example.test"}',
      '{"EMAIL":"last@example.test"}', '{"token ":"last"}', '{"Response":{"id":"last"}}',
      '{"token":"first","token":"last"}',
      '{"response":{"id":"first"},"response":{"id":"last"}}',
      '{"response":{"id":"first","id":"last"}}',
      '{"response":{" ID ":"last"}}',
      '{"code":"first","code":"last"}',
      '{"password":"first","password":"last"}',
      '{"unused":1,"unused":2}',
    ];
    for (const path of ['/api/auth/sign-in/email', '/api/auth/request-password-reset',
      '/api/auth/reset-password', '/api/auth/passkey/verify-authentication',
      '/api/auth/passkey/verify-registration', '/api/auth/two-factor/verify-totp',
      '/api/auth/two-factor/verify-backup-code', '/api/auth/two-factor/verify-otp']) {
      for (const body of ambiguous) {
        const response = await fetch(`${f.baseURL}${path}`, { method: 'POST',
          headers: { origin: f.baseURL, 'content-type': 'application/json' }, body });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_request' });
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect(providerCalls).toBe(0);
    expect((await f.pool.query('SELECT count(*)::int AS count FROM rezics_account_rate_limit')).rows[0].count).toBe(0);
  } finally { f.auth.handler = handler; await f.close(); }
}, 60_000);

test('strict authentication parsing preserves provider values and binds the same email lock owner', async () => {
  const request = new Request('http://account.test/api/auth/sign-in/email', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"\\u0065mail":"MEMBER@example.test","password":"quoted\\\" \\u4f60\\n", "rememberMe":false}' });
  const body = await authenticationBody(request);
  expect(body).toEqual(await request.clone().json());
  const owners: unknown[][] = [];
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('AS stale_verification')) owners.push(values);
      return { rows: [{ stale_verification: false, stale_session: false, stale_trust: false }] };
    }, release: () => {},
  };
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      expect(values).toEqual([(body.email as string).toLowerCase()]);
      return { rows: [{ id: 'member-owner' }] };
    }, connect: async () => db,
  } as unknown as Pool;
  const response = await withRecoveryAuthentication(pool, request, async held => {
    expect(held as unknown).toBe(db);
    const providerBody = await request.json();
    expect(providerBody).toEqual(body);
    expect(owners).toEqual([['member-owner', null, null, null]]);
    return Response.json({ status: true });
  }, async () => null);
  expect(response.status).toBe(200);
});

test('strict authentication parsing rejects malformed JSON without changing JSON scalar semantics', async () => {
  const request = (body: string) => new Request('http://account.test/api/auth/sign-in/email', {
    method: 'POST', body, headers: { 'content-type': 'application/json' },
  });
  for (const body of ['null', '[]', '{"email":true,}', '{"email":01}', '{"email":"\\x65"}',
    '{"email":"unfinished}', '{"email":"line\nbreak"}', '{} trailing', '{"email":1e999}']) {
    await expect(authenticationBody(request(body))).rejects.toThrow('invalid authentication JSON');
  }
  const body = '{"email":"a@example.test","extra":[null,true,false,-1.5e2,{"a":"\\t\\r\\b\\f\\/\\\\\\uD83D\\uDE00"}]}';
  expect(await authenticationBody(request(body))).toEqual(JSON.parse(body));
});

test('authentication rejects non-JSON media types before provider proof verification', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('auth-media@example.test');
    for (const contentType of ['application/x-www-form-urlencoded', 'multipart/form-data',
      'text/plain', 'application/json-invalid', 'text/application/json']) {
      for (const path of ['/api/auth/sign-in/email', '/api/auth/reset-password',
        '/api/auth/passkey/verify-authentication', '/api/auth/two-factor/verify-totp',
        '/api/auth/two-factor/verify-backup-code']) {
        const response = await fetch(`${f.baseURL}${path}`, { method: 'POST',
          headers: { origin: f.baseURL, 'content-type': contentType },
          body: JSON.stringify({ email: member.email, password: member.password, code: 'invalid' }) });
        expect(response.status).toBe(415);
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    }
    expect((await f.request('/api/auth/sign-in/email', {
      email: member.email.toUpperCase(), password: member.password,
    }, undefined, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
  } finally { await f.close(); }
}, 60_000);
