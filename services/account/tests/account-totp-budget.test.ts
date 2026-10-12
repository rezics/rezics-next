import { expect, spyOn, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Client } from 'pg';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { accountFixture } from './account-fixture.ts';
import { cookies } from './recovery-fixture.ts';

function userBudgetKey(secret: string, userId: string) {
  return createHmac('sha256', secret).update(`reauth:${userId}`).digest('hex');
}

async function expireUserBudget(f: Awaited<ReturnType<typeof accountFixture>>, userId: string) {
  await f.pool.query("UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds' WHERE key = $1",
    [userBudgetKey(f.secret, userId)]);
}

// The unfenced implementation pauses after its stale read. Once verification
// is serialized, pause before admission so enrollment can finish first.
function pauseFactorAdmission(userId: string) {
  let resume = () => {};
  let entered = () => {};
  const paused = new Promise<'paused'>(resolve => { entered = () => resolve('paused'); });
  const released = new Promise<void>(resolve => { resume = resolve; });
  let intercepted = false;
  const query = Client.prototype.query;
  const interception = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    const text = args[0];
    if (!intercepted && typeof text === 'string' && text.includes('pg_advisory_xact_lock')
      && Array.isArray(args[1]) && args[1][0] === `account-totp:${userId}`) {
      intercepted = true;
      entered();
      return released.then(() => Reflect.apply(query, this, args));
    }
    const result: unknown = Reflect.apply(query, this, args);
    if (!intercepted && text === 'SELECT verified FROM "twoFactor" WHERE "userId" = $1'
      && Array.isArray(args[1]) && args[1][0] === userId && result instanceof Promise) {
      intercepted = true;
      return result.then(async value => { entered(); await released; return value; });
    }
    return result;
  } as typeof Client.prototype.query);
  return { paused, resume: () => resume(), restore: () => interception.mockRestore() };
}

for (const verified of [false, true]) {
  test(`TOTP admission observes a concurrently enrolled ${verified ? 'verified' : 'unverified'} factor with budget available`, async () => {
    const f = await accountFixture();
    let admission: ReturnType<typeof pauseFactorAdmission> | undefined;
    try {
      const member = await f.signup(`totp-factor-race-${verified}@example.test`);
      await f.pool.query('UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1', [member.id]);
      const otherSession = await f.request('/api/auth/sign-in/email', {
        email: member.email, password: member.password,
      });
      expect(otherSession.status).toBe(200);
      const freshCookie = cookies(otherSession);
      const secret = 'deterministic-enrollment-race-secret';
      admission = pauseFactorAdmission(member.id);
      const pending = f.request('/api/auth/two-factor/verify-totp', {
        code: await createOTP(secret).totp(),
      }, member.cookie);
      expect(await Promise.race([admission.paused, pending.then(() => 'finished' as const)])).toBe('paused');
      expect((await f.request('/api/auth/two-factor/enable', {
        password: member.password,
      }, freshCookie)).status).toBe(200);
      await f.pool.query('UPDATE "twoFactor" SET secret = $2 WHERE "userId" = $1',
        [member.id, await symmetricEncrypt({ key: f.secret, data: secret })]);
      if (verified) {
        expect((await f.request('/api/auth/two-factor/verify-totp', {
          code: await createOTP(secret).totp(),
        }, freshCookie)).status).toBe(200);
        await expireUserBudget(f, member.id);
      }
      const provider = spyOn(f.auth, 'handler');
      try {
        admission.resume();
        const response = await pending;
        expect(response.status).toBe(verified ? 200 : 403);
        if (!verified) {
          expect(await response.json()).toEqual({ error: 'step_up_required' });
          expect(provider).not.toHaveBeenCalled();
        }
      } finally { provider.mockRestore(); }
      expect((await f.pool.query('SELECT verified FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].verified).toBe(verified);
      const budget = await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1',
        [userBudgetKey(f.secret, member.id)]);
      expect(verified ? budget.rows[0].count : budget.rowCount).toBe(verified ? 1 : 0);
    } finally { admission?.resume(); admission?.restore(); await f.close(); }
  }, 60_000);
}

test('signed-in TOTP guesses share the immutable user reauthentication budget', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('totp-budget@example.test');
    expect((await f.request('/api/auth/two-factor/enable', {
      password: member.password,
    }, member.cookie)).status).toBe(200);
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const verified = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, member.cookie);
    expect(verified.status).toBe(200);
    const cookie = cookies(verified);
    await expireUserBudget(f, member.id);
    await f.pool.query('UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1', [member.id]);
    expect((await f.request('/api/auth/two-factor/verify-totp', undefined, cookie)).status).toBe(404);
    expect((await f.request('/api/account/reauthenticate', {
      password: 'incorrect',
    }, cookie)).status).toBe(403);
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid', email: `ignored-${attempt}@example.test`,
      }, cookie);
      expect(response.ok).toBe(false);
      expect(response.status).not.toBe(429);
    }
    const denied = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(), email: 'another-ignored@example.test',
    }, cookie);
    expect(denied.status).toBe(429);
    expect(await denied.json()).toEqual({ error: 'rate_limited' });
    expect((await f.request('/api/account/reauthenticate', {
      password: member.password, totpCode: await createOTP(secret).totp(),
    }, cookie)).status).toBe(429);
    expect((await f.pool.query('SELECT 1 FROM rezics_account_step_up WHERE session_id IN (SELECT id FROM "session" WHERE "userId" = $1)', [member.id])).rowCount).toBe(0);

    // Signed-out proofs have their own provider budget, independent of step-up.
    const challenge = await f.request('/api/auth/sign-in/email', {
      email: member.email, password: member.password,
    });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    expect((await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, cookies(challenge))).status).toBe(200);
  } finally { await f.close(); }
}, 60_000);

