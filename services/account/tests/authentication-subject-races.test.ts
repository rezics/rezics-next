import { expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { createInternalContext, serializeSignedCookie } from 'better-call';
import { APIError } from 'better-auth/api';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof, type RecoveryFixture, type RecoveryMember } from './recovery-fixture.ts';

function pause() {
  let enter = () => {};
  let resume = () => {};
  const entered = new Promise<'paused'>(resolve => { enter = () => resolve('paused'); });
  const released = new Promise<void>(resolve => { resume = resolve; });
  return { enter, resume, entered, released };
}

async function issuerFixture(issuer: string) {
  const f = await accountFixture({ baseURL: issuer, requireEmailVerification: false });
  const request: typeof f.request = (path, body, cookie, extra = {}) =>
    f.request(path, body, cookie, { ...extra, origin: new URL(issuer).origin });
  const signup = async (email: string): Promise<RecoveryMember> => {
    const password = 'correct horse battery staple';
    const created = await request('/api/auth/sign-up/email', { email, password, name: 'Subject race' });
    expect(created.status).toBe(200);
    const { user } = await created.json() as { user: { id: string } };
    await f.email.drain();
    const mail = [...f.messages].reverse().find(message => message.to === email)!;
    const verify = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    expect((await request(`${verify.pathname}${verify.search}`)).status).toBe(302);
    const signed = await request('/api/auth/sign-in/email', { email, password });
    expect(signed.status).toBe(200);
    return { id: user.id, email, password, cookie: cookies(signed) };
  };
  return { ...f, request, signup };
}

