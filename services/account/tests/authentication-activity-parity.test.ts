import { expect, test } from 'bun:test';
import { betterAuth } from 'better-auth';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { createInternalContext } from 'better-call';
import { accountFixture, freePort, signupPolicyFixture } from './account-fixture.ts';
import { cookies, recoveryProof, type RecoveryFixture, type RecoveryMember } from './recovery-fixture.ts';
import { createAccountApp } from '../src/app.ts';

async function issuerFixture(issuer: string, customTrustName = false) {
  const f = await accountFixture({ baseURL: issuer, requireEmailVerification: false });
  let extraApp: ReturnType<typeof createAccountApp> | undefined;
  try {
    const auth: typeof f.auth = customTrustName ? betterAuth({ ...f.auth.options,
      advanced: { ...f.auth.options.advanced, cookies: { trust_device: { name: 'remember-account' } } },
    }) as unknown as typeof f.auth : f.auth;
    let transport = f.baseURL;
    if (customTrustName) {
      const port = await freePort();
      extraApp = createAccountApp(auth, f.pool).listen({ hostname: '127.0.0.1', port });
      transport = `http://127.0.0.1:${port}`;
    }
    const request: typeof f.request = (path, body, cookie, extra = {}) => {
      const url = new URL(path, transport);
      return fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { origin: new URL(issuer).origin, 'content-type': 'application/json',
          ...(cookie ? { cookie } : {}), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(url.pathname === '/api/auth/sign-up/email'
          ? { ...signupPolicyFixture, ...body as Record<string, unknown> } : body) }) });
    };
    const signup = async (email: string): Promise<RecoveryMember> => {
      const password = 'correct horse battery staple';
      const created = await request('/api/auth/sign-up/email', { email, password, name: 'Activity parity' });
      expect(created.status).toBe(200);
      const { user } = await created.json() as { user: { id: string } };
      await f.email.drain();
      const mail = [...f.messages].reverse().find(message => message.to === email)!;
      const verification = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
      expect((await request(`${verification.pathname}${verification.search}`)).status).toBe(302);
      const signed = await request('/api/auth/sign-in/email', { email, password });
      expect(signed.status).toBe(200);
      return { id: user.id, email, password, cookie: cookies(signed) };
    };
    return { ...f, auth, request, signup, baseURL: transport, close: async () => {
      await extraApp?.stop();
      await f.close();
    } };
  } catch (error) {
    await extraApp?.stop();
    await f.close();
    throw error;
  }
}

async function enroll(f: RecoveryFixture, member: RecoveryMember) {
  expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
  const secret = await symmetricDecrypt({ key: f.secret,
    data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId"=$1', [member.id])).rows[0].secret });
  const verified = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, member.cookie);
  expect(verified.status).toBe(200);
  member.cookie = cookies(verified);
  return secret;
}

async function pending(f: RecoveryFixture, member: RecoveryMember) {
  const response = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
  return cookies(response);
}

async function signInEvents(f: RecoveryFixture, userId: string) {
  return (await f.pool.query<{ action: string; method: string }>(`SELECT action, detail->>'method' AS method
    FROM rezics_account_security_event WHERE user_id=$1 AND action IN ('sign_in','sign_in_failed')
    ORDER BY occurred_at, id`, [userId])).rows;
}

test('P10: the final provider-consumed failed challenge records its snapshotted owner once', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('final-challenge@example.test');
    const peer = await f.signup('ignored-challenge-owner@example.test');
    const secret = await enroll(f, member);
    const challengeCookie = await pending(f, member);
    const context = await f.auth.$context;
    const name = context.createAuthCookie('two_factor').name;
    const reader = await createInternalContext({ headers: new Headers({ cookie: challengeCookie }) }, { options: { method: 'GET' } });
    const identifier = await reader.getSignedCookie(name, context.secret);
    expect(typeof identifier).toBe('string');
    for (let attempt = 0; attempt < 5; attempt++) {
      const denied = await f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid', email: peer.email, userId: peer.id,
      }, challengeCookie);
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    const beforeFinal = (await signInEvents(f, member.id)).filter(event => event.action === 'sign_in_failed').length;
    expect(beforeFinal).toBe(5);
    const final = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(), email: peer.email, userId: peer.id,
    }, challengeCookie);
    expect(final.status).toBe(400);
    expect(await final.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' });
    expect((await f.pool.query('SELECT id FROM verification WHERE identifier=$1', [identifier])).rows).toEqual([]);
    expect((await signInEvents(f, member.id)).filter(event => event.action === 'sign_in_failed')).toHaveLength(6);
    expect((await signInEvents(f, peer.id)).filter(event => event.action === 'sign_in_failed')).toHaveLength(0);
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(final))).json()).toBeNull();
    // A later request with the consumed cookie has no eligible attribution.
    expect((await f.request('/api/auth/two-factor/verify-totp', { code: 'invalid' }, challengeCookie)).status).toBe(401);
    expect((await signInEvents(f, member.id)).filter(event => event.action === 'sign_in_failed')).toHaveLength(6);
  } finally { await f.close(); }
}, 60_000);

