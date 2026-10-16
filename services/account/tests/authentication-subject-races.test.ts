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
    f.request(path, body, cookie, { origin: new URL(issuer).origin, ...extra });
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
        expect(provider.mock.calls.filter((call: readonly unknown[]) =>
          new URL((call[0] as Request).url).pathname === '/api/auth/two-factor/verify-totp')).toHaveLength(0);
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

for (const retirementLookup of ['available', 'failed-once', 'pool-exhausted'] as const)
test(`post-provider subject replacement retires issuance with ${retirementLookup} provider lookup and records both failures`, async () => {
  const f = await issuerFixture('https://issuer.test');
  const admission = pause();
  const context = await f.auth.$context;
  const findMany = context.adapter.findMany;
  const deleteSession = context.internalAdapter.deleteSession;
  let providerAuthenticatedUser: string | undefined;
  let providerIssuedCookie = '';
  let providerIssuedToken: string | undefined;
  let failedLookups = 0;
  let cleanupFailures = 0;
  let retirementBeforeCleanup: unknown[] = [];
  let failuresBeforeCleanup: unknown[] = [];
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
    const fencedDeleteSession = context.internalAdapter.deleteSession;
    const handler = f.auth.handler;
    provider = spyOn(f.auth, 'handler').mockImplementation(async request => {
      if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        admission.enter();
        await admission.released;
      }
      const response = await handler(request);
      if (new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        const output = await response.clone().json() as { user?: { id: string }; token?: string };
        providerAuthenticatedUser = output.user?.id;
        providerIssuedCookie = cookies(response);
        providerIssuedToken = output.token;
      }
      return response;
    });
    context.adapter.findMany = async (...args) => {
      const [query] = args;
      if (retirementLookup === 'failed-once' && failedLookups === 0 && providerIssuedToken
        && query.model === 'session'
        && query.where?.some(field => field.field === 'token' && field.value === providerIssuedToken)) {
        failedLookups++;
        // The pinned deleteWithHooks catches this lookup fault and returns
        // without either deleting the session or running its retirement hook.
        throw new Error('provider retirement lookup unavailable');
      }
      return findMany(...args);
    };
    context.internalAdapter.deleteSession = async token => {
      if (token === providerIssuedToken) {
        // A separate connection sees both durable effects before provider
        // cleanup starts: completion of that cleanup proves nothing.
        retirementBeforeCleanup = (await f.pool.query('SELECT rezics_generation FROM "session" WHERE token = $1',
          [token])).rows;
        failuresBeforeCleanup = (await f.pool.query(`SELECT user_id FROM rezics_account_security_event
          WHERE user_id IN ($1, $2) AND action = 'sign_in_failed'
            AND detail->>'reason' = 'provider_subject_changed' ORDER BY user_id COLLATE "C"`,
        [a.id, b.id])).rows;
        if (retirementLookup === 'pool-exhausted') {
          // Native retirement has committed on the request's held client.
          // Exhaust the real owner pool before cleanup borrows another one.
          const maximum = f.pool.options.max;
          const timeout = f.pool.options.connectionTimeoutMillis;
          f.pool.options.max = f.pool.totalCount;
          f.pool.options.connectionTimeoutMillis = 250;
          const blockers = [];
          try {
            while (f.pool.idleCount > 0) blockers.push(await f.pool.connect());
            expect(f.pool.waitingCount).toBe(0);
            try { return await fencedDeleteSession(token); }
            catch (error) { cleanupFailures++; throw error; }
          } finally {
            for (const blocker of blockers) blocker.release();
            f.pool.options.max = maximum;
            f.pool.options.connectionTimeoutMillis = timeout;
          }
        }
      }
      return deleteSession(token);
    };
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
    expect(await (await f.request('/api/auth/get-session', undefined, providerIssuedCookie)).json()).toBeNull();
    expect(failedLookups).toBe(retirementLookup === 'failed-once' ? 1 : 0);
    expect(cleanupFailures).toBe(retirementLookup === 'pool-exhausted' ? 1 : 0);
    expect(retirementBeforeCleanup).toEqual([{ rezics_generation: null }]);
    expect(failuresBeforeCleanup).toEqual([a.id, b.id].sort().map(user_id => ({ user_id })));
    expect((await f.pool.query('SELECT session_cleanup_pending FROM rezics_account_security WHERE user_id = $1',
      [b.id])).rows).toEqual([{ session_cleanup_pending: true }]);
    expect(await liveSessions()).toEqual(sessionsBefore);
    for (const userId of [a.id, b.id]) {
      expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key(userId)])).rows[0]?.count).toBe(1);
      expect((await f.pool.query(`SELECT user_id FROM rezics_account_security_event
        WHERE user_id = $1 AND action = 'sign_in_failed' AND detail->>'reason' = 'provider_subject_changed'`, [userId])).rows).toEqual([{ user_id: userId }]);
    }
    expect((await f.pool.query(`SELECT id FROM rezics_account_security_event
      WHERE user_id IN ($1, $2) AND action = 'sign_in' ORDER BY id`, [a.id, b.id])).rows).toEqual(signInsBefore);
  } finally {
    admission.resume();
    await pending?.catch(() => {});
    provider?.mockRestore();
    context.adapter.findMany = findMany;
    context.internalAdapter.deleteSession = deleteSession;
    await f.close();
  }
}, 60_000);

