import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createEmailVerificationToken } from 'better-auth/api';
import { createOTP } from '@better-auth/utils/otp';
import { chromium } from '@playwright/test';
import type { PoolClient } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import {
  beginRecoveryPasskeyRegistration,
  acceptGuardian,
  cookies,
  recoveryProof,
  registerRecoveryPasskey,
} from './recovery-fixture.ts';

test('recovery rejects missing approval, the waiting period, wrong proof and expired claims without touching factors', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('refused@example.test');
    const guardian = await f.signup('refused-guardian@example.test');
    const recoveryCode = randomBytes(32).toString('base64url');
    const claimId = randomUUID();
    const path = `/api/account/recovery-claims/${claimId}`;
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          { guardianEmail: guardian.email, recoveryCode, currentPassword: member.password },
          member.cookie,
        )
      ).status,
    ).toBe(200);
    await acceptGuardian(f, member, guardian);
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId,
          recoveryCode,
          targetEmail: member.email,
        })
      ).status,
    ).toBe(200);
    const activation = { recoveryCode, newPassword: 'new independently bound password' };
    expect((await f.request(`${path}/activation`, activation)).status).toBe(403);
    expect((await f.request(`${path}/approval`, {}, guardian.cookie)).status).toBe(200);
    expect((await f.request(`${path}/activation`, activation)).status).toBe(409);
    expect(
      (
        await f.request(`${path}/activation`, {
          ...activation,
          recoveryCode: randomBytes(32).toString('base64url'),
        })
      ).status,
    ).toBe(403);
    await f.pool.query(
      "UPDATE rezics_account_recovery_claim SET not_before = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1",
      [claimId],
    );
    expect((await f.request(`${path}/activation`, activation)).status).toBe(409);
    expect(
      await (await f.request('/api/auth/get-session', undefined, member.cookie)).json(),
    ).not.toBeNull();
    expect(
      (
        await f.pool.query('SELECT generation FROM rezics_account_recovery_policy WHERE id = $1', [
          member.id,
        ])
      ).rows[0].generation,
    ).toBe('0');
    expect(
      (
        await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password: member.password,
        })
      ).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
}, 60_000);