test('P20: verify-email records exactly one response-session sign-in and replay records none', async () => {
  const f = await accountFixture();
  try {
    const created = await f.request('/api/auth/sign-up/email', {
      email: 'verify-event@example.test', password: 'correct horse battery staple', name: 'Verified event',
    });
    expect(created.status).toBe(200);
    const { user } = await created.json() as { user: { id: string } };
    expect(await signInEvents(f, user.id)).toEqual([]);
    await f.email.drain();
    const mail = f.messages.find(message => message.to === 'verify-event@example.test')!;
    const verification = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    const path = `${verification.pathname}${verification.search}`;
    const verified = await f.request(path);
    expect(verified.status).toBe(302);
    const issuedSession = await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json();
    expect(issuedSession).toMatchObject({ user: { id: user.id } });
    expect(await signInEvents(f, user.id)).toEqual([{ action: 'sign_in', method: 'verified-email' }]);
    const replayed = await f.request(path, undefined, cookies(verified));
    expect(replayed.status).toBe(302);
    expect(replayed.headers.getSetCookie()).toEqual([]);
    expect(await signInEvents(f, user.id)).toEqual([{ action: 'sign_in', method: 'verified-email' }]);
  } finally { await f.close(); }
}, 60_000);

test('P20: authenticator enrollment and provisional password sign-in create no sign-in activity', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('provisional-event@example.test');
    const before = await signInEvents(f, member.id);
    const secret = await enroll(f, member);
    expect(await signInEvents(f, member.id)).toEqual(before);
    const challengeCookie = await pending(f, member);
    expect(await signInEvents(f, member.id)).toEqual(before);
    expect(await (await f.request('/api/auth/get-session', undefined, challengeCookie)).json()).toBeNull();
    const verified = await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, challengeCookie);
    expect(verified.status).toBe(200);
    expect(await (await f.request('/api/auth/get-session', undefined, cookies(verified))).json()).toMatchObject({ user: { id: member.id } });
    expect(await signInEvents(f, member.id)).toEqual([...before, { action: 'sign_in', method: 'verify-totp' }]);
  } finally { await f.close(); }
}, 60_000);