test('concurrent signed-in TOTP sessions cannot overspend and the user budget expires', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('totp-concurrent@example.test');
    expect((await f.request('/api/auth/two-factor/enable', {
      password: member.password,
    }, member.cookie)).status).toBe(200);
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const verified = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, member.cookie);
    expect(verified.status).toBe(200);
    const firstCookie = cookies(verified);
    const challenge = await f.request('/api/auth/sign-in/email', {
      email: member.email, password: member.password,
    });
    const otherSession = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, cookies(challenge));
    expect(otherSession.status).toBe(200);
    await expireUserBudget(f, member.id);
    // Eight callers exceed the four-connection guard pool together. Every
    // admitted proof must reach the provider without a nested pool checkout.
    const responses = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid', email: `parallel-${index}@example.test`,
      }, index % 2 ? firstCookie : cookies(otherSession))));
    expect(responses.filter(response => response.status === 429)).toHaveLength(3);
    expect(responses.filter(response => response.status === 401)).toHaveLength(5);
    expect(responses.some(response => response.status === 503)).toBe(false);
    expect(await Promise.all(responses.filter(response => response.status === 401)
      .map(response => response.json()))).toEqual(Array.from({ length: 5 }, () =>
      expect.objectContaining({ code: 'INVALID_CODE' })));
    const key = userBudgetKey(f.secret, member.id);
    expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key])).rows[0].count).toBe(5);
    await f.pool.query("UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds' WHERE key = $1", [key]);
    expect((await f.request('/api/account/reauthenticate', {
      password: member.password, totpCode: await createOTP(secret).totp(),
    }, firstCookie)).status).toBe(200);
    expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key])).rows[0].count).toBe(1);
  } finally { await f.close(); }
}, 60_000);

test('pending TOTP sign-in exhausts both challenge and account attempt limits', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('totp-pending-limits@example.test');
    expect((await f.request('/api/auth/two-factor/enable', {
      password: member.password,
    }, member.cookie)).status).toBe(200);
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    expect((await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, member.cookie)).status).toBe(200);

    const challenge = async () => {
      const response = await f.request('/api/auth/sign-in/email', {
        email: member.email, password: member.password,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
      return cookies(response);
    };
    const firstChallenge = await challenge();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid',
      }, firstChallenge);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    // A correct proof after the challenge allowance must invalidate the
    // challenge rather than create a session or reset the account failures.
    const challengeDenied = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, firstChallenge);
    expect(challengeDenied.status).toBe(400);
    expect(await challengeDenied.json()).toMatchObject({ code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' });
    const staleChallenge = await f.request('/api/auth/two-factor/verify-totp', {
      code: 'invalid',
    }, firstChallenge);
    expect(staleChallenge.status).toBe(401);
    expect(await staleChallenge.json()).toMatchObject({ code: 'INVALID_TWO_FACTOR_COOKIE' });
    expect((await f.pool.query('SELECT "failedVerificationCount", "lockedUntil" FROM "twoFactor" WHERE "userId" = $1',
      [member.id])).rows[0]).toMatchObject({ failedVerificationCount: 5, lockedUntil: null });

    const secondChallenge = await challenge();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid',
      }, secondChallenge);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    const factor = (await f.pool.query('SELECT "failedVerificationCount", "lockedUntil" FROM "twoFactor" WHERE "userId" = $1',
      [member.id])).rows[0];
    expect(factor.failedVerificationCount).toBe(10);
    expect(new Date(factor.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    // A fresh challenge cannot sidestep the account allowance.
    const freshChallenge = await challenge();
    for (const code of ['invalid', await createOTP(secret).totp()]) {
      const denied = await f.request('/api/auth/two-factor/verify-totp', { code }, freshChallenge);
      expect(denied.status).toBe(429);
      expect(await denied.json()).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
      expect(await (await f.request('/api/auth/get-session', undefined, cookies(denied))).json()).toBeNull();
    }
    expect((await f.pool.query('SELECT "failedVerificationCount" FROM "twoFactor" WHERE "userId" = $1',
      [member.id])).rows[0].failedVerificationCount).toBe(10);
  } finally { await f.close(); }
}, 60_000);