test('recovery atomically revokes passkeys, TOTP, backup codes, links, sessions and OAuth authority; a lost response retries once', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('all-factors@example.test');
    const guardian = await f.signup('guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const passkeySignIn = await registerRecoveryPasskey(f, member, await browser.newPage());
    expect((await passkeySignIn()).status).toBe(200);
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient();
    const tokens = await oauth.issue(client.client_id, member.cookie);
    const pendingCode = await oauth.code(client.client_id, member.cookie);
    const enrolled = await f.request(
      '/api/auth/two-factor/enable',
      { password: member.password },
      member.cookie,
    );
    const enrollment = (await enrolled.json()) as { backupCodes: string[] };
    const secret = await symmetricDecrypt({
      key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id]))
        .rows[0].secret,
    });
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-totp',
          { code: await createOTP(secret).totp() },
          member.cookie,
        )
      ).status,
    ).toBe(200);
    const challenge = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: member.password,
    });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
      (await f.request('/api/auth/request-password-reset', { email: member.email })).status,
    ).toBe(200);
    const resetToken = (
      await f.pool.query(
        "SELECT identifier FROM verification WHERE value = $1 AND identifier LIKE 'reset-password:%'",
        [member.id],
      )
    ).rows[0].identifier.slice('reset-password:'.length);
    const emailToken = await createEmailVerificationToken(f.secret, member.email);
    // Only the fixed indexed identifiers are deleted. Unsupported plugin JSON
    // and unrelated text must not be parsed or swept from the shared inventory.
    const records = [
      [randomUUID(), JSON.stringify({ email: member.email, name: 'Account Test' })],
      [randomUUID(), JSON.stringify({ email: member.email.toUpperCase(), name: 'Account Test' })],
      [`sign-in-otp-${member.email}`, 'hashed-otp:0'],
      [`email-verification-otp-${member.email}`, 'hashed-otp:0'],
      [`forget-password-otp-${member.email}`, 'hashed-otp:0'],
      [randomUUID(), JSON.stringify({ type: 'registration', userData: { id: member.id } })],
      ['trust-device-old', member.id],
      ['unrelated', '{not JSON'],
      ['guardian-link', JSON.stringify({ email: guardian.email })],
    ];
    for (const [identifier, value] of records)
      await f.pool.query(
        `INSERT INTO verification
      (id, identifier, value, "expiresAt", "createdAt", "updatedAt") VALUES ($1,$2,$3,now() + interval '1 day',now(),now())`,
        [randomUUID(), identifier, value],
      );
    // A large unrelated inventory must not turn the password trigger's owner
    // equality cleanup into a verification-table scan.
    await f.pool
      .query(`INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
      SELECT 'ambient-' || n, 'ambient-' || n, 'unrelated-owner-' || n,
        now() + interval '1 day', now(), now() FROM generate_series(1, 4000) n`);
    await f.pool.query('ANALYZE verification');
    const plan = (
      await f.pool.query(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
      DELETE FROM verification WHERE value = $1`,
        [member.id],
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    type CleanupPlan = { 'Index Name'?: string; Plans?: CleanupPlan[] };
    const indexNames = (node: CleanupPlan): string[] => [
      ...(node['Index Name'] ? [node['Index Name']] : []),
      ...(node.Plans ?? []).flatMap(indexNames),
    ];
    expect(indexNames(plan)).toContain('account_verification_value_lookup');
    const responses = await Promise.all([proof.activate(), proof.activate()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const outcomes = await Promise.all(responses.map((response) => response.json()));
    expect(outcomes.map((body) => body.replayed).sort()).toEqual([false, true]);
    expect(outcomes.map((body) => body.recoveryGeneration)).toEqual(['1', '1']);
    expect((await passkeySignIn()).ok).toBe(false);
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-totp',
          { code: await createOTP(secret).totp() },
          cookies(challenge),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-backup-code',
          { code: enrollment.backupCodes[0] },
          cookies(challenge),
        )
      ).ok,
    ).toBe(false);
    expect(
      await (await f.request('/api/auth/get-session', undefined, member.cookie)).json(),
    ).toBeNull();
    expect(
      (
        await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password: member.password,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.request('/api/auth/reset-password', {
          token: resetToken,
          newPassword: 'stolen pending reset password',
        })
      ).ok,
    ).toBe(false);
    expect((await f.request(`/api/auth/verify-email?token=${emailToken}`)).ok).toBe(false);
    const revokedMail = await f.request(
      `/api/auth/verify-email?${new URLSearchParams({ token: emailToken, callbackURL: '/verify-email' })}`,
    );
    expect(revokedMail.status).toBe(302);
    expect(new URL(revokedMail.headers.get('location')!, f.baseURL).searchParams.get('error')).toBe(
      'INVALID_TOKEN',
    );
    const external = await f.request(
      `/api/auth/verify-email?${new URLSearchParams({ token: emailToken, callbackURL: 'https://attacker.example/callback' })}`,
    );
    expect(external.status).toBe(403);
    expect(external.headers.get('location')).toBeNull();
    expect((await oauth.introspect(tokens.access_token)).active).toBe(false);
    const exchange = await oauth.token({ ...pendingCode, grant_type: 'authorization_code' });
    expect(exchange.ok).toBe(false);
    if (tokens.refresh_token)
      expect(
        (
          await oauth.token({
            grant_type: 'refresh_token',
            client_id: client.client_id,
            refresh_token: tokens.refresh_token,
          })
        ).ok,
      ).toBe(false);
    for (const table of [
      'passkey',
      'twoFactor',
      'session',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthConsent',
    ]) {
      expect(
        (await f.pool.query(`SELECT 1 FROM "${table}" WHERE "userId" = $1`, [member.id])).rowCount,
      ).toBe(0);
    }
    expect(
      (
        await f.pool.query(
          'SELECT identifier FROM verification WHERE identifier = ANY($1::text[]) ORDER BY identifier',
          [records.map(([identifier]) => identifier)],
        )
      ).rows,
    ).toEqual(
      records
        .filter(([identifier, value]) => !identifier.includes('-otp-') && value !== member.id)
        .map(([identifier]) => ({ identifier }))
        .sort((a, b) => a.identifier.localeCompare(b.identifier)),
    );
    expect(
      (
        await f.pool.query('SELECT 1 FROM verification WHERE identifier = $1', [
          `reset-password:${resetToken}`,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.request(`/api/auth/reset-password?${new URLSearchParams({ token: resetToken })}`, {
          newPassword: 'stolen query-token reset password',
        })
      ).ok,
    ).toBe(false);
    const signed = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: 'new independently bound password',
    });
    expect(signed.status).toBe(200);
    const currentCookie = cookies(signed);
    expect(
      await (await f.request('/api/account/methods', undefined, currentCookie)).json(),
    ).toMatchObject({ password: true, passkeys: [], totp: null });
    expect(await (await proof.activate()).json()).toMatchObject({
      recoveryGeneration: '1',
      replayed: true,
    });
    expect(
      await (await f.request('/api/auth/get-session', undefined, currentCookie)).json(),
    ).not.toBeNull();
    expect(
      (await f.request('/api/account/recovery-claims', { ...proof.request, claimId: randomUUID() }))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request(`${proof.path}/activation`, {
          recoveryCode: proof.recoveryCode,
          newPassword: 'different replacement password',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.pool.query(
          'SELECT generation, code_hash FROM rezics_account_recovery_policy WHERE id = $1',
          [member.id],
        )
      ).rows,
    ).toEqual([{ generation: '1', code_hash: null }]);
    // The owner can rebuild 2FA with the new password; old proof stays invalid.
    expect(
      (
        await f.request(
          '/api/auth/two-factor/enable',
          { password: 'new independently bound password' },
          currentCookie,
        )
      ).status,
    ).toBe(200);
    expect(await (await proof.activate()).json()).toMatchObject({
      recoveryGeneration: '1',
      replayed: true,
    });
    expect(
      await (await f.request('/api/account/methods', undefined, currentCookie)).json(),
    ).toMatchObject({ totp: { verified: false } });
    // New links carry the post-recovery generation and still complete normally.
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [member.id]);
    expect(
      (
        await f.request(
          '/api/auth/send-verification-email',
          { email: member.email, callbackURL: '/verify-email' },
          currentCookie,
        )
      ).status,
    ).toBe(200);
    await f.email.drain();
    const currentMail = [...f.messages]
      .reverse()
      .find((mail) => mail.to === member.email && mail.subject === 'Verify your email address')!;
    expect((await f.request(/https?:\/\/\S+/.exec(currentMail.text)![0])).status).toBe(302);
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-totp',
          { code: await createOTP(secret).totp() },
          cookies(challenge),
        )
      ).ok,
    ).toBe(false);
  } finally {
    await browser.close();
    await f.close();
  }
}, 90_000);

test('a passwordless passkey-only account rebinds a password and the used recovery code cannot activate another claim', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('passwordless@example.test');
    const guardian = await f.signup('passwordless-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const oldPasskey = await registerRecoveryPasskey(f, member, await browser.newPage());
    expect(
      (await f.request('/api/account/methods/password/remove', {}, member.cookie)).status,
    ).toBe(200);
    expect(
      (await f.pool.query('SELECT 1 FROM account WHERE "userId" = $1', [member.id])).rowCount,
    ).toBe(0);
    expect(
      (
        await f.request('/api/auth/request-password-reset', {
          email: member.email,
          redirectTo: `${f.baseURL}/reset-password`,
        })
      ).status,
    ).toBe(200);
    await f.email.drain();
    const mail = [...f.messages]
      .reverse()
      .find((message) => message.to === member.email && message.subject === 'Reset your password')!;
    const reset = await f.request(/https?:\/\/\S+/.exec(mail.text)![0]);
    const oldToken = new URL(reset.headers.get('location')!, f.baseURL).searchParams.get('token')!;
    const secondId = randomUUID();
    expect(
      (await f.request('/api/account/recovery-claims', { ...proof.request, claimId: secondId }))
        .status,
    ).toBe(200);
    expect(
      (await f.request(`/api/account/recovery-claims/${secondId}/approval`, {}, guardian.cookie))
        .status,
    ).toBe(200);
    expect((await proof.activate()).status).toBe(200);
    expect(
      (
        await f.pool.query('SELECT 1 FROM verification WHERE identifier = $1', [
          `reset-password:${oldToken}`,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await f.request('/api/auth/reset-password', {
          token: oldToken,
          newPassword: 'stolen passwordless account reset password',
        })
      ).status,
    ).toBe(403);
    expect((await oldPasskey()).ok).toBe(false);
    const signed = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: 'new independently bound password',
    });
    expect(signed.status).toBe(200);
    expect(
      (
        await f.request(`/api/account/recovery-claims/${secondId}/activation`, {
          recoveryCode: proof.recoveryCode,
          newPassword: 'new independently bound password',
        })
      ).status,
    ).toBe(409);
  } finally {
    await browser.close();
    await f.close();
  }
}, 60_000);

test('a passkey registration started before recovery cannot finish with an old or newly signed-in session', async () => {
  const f = await accountFixture({}, 'localhost');
  const browser = await chromium.launch({ headless: true });
  try {
    const member = await f.signup('pending-passkey@example.test');
    const guardian = await f.signup('pending-passkey-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const ceremony = await beginRecoveryPasskeyRegistration(f, member, await browser.newPage());
    expect((await proof.activate()).status).toBe(200);
    expect((await ceremony.complete()).ok).toBe(false);
    const current = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: 'new independently bound password',
    });
    expect(current.status).toBe(200);
    expect((await ceremony.complete(cookies(current))).status).toBe(403);
    expect(
      (await f.pool.query('SELECT 1 FROM passkey WHERE "userId" = $1', [member.id])).rowCount,
    ).toBe(0);
    // The owner can still start a fresh registration after recovery.
    const newPasskey = await registerRecoveryPasskey(
      f,
      { ...member, cookie: cookies(current) },
      await browser.newPage(),
    );
    expect((await newPasskey()).status).toBe(200);
  } finally {
    await browser.close();
    await f.close();
  }
}, 60_000);

test('value-keyed verification epochs reject before/equal recovery and admit newly created reset and two-factor proofs', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('verification-epoch@example.test');
    const guardian = await f.signup('verification-epoch-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    const resetIdentifiers: string[] = [];
    for (const suffix of ['before', 'equal']) {
      const identifier = `reset-password:${suffix}-${randomUUID()}`;
      resetIdentifiers.push(identifier);
      await f.pool.query(
        `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,now() + interval '1 day',now(),now())`,
        [randomUUID(), identifier, member.id],
      );
    }
    const initialEnrollment = await f.request(
      '/api/auth/two-factor/enable',
      { password: member.password },
      member.cookie,
    );
    expect(initialEnrollment.status).toBe(200);
    const backupCodes = (await initialEnrollment.json()) as { backupCodes: string[] };
    const originalSecret = await symmetricDecrypt({
      key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id]))
        .rows[0].secret,
    });
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-totp',
          { code: await createOTP(originalSecret).totp() },
          member.cookie,
        )
      ).status,
    ).toBe(200);
    const oldChallenge = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: member.password,
    });
    expect(await oldChallenge.json()).toMatchObject({ twoFactorRedirect: true });
    const signedChallenge = decodeURIComponent(
      /better-auth\.two_factor=([^;]+)/.exec(cookies(oldChallenge))![1],
    );
    const challengeId = signedChallenge.slice(0, signedChallenge.lastIndexOf('.'));
    const deviceChallenge = await f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: member.password,
    });
    const trusted = await f.request(
      '/api/auth/two-factor/verify-backup-code',
      { code: backupCodes.backupCodes[0], trustDevice: true },
      cookies(deviceChallenge),
    );
    expect(trusted.status).toBe(200);
    const trustCookie = cookies(trusted)
      .split('; ')
      .find((cookie) => cookie.startsWith('better-auth.trust_device='))!;
    expect(trustCookie).toBeDefined();
    const trustToken = decodeURIComponent(trustCookie.slice(trustCookie.indexOf('=') + 1));
    const trustId = trustToken.slice(0, trustToken.lastIndexOf('.')).split('!')[1];
    const saved = (
      await f.pool.query<{
        id: string;
        identifier: string;
        value: string;
        expiresAt: Date;
        createdAt: Date;
        updatedAt: Date;
      }>('SELECT * FROM verification WHERE identifier = ANY($1::text[])', [
        [...resetIdentifiers, challengeId, trustId],
      ])
    ).rows;
    expect(saved).toHaveLength(4);
    expect((await proof.activate()).status).toBe(200);
    // Password changes delete these rows through the indexed owner value. A
    // restored or delayed old artifact must still fail against recovered_at.
    for (const artifact of saved) {
      await f.pool.query(
        `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          artifact.id,
          artifact.identifier,
          artifact.value,
          artifact.expiresAt,
          artifact.createdAt,
          artifact.updatedAt,
        ],
      );
    }
    await f.pool.query(
      `UPDATE verification v SET "createdAt" = p.recovered_at
      FROM rezics_account_recovery_policy p WHERE v.identifier = ANY($1::text[]) AND p.id = $2`,
      [[resetIdentifiers[1], challengeId, trustId], member.id],
    );
    for (const identifier of resetIdentifiers) {
      const denied = await f.request('/api/auth/reset-password', {
        token: identifier.slice('reset-password:'.length),
        newPassword: 'stolen pre-recovery reset password',
      });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: 'invalid_token' });
    }
    expect(
      (
        await f.request(
          `/api/auth/reset-password?${new URLSearchParams({
            token: resetIdentifiers[0].slice('reset-password:'.length),
          })}`,
          { newPassword: 'stolen query-token reset password' },
        )
      ).status,
    ).toBe(403);
    const password = 'new independently bound password';
    const current = await f.request('/api/auth/sign-in/email', { email: member.email, password });
    expect(current.status).toBe(200);
    const sessionCookie = cookies(current);
    const enabled = await f.request('/api/auth/two-factor/enable', { password }, sessionCookie);
    expect(enabled.status).toBe(200);
    const newEnrollment = (await enabled.json()) as { backupCodes: string[] };
    const newSecret = await symmetricDecrypt({
      key: f.secret,
      data: (await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id]))
        .rows[0].secret,
    });
    const verified = await f.request(
      '/api/auth/two-factor/verify-totp',
      { code: await createOTP(newSecret).totp() },
      `${sessionCookie}; ${cookies(oldChallenge)}`,
    );
    expect(verified.status).toBe(200);
    const untrusted = await f.request(
      '/api/auth/sign-in/email',
      { email: member.email, password },
      trustCookie,
    );
    expect(await untrusted.json()).toMatchObject({ twoFactorRedirect: true });
    // Even knowledge of the new factor cannot turn an old challenge into a session.
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-totp',
          { code: await createOTP(newSecret).totp() },
          cookies(oldChallenge),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-backup-code',
          { code: newEnrollment.backupCodes[0] },
          cookies(oldChallenge),
        )
      ).status,
    ).toBe(403);
    const challenge = await f.request('/api/auth/sign-in/email', { email: member.email, password });
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    expect(
      (
        await f.request(
          '/api/auth/two-factor/verify-backup-code',
          { code: newEnrollment.backupCodes[0] },
          cookies(challenge),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request('/api/auth/request-password-reset', {
          email: member.email,
          redirectTo: `${f.baseURL}/reset-password`,
        })
      ).status,
    ).toBe(200);
    await f.email.drain();
    const resetMail = [...f.messages]
      .reverse()
      .find((mail) => mail.to === member.email && mail.subject === 'Reset your password')!;
    const redirect = await f.request(/https?:\/\/\S+/.exec(resetMail.text)![0]);
    const token = new URL(redirect.headers.get('location')!, f.baseURL).searchParams.get('token')!;
    expect(
      (
        await f.request('/api/auth/reset-password', {
          token,
          newPassword: 'fresh post-recovery reset password',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password: 'fresh post-recovery reset password',
        })
      ).status,
    ).toBe(200);
  } finally {
    await f.close();
  }
}, 60_000);