for (const [issuer, customTrustName] of [
  ['http://issuer.test', false], ['https://issuer.test', false],
  ['HTTPS://issuer.test', false], ['HTTPS://issuer.test', true],
] as const)
  test(`P17: ${issuer} ${customTrustName ? 'custom' : 'default'} stale trust is removed before the provider in both prefix orders`, async () => {
    const f = await issuerFixture(issuer, customTrustName);
    const handler = f.auth.handler;
    try {
      const a = await f.signup('trust-decoy@example.test');
      const b = await f.signup('trust-stale@example.test');
      const guardian = await f.signup('trust-guardian@example.test');
      const proof = await recoveryProof(f, b, guardian);
      const aSecret = await enroll(f, a);
      const bSecret = await enroll(f, b);
      const context = await f.auth.$context;
      const exact = context.createAuthCookie('trust_device').name;
      const opposite = exact.startsWith('__Secure-') ? exact.slice('__Secure-'.length) : `__Secure-${exact}`;
      const trust = async (member: RecoveryMember, secret: string) => {
        const challenge = await pending(f, member);
        const response = await f.request('/api/auth/two-factor/verify-totp', {
          code: await createOTP(secret).totp(), trustDevice: true,
        }, challenge);
        expect(response.status).toBe(200);
        const cookie = cookies(response).split('; ').find(value => value.startsWith(`${exact}=`))!;
        expect(cookie).toBeDefined();
        const reader = await createInternalContext({ headers: new Headers({ cookie }) }, { options: { method: 'GET' } });
        const value = await reader.getSignedCookie(exact, context.secret);
        expect(typeof value).toBe('string');
        return { cookie, value: value as string, identifier: (value as string).split('!')[1]! };
      };
      const foreignTrust = await trust(a, aSecret);
      const stale = await trust(b, bSecret);
      expect((await f.request('/api/auth/sign-in/email', { email: b.email, password: b.password },
        `${foreignTrust.cookie.replace(exact, opposite)}; ${stale.cookie}`)).status).toBe(400);
      const saved = (await f.pool.query<{
        id: string; identifier: string; value: string; createdAt: Date; updatedAt: Date; expiresAt: Date;
      }>('SELECT * FROM verification WHERE identifier=$1', [stale.identifier])).rows[0]!;
      expect(saved.value).toBe(b.id);
      expect((await proof.activate()).status).toBe(200);
      b.password = 'new independently bound password';
      const replacement = await f.request('/api/auth/sign-in/email', { email: b.email, password: b.password });
      expect(replacement.status).toBe(200);
      b.cookie = cookies(replacement);
      const replacementSecret = await enroll(f, b);
      // Admission has one subject. The inactive fresh B credential stays in
      // the request while the provider-selected stale B trust is suppressed.
      const decoy = await trust(b, replacementSecret);
      // Simulate a restored pre-recovery proof after the real owner completed
      // cleanup. Its original epoch remains stale even with valid signatures.
      await f.pool.query(`INSERT INTO verification (id, identifier, value, "createdAt", "updatedAt", "expiresAt")
        VALUES ($1,$2,$3,$4,$5,$6)`, [saved.id, saved.identifier, saved.value, saved.createdAt, saved.updatedAt, saved.expiresAt]);
      let calls = 0;
      f.auth.handler = async request => {
        calls++;
        const reader = await createInternalContext({ headers: request.headers }, { options: { method: 'GET' } });
        expect(await reader.getSignedCookie(exact, context.secret)).toBeNull();
        expect(await reader.getSignedCookie(opposite, context.secret)).toBe(decoy.value);
        return handler(request);
      };
      for (const reverse of [false, true]) {
        const pairs = [decoy.cookie.replace(exact, opposite), stale.cookie];
        if (reverse) pairs.reverse();
        const response = await f.request('/api/auth/sign-in/email', { email: b.email, password: b.password }, pairs.join('; '));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
        // Read directly through the provider API so instrumentation only
        // observes the two password requests, both after stale suppression.
        expect(await f.auth.api.getSession({ headers: new Headers({ cookie: cookies(response) }) })).toBeNull();
      }
      expect(calls).toBe(2);
      expect((await f.pool.query('SELECT id FROM verification WHERE identifier=$1', [stale.identifier])).rows).toHaveLength(1);
    } finally {
      f.auth.handler = handler;
      await f.close();
    }
  }, 60_000);