for (const operation of ['sign-out', 'enroll-totp', 'disable-totp', 'password-challenge'] as const)
test(`${operation} retires its actual session despite one swallowed provider lookup failure`, async () => {
  const f = await issuerFixture('https://issuer.test');
  const context = await f.auth.$context;
  const findMany = context.adapter.findMany;
  const createSession = context.internalAdapter.createSession;
  let failedLookups = 0;
  const issued: { token: string }[] = [];
  try {
    const member = await f.signup('native-retirement@example.test');
    let totpSecret: string | undefined;
    if (operation === 'disable-totp' || operation === 'password-challenge') {
      const secret = await enroll(f, member);
      if (operation === 'disable-totp') {
        // Factor removal requires a fresh proof of the enrolled authenticator.
        expect((await f.request('/api/account/reauthenticate', { password: member.password,
          totpCode: await createOTP(secret).totp() }, member.cookie)).status).toBe(200);
      }
    }
    if (operation === 'enroll-totp') {
      expect((await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie)).status).toBe(200);
      totpSecret = await symmetricDecrypt({ key: f.secret,
        data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    }
    const previous = await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) });
    expect(previous).not.toBeNull();
    context.adapter.findMany = async (...args) => {
      const [query] = args;
      if (!failedLookups && query.model === 'session' && query.limit === 1
        && query.where?.some(field => field.field === 'token')) {
        failedLookups++;
        throw new Error('provider session lookup unavailable');
      }
      return findMany(...args);
    };
    context.internalAdapter.createSession = async (...args) => {
      const session = await createSession(...args);
      if (session) issued.push(session);
      return session;
    };
    const response = operation === 'sign-out'
      ? await f.request('/api/auth/sign-out', {}, member.cookie)
      : operation === 'enroll-totp'
        ? await f.request('/api/auth/two-factor/verify-totp', { code: await createOTP(totpSecret!).totp() }, member.cookie)
        : operation === 'disable-totp'
          ? await f.request('/api/auth/two-factor/disable', { password: member.password }, member.cookie)
          : await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(response.status).toBe(200);
    expect(failedLookups).toBe(1);
    const retiredToken = operation === 'password-challenge' ? issued[0]!.token : previous!.session.token;
    expect((await f.pool.query('SELECT rezics_generation FROM "session" WHERE token = $1',
      [retiredToken])).rows).toEqual([{ rezics_generation: null }]);
    const retiredCookie = await serializeSignedCookie(context.authCookies.sessionToken.name, retiredToken, context.secret);
    expect(await (await f.request('/api/auth/get-session', undefined, retiredCookie)).json()).toBeNull();
    if (operation === 'password-challenge') expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    else if (operation !== 'sign-out') {
      expect(issued).toHaveLength(1);
      expect(await f.auth.api.getSession({ headers: new Headers({ cookie: cookies(response) }) })).not.toBeNull();
    }
  } finally {
    context.adapter.findMany = findMany;
    context.internalAdapter.createSession = createSession;
    await f.close();
  }
}, 60_000);

test('sign-out refuses native retirement failure and succeeds after storage recovers', async () => {
  const f = await issuerFixture('https://issuer.test');
  // The provider skips origin checks by default in its test environment.
  // Exercise the production admission rule before making retirement fail.
  (await f.auth.$context).skipOriginCheck = false;
  try {
    const member = await f.signup('retirement-storage-failure@example.test');
    expect((await f.request('/api/auth/sign-out', {}, member.cookie, { origin: 'https://other.test' })).status).toBe(403);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) })).not.toBeNull();
    await f.pool.query(`CREATE FUNCTION refuse_session_retirement() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'retirement unavailable'; END $$;
      CREATE TRIGGER refuse_session_retirement BEFORE UPDATE OF rezics_generation ON "session"
      FOR EACH ROW WHEN (NEW.rezics_generation IS NULL) EXECUTE FUNCTION refuse_session_retirement()`);
    expect((await f.request('/api/auth/sign-out', {}, member.cookie)).status).toBe(503);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) })).not.toBeNull();
    await f.pool.query('DROP TRIGGER refuse_session_retirement ON "session"');
    expect((await f.request('/api/auth/sign-out', {}, member.cookie)).status).toBe(200);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) })).toBeNull();
  } finally { await f.close(); }
}, 60_000);

for (const completion of ['provider-error', 'handler-error'] as const)
test(`post-provider creation evidence survives ${completion} and retires its actual session`, async () => {
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
      const response = await handler(request);
      if (completion === 'handler-error' && created
        && new URL(request.url).pathname === '/api/auth/two-factor/verify-totp') {
        throw new APIError('SERVICE_UNAVAILABLE', { message: 'late handler completion unavailable' });
      }
      return response;
    });
    context.internalAdapter.createSession = async (...args) => {
      const session = await createSession(...args);
      if (args[0] === b.id && session) {
        created = session;
        // The provider really inserted B's session. No success body/newSession
        // has been produced yet; its database hook must retain this evidence.
        if (completion === 'provider-error') throw new APIError('SERVICE_UNAVAILABLE', { message: 'late provider completion unavailable' });
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
        WHERE user_id=$1 AND action='sign_in_failed' AND detail->>'reason'='provider_subject_changed'`, [userId])).rows).toEqual([{ user_id: userId }]);
    }
  } finally {
    admission.resume();
    await pending?.catch(() => {});
    provider?.mockRestore();
    context.internalAdapter.createSession = createSession;
    await f.close();
  }
}, 60_000);