test('a failed factor cleanup rolls back the replacement password, factors, sessions and recovery generation', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('rollback@example.test');
    const guardian = await f.signup('rollback-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    expect(
      (await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie))
        .status,
    ).toBe(200);
    await f.pool
      .query(`CREATE FUNCTION reject_factor_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'factor cleanup unavailable'; END $$;
      CREATE TRIGGER reject_factor_cleanup BEFORE DELETE ON "twoFactor" FOR EACH ROW EXECUTE FUNCTION reject_factor_cleanup()`);
    expect((await proof.activate()).status).toBe(503);
    expect(
      await (await f.request('/api/account/methods', undefined, member.cookie)).json(),
    ).toMatchObject({ password: true, totp: { verified: false } });
    expect(
      (
        await f.pool.query(
          'SELECT generation, code_hash FROM rezics_account_recovery_policy WHERE id = $1',
          [member.id],
        )
      ).rows[0],
    ).toMatchObject({ generation: '0', code_hash: expect.any(String) });
    expect(
      (
        await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password: member.password,
        })
      ).status,
    ).toBe(200);
    await f.pool.query(
      'DROP TRIGGER reject_factor_cleanup ON "twoFactor"; DROP FUNCTION reject_factor_cleanup()',
    );
    expect((await proof.activate()).status).toBe(200);
  } finally {
    await f.close();
  }
}, 60_000);

