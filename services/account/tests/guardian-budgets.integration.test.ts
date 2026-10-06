import { expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';

test('guardian invitations: recipient limits disclose no account existence and an exhausted request preserves the last code and delivery', async () => {
  const f = await accountFixture();
  try {
    const guardian = await f.signup('budget-guardian@example.test');
    const outcomes: unknown[] = [];
    for (const [label, email] of [
      ['known', guardian.email],
      ['absent', 'absent-budget@example.test'],
    ]) {
      const owner = await f.signup(`${label}-budget-owner@example.test`);
      expect(
        (
          await f.request(
            '/api/account/recovery-policy',
            {
              guardianEmail: email,
              recoveryCode: randomBytes(32).toString('base64url'),
              currentPassword: 'wrong owner password',
            },
            owner.cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.pool.query('SELECT id FROM rezics_account_recovery_policy WHERE id = $1', [
            owner.id,
          ])
        ).rowCount,
      ).toBe(0);
      let previous: string | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        const recoveryCode = randomBytes(32).toString('base64url');
        expect(
          (
            await f.request(
              '/api/account/recovery-policy',
              {
                guardianEmail: email,
                recoveryCode,
                previousRecoveryCode: previous,
                currentPassword: owner.password,
              },
              owner.cookie,
            )
          ).status,
        ).toBe(200);
        previous = recoveryCode;
      }
      const response = await f.request(
        '/api/account/recovery-policy',
        {
          guardianEmail: email,
          recoveryCode: randomBytes(32).toString('base64url'),
          previousRecoveryCode: previous,
          currentPassword: owner.password,
        },
        owner.cookie,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('300');
      outcomes.push(await response.json());
      expect(
        (
          await f.pool.query('SELECT code_hash FROM rezics_account_recovery_policy WHERE id = $1', [
            owner.id,
          ])
        ).rows[0],
      ).toEqual({ code_hash: createHash('sha256').update(previous!).digest('hex') });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    await f.email.drain();
    expect(
      f.messages.filter((mail) => mail.text.includes('/security/recovery?invitationId=')),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian invitations: the authenticated sender ceiling prevents flooding different mailboxes', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('sender-budget-owner@example.test');
    let previous: string | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const recoveryCode = randomBytes(32).toString('base64url');
      expect(
        (
          await f.request(
            '/api/account/recovery-policy',
            {
              guardianEmail: `recipient-${attempt}@example.test`,
              recoveryCode,
              previousRecoveryCode: previous,
              currentPassword: owner.password,
            },
            owner.cookie,
          )
        ).status,
      ).toBe(200);
      previous = recoveryCode;
    }
    const exhausted = await f.request(
      '/api/account/recovery-policy',
      {
        guardianEmail: 'another@example.test',
        recoveryCode: randomBytes(32).toString('base64url'),
        previousRecoveryCode: previous,
        currentPassword: owner.password,
      },
      owner.cookie,
    );
    expect(exhausted.status).toBe(429);
    expect(exhausted.headers.get('retry-after')).toBe('86400');
    expect(
      (await f.pool.query('SELECT id FROM rezics_account_recovery_guardian_invitation')).rowCount,
    ).toBe(8);
  } finally {
    await f.close();
  }
}, 120_000);
