import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createOTP } from '@better-auth/utils/otp';
import type { PoolClient } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { cookies, recoveryProof } from './recovery-fixture.ts';

const code = () => randomBytes(32).toString('base64url');

for (const state of ['first', 'spent']) {
  test(`recovery enrollment: ${state} policy requires password plus TOTP for an old session`, async () => {
    const f = await accountFixture();
    try {
      let member = await f.signup(`${state}-owner@example.test`);
      const guardian = await f.signup(`${state}-guardian@example.test`);
      if (state === 'spent') {
        const proof = await recoveryProof(f, member, guardian);
        expect((await proof.activate()).status).toBe(200);
        const password = 'new independently bound password';
        const signed = await f.request('/api/auth/sign-in/email', {
          email: member.email,
          password,
        });
        expect(signed.status).toBe(200);
        member = { ...member, password, cookie: cookies(signed) };
        // Simulate elapsed time while keeping this post-recovery session newer
        // than the credential epoch checked inside the enrollment transaction.
        await f.pool.query(
          "UPDATE rezics_account_recovery_policy SET recovered_at = now() - interval '20 minutes' WHERE id = $1",
          [member.id],
        );
      }
      expect(
        (
          await f.request(
            '/api/auth/two-factor/enable',
            { password: member.password },
            member.cookie,
          )
        ).status,
      ).toBe(200);
      const secret = await symmetricDecrypt({
        key: f.secret,
        data: (
          await f.pool.query('SELECT secret FROM "twoFactor" WHERE "userId" = $1', [member.id])
        ).rows[0].secret,
      });
      const verified = await f.request(
        '/api/auth/two-factor/verify-totp',
        { code: await createOTP(secret).totp() },
        member.cookie,
      );
      expect(verified.status).toBe(200);
      member = { ...member, cookie: cookies(verified) };
      const challenge = await f.request('/api/auth/sign-in/email', {
        email: member.email,
        password: member.password,
      });
      const other = await f.request(
        '/api/auth/two-factor/verify-totp',
        { code: await createOTP(secret).totp() },
        cookies(challenge),
      );
      expect(other.status).toBe(200);
      await f.pool.query(
        'UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1',
        [member.id],
      );
      const before = (
        await f.pool.query('SELECT * FROM rezics_account_recovery_policy WHERE id = $1', [
          member.id,
        ])
      ).rows;
      const invitations = (
        await f.pool.query(
          'SELECT * FROM rezics_account_recovery_guardian_invitation WHERE owner_user_id = $1',
          [member.id],
        )
      ).rows;
      const enrollment = { guardianEmail: guardian.email, recoveryCode: code() };
      const enroll = (cookie = member.cookie, extra = {}) =>
        f.request('/api/account/recovery-policy', { ...enrollment, ...extra }, cookie);
      // A legacy caller's correct password cannot turn enrollment into reauthentication.
      const denied = await enroll(member.cookie, { currentPassword: member.password });
      expect(denied.status).toBe(400);
      expect(await denied.json()).toEqual({ error: 'invalid_request' });
      const unstepped = await enroll();
      expect(unstepped.status).toBe(403);
      expect(await unstepped.json()).toEqual({ error: 'step_up_required' });
      const missingFactor = await f.request(
        '/api/account/reauthenticate',
        { password: member.password },
        member.cookie,
      );
      expect(missingFactor.status).toBe(403);
      expect((await enroll()).status).toBe(403);
      expect(
        (
          await f.pool.query(
            'SELECT 1 FROM rezics_account_step_up p JOIN "session" s ON s.id = p.session_id WHERE s."userId" = $1',
            [member.id],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await f.pool.query('SELECT * FROM rezics_account_recovery_policy WHERE id = $1', [
            member.id,
          ])
        ).rows,
      ).toEqual(before);
      expect(
        (
          await f.pool.query(
            'SELECT * FROM rezics_account_recovery_guardian_invitation WHERE owner_user_id = $1',
            [member.id],
          )
        ).rows,
      ).toEqual(invitations);
      expect(
        (
          await f.request(
            '/api/account/reauthenticate',
            { password: member.password, totpCode: await createOTP(secret).totp() },
            member.cookie,
          )
        ).status,
      ).toBe(200);
      expect((await enroll(cookies(other))).status).toBe(403);
      expect((await enroll()).status).toBe(200);
      expect(await (await enroll()).json()).toMatchObject({ replayed: true });
      const rotated = { recoveryCode: code() };
      expect((await enroll(member.cookie, rotated)).status).toBe(409);
      expect(
        (await enroll(member.cookie, { ...rotated, previousRecoveryCode: enrollment.recoveryCode }))
          .status,
      ).toBe(200);
      await f.pool.query(
        `UPDATE rezics_account_step_up SET verified_at = now() - interval '10 minutes'
        WHERE session_id IN (SELECT id FROM "session" WHERE "userId" = $1)`,
        [member.id],
      );
      expect((await enroll(member.cookie, rotated)).status).toBe(403);
    } finally {
      await f.close();
    }
  }, 60_000);
}

test('recovery enrollment uses the existing bounded reauthentication attempts', async () => {
  const f = await accountFixture();
  try {
    const member = await f.signup('bounded-owner@example.test');
    await f.pool.query(
      'UPDATE "session" SET "createdAt" = now() - interval \'10 minutes\' WHERE "userId" = $1',
      [member.id],
    );
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        (
          await f.request(
            '/api/account/reauthenticate',
            { password: 'wrong owner password' },
            member.cookie,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie))
        .status,
    ).toBe(429);
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          {
            guardianEmail: 'guardian@example.test',
            recoveryCode: code(),
            currentPassword: member.password,
          },
          member.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          '/api/account/recovery-policy',
          { guardianEmail: 'guardian@example.test', recoveryCode: code() },
          member.cookie,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.pool.query('SELECT 1 FROM rezics_account_recovery_policy WHERE id = $1', [
          member.id,
        ])
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
}, 60_000);

test('recovery enrollment rechecks a stepped-up session after waiting for its transaction lock', async () => {
  const f = await accountFixture();
  let blocker: PoolClient | undefined;
  try {
    const member = await f.signup('waiting-enrollment@example.test');
    expect(
      (await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie))
        .status,
    ).toBe(200);
    blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM "user" WHERE id = $1 FOR UPDATE', [member.id]);
    const pending = f.request(
      '/api/account/recovery-policy',
      { guardianEmail: 'guardian@example.test', recoveryCode: code() },
      member.cookie,
    );
    let waiting = 0;
    const until = Date.now() + 1500;
    do {
      waiting = (
        await f.pool.query(`SELECT count(*)::integer AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT email, locale FROM public.%'`)
      ).rows[0].n;
      if (!waiting) await Bun.sleep(10);
    } while (!waiting && Date.now() < until);
    await blocker.query('DELETE FROM "session" WHERE "userId" = $1', [member.id]);
    await blocker.query('COMMIT');
    expect(waiting).toBe(1);
    expect((await pending).status).toBe(403);
    expect(
      (
        await f.pool.query('SELECT 1 FROM rezics_account_recovery_policy WHERE id = $1', [
          member.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          'SELECT 1 FROM rezics_account_recovery_guardian_invitation WHERE owner_user_id = $1',
          [member.id],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    if (blocker) {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await f.close();
  }
}, 60_000);