test('authentication waiting on recovery verifies its password after cleanup and cannot resurrect an old session', async () => {
  const f = await accountFixture();
  let db: PoolClient | undefined;
  try {
    const member = await f.signup('waiting@example.test');
    const guardian = await f.signup('waiting-guardian@example.test');
    const proof = await recoveryProof(f, member, guardian);
    expect(
      (await f.request('/api/auth/two-factor/enable', { password: member.password }, member.cookie))
        .status,
    ).toBe(200);
    await f.pool
      .query(`CREATE FUNCTION hold_recovery_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(742012); RETURN OLD; END $$;
      CREATE TRIGGER hold_recovery_cleanup BEFORE DELETE ON "twoFactor" FOR EACH ROW EXECUTE FUNCTION hold_recovery_cleanup()`);
    db = await f.pool.connect();
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(742012)');
    const activating = proof.activate();
    let cleaning = 0;
    const cleanupUntil = Date.now() + 1500;
    do {
      cleaning = (
        await f.pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE wait_event = 'advisory' AND query LIKE 'DELETE FROM public."twoFactor"%'`)
      ).rows[0].n;
      if (!cleaning) await Bun.sleep(10);
    } while (!cleaning && Date.now() < cleanupUntil);
    expect(cleaning).toBe(1);
    const signing = f.request('/api/auth/sign-in/email', {
      email: member.email,
      password: member.password,
    });
    let waiting = 0;
    const until = Date.now() + 1500;
    do {
      waiting = (
        await f.pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT id,%'
          AND query LIKE '%public.rezics_account_recovery_policy%'`)
      ).rows[0].n;
      if (!waiting) await Bun.sleep(10);
    } while (!waiting && Date.now() < until);
    expect(waiting).toBe(1);
    await db.query('COMMIT');
    expect((await activating).status).toBe(200);
    const signed = await signing;
    expect(signed.ok).toBe(false);
    expect(
      (await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [member.id])).rowCount,
    ).toBe(0);
  } finally {
    if (db) {
      await db.query('ROLLBACK');
      db.release();
    }
    await f.close();
  }
}, 60_000);