async function enroll(f: RecoveryFixture, member: RecoveryMember) {
  expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
  const secret = await symmetricDecrypt({ key: f.secret,
    data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
  const verified = await f.request('/api/auth/two-factor/verify-totp',
    { code: await createOTP(secret).totp() }, member.cookie);
  expect(verified.status).toBe(200);
  member.cookie = cookies(verified);
  return secret;
}

async function challenge(f: RecoveryFixture, member: RecoveryMember) {
  const context = await f.auth.$context;
  const name = context.createAuthCookie('two_factor').name;
  const response = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
  expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
  const cookie = cookies(response).split('; ').find(value => value.startsWith(`${name}=`))!;
  expect(cookie).toBeDefined();
  const reader = await createInternalContext({ headers: new Headers({ cookie }) }, { options: { method: 'GET' } });
  const identifier = await reader.getSignedCookie(name, context.secret);
  expect(typeof identifier).toBe('string');
  return { cookie, identifier: identifier as string };
}

async function waitForRecovery(f: RecoveryFixture, recovery: Promise<Response>) {
  let finished = false;
  void recovery.then(() => { finished = true; });
  const until = Date.now() + 1500;
  do {
    const waiting = (await f.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE '%rezics_account_recovery_policy%'`)).rows[0].n as number;
    if (waiting) return true;
    if (finished) return false;
    await Bun.sleep(10);
  } while (Date.now() < until);
  return false;
}

async function deniedWithoutSession(f: RecoveryFixture, response: Response) {
  expect([400, 401, 403, 409]).toContain(response.status);
  expect(await response.clone().json()).toMatchObject({ error: expect.any(String) });
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(await (await f.request('/api/auth/get-session', undefined, cookies(response))).json()).toBeNull();
}

for (const issuer of ['http://issuer.test', 'https://issuer.test', 'HTTPS://issuer.test']) {
  test(`P1 pending challenge uses initialized ${issuer} recovery lock after consumption`, async () => {
    const f = await issuerFixture(issuer);
    const gate = pause();
    const context = await f.auth.$context;
    const createSession = context.internalAdapter.createSession;
    let pending: Promise<Response> | undefined;
    let recovering: Promise<Response> | undefined;
    try {
      const owner = await f.signup('challenge-owner@example.test');
      const guardian = await f.signup('challenge-guardian@example.test');
      const proof = await recoveryProof(f, owner, guardian);
      const secret = await enroll(f, owner);
      const credential = await challenge(f, owner);
      context.internalAdapter.createSession = async (...args) => {
        if (args[0] === owner.id) {
          // Better Auth has consumed the challenge and verified the factor.
          // Its next write would stamp the current recovery generation.
          gate.enter();
          await gate.released;
        }
        return createSession(...args);
      };
      pending = f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(secret).totp() }, credential.cookie);
      expect(await Promise.race([gate.entered, pending.then(() => 'finished')])).toBe('paused');
      expect((await f.pool.query('SELECT id FROM verification WHERE identifier = $1', [credential.identifier])).rows).toEqual([]);
      recovering = proof.activate();
      const blocked = await waitForRecovery(f, recovering);
      gate.resume();
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await recovering).status).toBe(200);
      // An unguarded createSession after recovery produces a usable token with
      // the new generation; the protected exchange is deleted by recovery.
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(response))).json()).toBeNull();
      expect(blocked).toBe(true);
    } finally {
      gate.resume();
      await pending?.catch(() => {});
      await recovering?.catch(() => {});
      context.internalAdapter.createSession = createSession;
      await f.close();
    }
  }, 60_000);
}

for (const issuer of ['http://issuer.test', 'https://issuer.test', 'HTTPS://issuer.test']) {
  test(`P1 ${issuer} refuses A session and B challenge before revoked-session fallback`, async () => {
    const f = await issuerFixture(issuer);
    const admission = pause();
    const creation = pause();
    const context = await f.auth.$context;
    const createSession = context.internalAdapter.createSession;
    let pending: Promise<Response> | undefined;
    let recovering: Promise<Response> | undefined;
    let provider: ReturnType<typeof spyOn> | undefined;
    try {
      const a = await f.signup('session-a@example.test');
      const b = await f.signup('challenge-b@example.test');
      const guardian = await f.signup('fallback-guardian@example.test');
      const proof = await recoveryProof(f, b, guardian);
      const bSecret = await enroll(f, b);
      const bChallenge = await challenge(f, b);
      const other = await f.request('/api/auth/sign-in/email', { email: a.email, password: a.password });
      expect(other.status).toBe(200);
      const aSession = await f.auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) });
      expect(aSession?.user.id).toBe(a.id);
      const handler = f.auth.handler;
      provider = spyOn(f.auth, 'handler').mockImplementation(async request => {
        if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
          admission.enter();
          await admission.released;
        }
        return handler(request);
      });
      context.internalAdapter.createSession = async (...args) => {
        if (args[0] === b.id) { creation.enter(); await creation.released; }
        return createSession(...args);
      };
      pending = f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(bSecret).totp() },
        `${a.cookie}; ${bChallenge.cookie}`);
      const admitted = await Promise.race([admission.entered, pending.then(() => 'finished')]);
      if (admitted === 'finished') {
        expect(provider.mock.calls.filter(([request]) =>
          new URL((request as Request).url).pathname === '/api/auth/two-factor/verify-totp')).toHaveLength(0);
        await deniedWithoutSession(f, await pending);
        return;
      }
      // Run the review's actual interleaving on the retained implementation.
      // Revocation uses another live session, rather than direct session SQL.
      expect((await f.request('/api/auth/revoke-session', { token: aSession!.session.token }, cookies(other))).status).toBe(200);
      expect(await f.auth.api.getSession({ headers: new Headers({ cookie: a.cookie }) })).toBeNull();
      admission.resume();
      const reached = await Promise.race([creation.entered, pending.then(() => 'finished')]);
      if (reached === 'finished') {
        await deniedWithoutSession(f, await pending);
        return;
      }
      recovering = proof.activate();
      const blocked = await waitForRecovery(f, recovering);
      creation.resume();
      const response = await pending;
      expect((await recovering).status).toBe(200);
      // Any request which reached the provider with two subjects must still
      // fail closed, including a subject change during provider execution.
      await deniedWithoutSession(f, response);
      expect(blocked).toBe(true);
    } finally {
      admission.resume();
      creation.resume();
      await pending?.catch(() => {});
      await recovering?.catch(() => {});
      provider?.mockRestore();
      context.internalAdapter.createSession = createSession;
      await f.close();
    }
  }, 60_000);
}

test('post-provider subject replacement denies issuance, charges both users and records the change', async () => {
  const f = await issuerFixture('https://issuer.test');
  const admission = pause();
  let providerAuthenticatedUser: string | undefined;
  let providerIssuedCookie = '';
  let pending: Promise<Response> | undefined;
  let provider: ReturnType<typeof spyOn> | undefined;
  try {
    const a = await f.signup('proof-a@example.test');
    const b = await f.signup('proof-b@example.test');
    await enroll(f, a);
    const bSecret = await enroll(f, b);
    const aChallenge = await challenge(f, a);
    const key = (id: string) => createHmac('sha256', f.secret).update(`reauth:${id}`).digest('hex');
    await f.pool.query(`UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds'
      WHERE key IN ($1, $2)`, [key(a.id), key(b.id)]);
    const liveSessions = async () => (await f.pool.query(`SELECT s.id FROM "session" s
      JOIN rezics_account_security p ON p.user_id = s."userId"
      WHERE s."userId" = $1 AND s.rezics_generation = p.session_generation
        AND s."expiresAt" > clock_timestamp() ORDER BY s.id`, [b.id])).rows;
    const sessionsBefore = await liveSessions();
    const signInsBefore = (await f.pool.query(`SELECT id FROM rezics_account_security_event
      WHERE user_id IN ($1, $2) AND action = 'sign_in' ORDER BY id`, [a.id, b.id])).rows;
    const handler = f.auth.handler;
    provider = spyOn(f.auth, 'handler').mockImplementation(async request => {
      if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        admission.enter();
        await admission.released;
      }
      const response = await handler(request);
      if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        const output = await response.clone().json() as { user?: { id: string } };
        providerAuthenticatedUser = output.user?.id;
        providerIssuedCookie = cookies(response);
      }
      return response;
    });
    pending = f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(bSecret).totp() }, aChallenge.cookie);
    expect(await Promise.race([admission.entered, pending.then(() => 'finished')])).toBe('paused');
    // One signed A challenge is admitted. Replace its owner after Account's
    // lock/budget selection; the real provider then authenticates B's factor.
    expect((await f.pool.query('UPDATE verification SET value = $2 WHERE identifier = $1',
      [aChallenge.identifier, b.id])).rowCount).toBe(1);
    admission.resume();
    const response = await pending;
    expect(providerAuthenticatedUser).toBe(b.id);
    expect(response.status).toBe(403);
    expect(await response.clone().json()).toMatchObject({ error: 'stale_request' });
    await deniedWithoutSession(f, response);
    // The native owner logically retires sessions before bounded physical
    // cleanup. Prove its actual issued credential is unusable, and that no
    // additional live generation-fenced session remains.
    expect(providerIssuedCookie).not.toBe('');
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: providerIssuedCookie }) })).toBeNull();
    expect(await liveSessions()).toEqual(sessionsBefore);
    for (const userId of [a.id, b.id]) {
      expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key(userId)])).rows[0]?.count).toBe(1);
      expect((await f.pool.query(`SELECT user_id FROM rezics_account_security_event
        WHERE user_id = $1 AND action = 'authentication_subject_changed'`, [userId])).rows).toEqual([{ user_id: userId }]);
    }
    expect((await f.pool.query(`SELECT id FROM rezics_account_security_event
      WHERE user_id IN ($1, $2) AND action = 'sign_in' ORDER BY id`, [a.id, b.id])).rows).toEqual(signInsBefore);
  } finally {
    admission.resume();
    await pending?.catch(() => {});
    provider?.mockRestore();
    await f.close();
  }
}, 60_000);

test('post-provider creation evidence survives a later provider error and retires its actual session', async () => {
  const f = await issuerFixture('HTTPS://issuer.test');
  const admission = pause();
  const context = await f.auth.$context;
  const createSession = context.internalAdapter.createSession;
  let pending: Promise<Response> | undefined;
  let provider: ReturnType<typeof spyOn> | undefined;
  let created: { token: string; userId: string } | undefined;
  try {
    const a = await f.signup('late-error-a@example.test');
    const b = await f.signup('late-error-b@example.test');
    await enroll(f, a);
    const bSecret = await enroll(f, b);
    const credential = await challenge(f, a);
    const key = (id: string) => createHmac('sha256', f.secret).update(`reauth:${id}`).digest('hex');
    await f.pool.query(`UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds'
      WHERE key IN ($1, $2)`, [key(a.id), key(b.id)]);
    const handler = f.auth.handler;
    provider = spyOn(f.auth, 'handler').mockImplementation(async request => {
      if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        admission.enter();
        await admission.released;
      }
      return handler(request);
    });
    context.internalAdapter.createSession = async (...args) => {
      const session = await createSession(...args);
      if (args[0] === b.id && session) {
        created = session;
        // The provider really inserted B's session. No success body/newSession
        // has been produced yet; its database hook must retain this evidence.
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'late provider completion unavailable' });
      }
      return session;
    };
    pending = f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(bSecret).totp() }, credential.cookie);
    expect(await Promise.race([admission.entered, pending.then(() => 'finished')])).toBe('paused');
    expect((await f.pool.query('UPDATE verification SET value=$2 WHERE identifier=$1',
      [credential.identifier, b.id])).rowCount).toBe(1);
    admission.resume();
    const response = await pending;
    expect(created?.userId).toBe(b.id);
    expect(response.status).toBe(403);
    expect(await response.clone().json()).toMatchObject({ error: 'stale_request' });
    await deniedWithoutSession(f, response);
    const cookie = await serializeSignedCookie(context.authCookies.sessionToken.name, created!.token, context.secret);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    for (const userId of [a.id, b.id]) {
      expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key=$1', [key(userId)])).rows[0]?.count).toBe(1);
      expect((await f.pool.query(`SELECT user_id FROM rezics_account_security_event
        WHERE user_id=$1 AND action='authentication_subject_changed'`, [userId])).rows).toEqual([{ user_id: userId }]);
    }
  } finally {
    admission.resume();
    await pending?.catch(() => {});
    provider?.mockRestore();
    context.internalAdapter.createSession = createSession;
    await f.close();
  }
}, 60_000);