test('TOTP verification charges the user budget after a no-factor snapshot races enrollment', async () => {
  const f = await accountFixture();
  let admission: ReturnType<typeof pauseFactorAdmission> | undefined;
  try {
    const member = await f.signup('totp-enrollment-race@example.test');
    const otherSession = await f.request('/api/auth/sign-in/email', {
      email: member.email, password: member.password,
    });
    expect(otherSession.status).toBe(200);
    const secret = 'deterministic-enrollment-race-secret';
    admission = pauseFactorAdmission(member.id);
    const pending = f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, member.cookie);
    expect(await Promise.race([admission.paused, pending.then(() => 'finished' as const)])).toBe('paused');
    const otherCookie = cookies(otherSession);
    expect((await f.request('/api/auth/two-factor/enable', {
      password: member.password,
    }, otherCookie)).status).toBe(200);
    // Seed a known secret so the already-paused proof is correct for the
    // factor that this session is about to confirm.
    await f.pool.query('UPDATE "twoFactor" SET secret = $2 WHERE "userId" = $1',
      [member.id, await symmetricEncrypt({ key: f.secret, data: secret })]);
    const verified = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, otherCookie);
    expect(verified.status).toBe(200);
    await expireUserBudget(f, member.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await f.request('/api/account/reauthenticate', {
        password: 'incorrect',
      }, cookies(verified))).status).toBe(403);
    }
    const count = (await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1',
      [userBudgetKey(f.secret, member.id)])).rows[0].count;
    expect(count).toBe(5);
    admission.resume();
    const response = await pending;
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate_limited' });
  } finally { admission?.resume(); admission?.restore(); await f.close(); }
}, 60_000);

test('TOTP infrastructure failures roll back attempts before a later proof can use them', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('totp-unavailable-budget@example.test');
    expect((await f.request('/api/auth/two-factor/enable', {
      password: member.password,
    }, member.cookie)).status).toBe(200);
    const secret = await symmetricDecrypt({ key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])).rows[0].secret });
    const verified = await f.request('/api/auth/two-factor/verify-totp', {
      code: await createOTP(secret).totp(),
    }, member.cookie);
    expect(verified.status).toBe(200);
    const cookie = cookies(verified);
    for (const failure of ['response', 'exception']) {
      await expireUserBudget(f, member.id);
      const before = (await f.pool.query('SELECT count, started_at FROM rezics_account_rate_limit WHERE key = $1',
        [userBudgetKey(f.secret, member.id)])).rows[0];
      const provider = spyOn(f.auth, 'handler').mockImplementationOnce(async () => {
        if (failure === 'exception') throw new Error('injected provider database failure');
        return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
      });
      try {
        const unavailable = await f.request('/api/auth/two-factor/verify-totp', {
          code: await createOTP(secret).totp(),
        }, cookie);
        expect(unavailable.status).toBe(503);
        expect(provider).toHaveBeenCalledTimes(1);
      } finally { provider.mockRestore(); }
      expect((await f.pool.query('SELECT count, started_at FROM rezics_account_rate_limit WHERE key = $1',
        [userBudgetKey(f.secret, member.id)])).rows[0]).toEqual(before);
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await f.request('/api/auth/two-factor/verify-totp', { code: 'invalid' }, cookie);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: 'INVALID_CODE' });
      }
      expect((await f.request('/api/auth/two-factor/verify-totp', {
        code: await createOTP(secret).totp(),
      }, cookie)).status).toBe(429);
      expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1',
        [userBudgetKey(f.secret, member.id)])).rows[0].count).toBe(5);
    }
  } finally { await f.close(); }
}, 60_000);
