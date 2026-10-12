import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import { accountFixture } from './account-fixture.ts';
import { cookies } from './recovery-fixture.ts';

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
    await f.pool.query('UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1', [member.id]);
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

    // Pending sign-in proofs retain their provider-owned challenge budget.
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
    const responses = await Promise.all(Array.from({ length: 8 }, (_, attempt) =>
      f.request('/api/auth/two-factor/verify-totp', {
        code: 'invalid', email: `parallel-${attempt}@example.test`,
      }, attempt % 2 ? firstCookie : cookies(otherSession))));
    expect(responses.filter(response => response.status === 429)).toHaveLength(3);
    expect(responses.every(response => !response.ok)).toBe(true);
    const key = createHmac('sha256', f.secret).update(`reauth:${member.id}`).digest('hex');
    expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key])).rows[0].count).toBe(5);
    await f.pool.query("UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds' WHERE key = $1", [key]);
    expect((await f.request('/api/account/reauthenticate', {
      password: member.password, totpCode: await createOTP(secret).totp(),
    }, firstCookie)).status).toBe(200);
    expect((await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key = $1', [key])).rows[0].count).toBe(1);
  } finally { await f.close(); }
}, 60_000);
