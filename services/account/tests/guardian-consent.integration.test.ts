import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { accountFixture } from './account-fixture.ts';
import {
  acceptGuardian,
  recoveryProof,
  type RecoveryFixture,
  type RecoveryMember,
} from './recovery-fixture.ts';

const code = () => randomBytes(32).toString('base64url');
const enroll = (
  f: RecoveryFixture,
  owner: RecoveryMember,
  email: string,
  recoveryCode = code(),
  previousRecoveryCode?: string,
) =>
  f.request(
    '/api/account/recovery-policy',
    { guardianEmail: email, recoveryCode, previousRecoveryCode, currentPassword: owner.password },
    owner.cookie,
  );
const policy = async (f: RecoveryFixture, owner: RecoveryMember) =>
  (
    (await (await f.request('/api/account/recovery-policy/read', {}, owner.cookie)).json()) as {
      policy: { invitationId: string; state: string; hasCode: boolean };
    }
  ).policy;
const change = (f: RecoveryFixture, guardian: RecoveryMember, id: string, action: string) =>
  f.request(`/api/account/recovery-guardians/${id}`, { action }, guardian.cookie);
async function remove(f: RecoveryFixture, member: RecoveryMember) {
  expect(
    (await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie))
      .status,
  ).toBe(200);
  return f.request('/api/auth/delete-user', { password: member.password }, member.cookie);
}
async function deniedClaim(f: RecoveryFixture, owner: RecoveryMember) {
  const id = randomUUID();
  await f.pool.query(
    `INSERT INTO rezics_account_recovery_claim
    (id, target_user_id, policy_generation, code_hash, request_digest, not_before, expires_at)
    SELECT $1,id,generation,code_hash,repeat('a',64),now() - interval '1 second',now() + interval '7 days'
    FROM rezics_account_recovery_policy WHERE id = $2`,
    [id, owner.id],
  );
  return id;
}

test('guardian consent: enrollment has identical responses and delivery for existing and absent recipient accounts', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('owner@example.test');
    const other = await f.signup('other@example.test');
    const guardian = await f.signup('guardian@example.test');
    const known = await enroll(f, owner, guardian.email);
    const absent = await enroll(f, other, 'absent@example.test');
    expect(known.status).toBe(200);
    expect(absent.status).toBe(200);
    expect(await known.json()).toEqual(await absent.json());
    expect((await policy(f, owner)).state).toBe('pending');
    expect((await policy(f, other)).state).toBe('pending');
    expect(
      (await f.pool.query('SELECT guardian_user_id FROM rezics_account_recovery_policy')).rows,
    ).toEqual([{ guardian_user_id: null }, { guardian_user_id: null }]);
    await f.email.drain();
    for (const email of [guardian.email, 'absent@example.test']) {
      const invitation = f.messages.find(
        (mail) => mail.to === email && mail.text.includes('/security/recovery?invitationId='),
      );
      expect(invitation).toBeDefined();
      expect(invitation!.text).toContain('withdraw at any time');
    }
    const newcomer = await f.signup('absent@example.test');
    await acceptGuardian(f, other, newcomer);
    expect((await policy(f, other)).state).toBe('accepted');
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: never accepted, declined and expired invitations cannot approve, recover or block deletion', async () => {
  const f = await accountFixture({ accessDeletionFence: async () => {} });
  try {
    for (const state of ['pending', 'declined', 'expired']) {
      const owner = await f.signup(`${state}-owner@example.test`);
      const guardian = await f.signup(`${state}-guardian@example.test`);
      const recoveryCode = code();
      expect((await enroll(f, owner, guardian.email, recoveryCode)).status).toBe(200);
      const invitation = await policy(f, owner);
      const claimId = await deniedClaim(f, owner);
      if (state === 'declined')
        expect((await change(f, guardian, invitation.invitationId, 'decline')).status).toBe(200);
      if (state === 'expired') {
        await f.pool.query(
          "UPDATE rezics_account_recovery_guardian_invitation SET expires_at = now() - interval '1 second' WHERE id = $1",
          [invitation.invitationId],
        );
        expect((await change(f, guardian, invitation.invitationId, 'accept')).status).toBe(409);
      }
      expect((await policy(f, owner)).state).toBe(state);
      expect(
        (await f.request(`/api/account/recovery-claims/${claimId}/approval`, {}, guardian.cookie))
          .status,
      ).toBe(403);
      expect(
        (
          await f.request(`/api/account/recovery-claims/${claimId}/activation`, {
            recoveryCode,
            newPassword: 'a new secure recovery password',
          })
        ).ok,
      ).toBe(false);
      expect((await remove(f, guardian)).status).toBe(200);
    }
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: withdrawal invalidates an existing approval and permits deletion while retaining both participants as evidence', async () => {
  const fences: string[] = [];
  const f = await accountFixture({
    accessDeletionFence: async (id) => {
      fences.push(id);
    },
  });
  try {
    const owner = await f.signup('withdraw-owner@example.test');
    const guardian = await f.signup('withdraw-guardian@example.test');
    const proof = await recoveryProof(f, owner, guardian);
    const id = (await policy(f, owner)).invitationId;
    expect((await remove(f, guardian)).status).toBe(409);
    expect(fences).toEqual([]);
    expect((await change(f, owner, id, 'withdraw')).status).toBe(403);
    expect((await change(f, guardian, id, 'withdraw')).status).toBe(200);
    expect(await (await change(f, guardian, id, 'withdraw')).json()).toEqual({
      state: 'withdrawn',
      replayed: true,
    });
    expect((await proof.activate()).ok).toBe(false);
    expect((await f.request(`${proof.path}/approval`, {}, guardian.cookie)).status).toBe(403);
    expect(
      (await (await f.request(`${proof.path}/read`, { recoveryCode: proof.recoveryCode })).json())
        .approved,
    ).toBe(false);
    expect((await remove(f, guardian)).status).toBe(200);
    expect((await remove(f, owner)).status).toBe(200);
    expect(
      (
        await f.pool.query(
          'SELECT approver_user_id FROM rezics_account_recovery_approval WHERE id = $1',
          [proof.claimId],
        )
      ).rows,
    ).toEqual([{ approver_user_id: guardian.id }]);
    expect(
      (
        await f.pool.query(
          'SELECT target_user_id FROM rezics_account_recovery_claim WHERE id = $1',
          [proof.claimId],
        )
      ).rows,
    ).toEqual([{ target_user_id: owner.id }]);
    expect(
      (
        await f.pool.query(
          'SELECT guardian_user_id, state FROM rezics_account_recovery_guardian_invitation WHERE id = $1',
          [id],
        )
      ).rows,
    ).toEqual([{ guardian_user_id: guardian.id, state: 'withdrawn' }]);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: a spent guardian can delete their account without erasing approvals or activation receipts', async () => {
  const f = await accountFixture({ accessDeletionFence: async () => {} });
  try {
    const owner = await f.signup('spent-owner@example.test');
    const guardian = await f.signup('spent-guardian@example.test');
    const proof = await recoveryProof(f, owner, guardian);
    expect((await proof.activate()).status).toBe(200);
    expect((await remove(f, guardian)).status).toBe(200);
    expect(
      (
        await f.pool.query(
          'SELECT approver_user_id FROM rezics_account_recovery_approval WHERE id = $1',
          [proof.claimId],
        )
      ).rows[0],
    ).toEqual({ approver_user_id: guardian.id });
    expect(
      (
        await f.pool.query('SELECT id FROM rezics_account_recovery_activation WHERE id = $1', [
          proof.claimId,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await proof.activate()).status).toBe(200);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: re-enrolling the same code after withdrawal cannot revive an old approval', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('reused-owner@example.test');
    const guardian = await f.signup('reused-guardian@example.test');
    const proof = await recoveryProof(f, owner, guardian);
    const priorId = (await policy(f, owner)).invitationId;
    expect((await change(f, guardian, priorId, 'withdraw')).status).toBe(200);
    expect((await enroll(f, owner, guardian.email, proof.recoveryCode)).status).toBe(200);
    const nextId = await acceptGuardian(f, owner, guardian);
    expect(nextId).not.toBe(priorId);
    expect((await proof.activate()).status).toBe(409);
    expect((await f.request(`${proof.path}/approval`, {}, guardian.cookie)).status).toBe(409);
    expect(
      (
        await f.pool.query('SELECT id FROM rezics_account_recovery_approval WHERE id = $1', [
          proof.claimId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: renewal keeps accepted consent, invalidates the old code and rejects wrong or expired identities', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('renew-owner@example.test');
    const guardian = await f.signup('renew-guardian@example.test');
    const impostor = await f.signup('impostor@example.test');
    const old = code();
    expect((await enroll(f, owner, guardian.email, old)).status).toBe(200);
    const id = (await policy(f, owner)).invitationId;
    expect((await change(f, impostor, id, 'accept')).status).toBe(403);
    await f.pool.query('UPDATE "user" SET "emailVerified" = false WHERE id = $1', [guardian.id]);
    expect((await change(f, guardian, id, 'accept')).status).toBe(403);
    await f.pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [guardian.id]);
    await acceptGuardian(f, owner, guardian);
    // The deadline limits acceptance, not the lifetime of accepted consent.
    await f.pool.query(
      "UPDATE rezics_account_recovery_guardian_invitation SET expires_at = now() - interval '1 day' WHERE id = $1",
      [id],
    );
    const next = code();
    expect((await enroll(f, owner, guardian.email, next)).status).toBe(409);
    expect((await enroll(f, owner, guardian.email, next, old)).status).toBe(200);
    expect((await policy(f, owner)).invitationId).toBe(id);
    expect((await policy(f, owner)).state).toBe('accepted');
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId: randomUUID(),
          targetEmail: owner.email,
          recoveryCode: old,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request('/api/account/recovery-claims', {
          claimId: randomUUID(),
          targetEmail: owner.email,
          recoveryCode: next,
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.request('/api/account/recovery-policy/read', {}, 'invalid-session')).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: a failed mail intent rolls back enrollment and can be retried without losing the code or budgets', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('mail-rollback-owner@example.test');
    const recoveryCode = code();
    await f.pool
      .query(`CREATE FUNCTION reject_invitation_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'invitation queue probe'; END $$;
      CREATE TRIGGER reject_invitation_mail BEFORE INSERT ON rezics_account_email
      FOR EACH ROW EXECUTE FUNCTION reject_invitation_mail()`);
    expect((await enroll(f, owner, 'mailbox@example.test', recoveryCode)).status).toBe(503);
    expect(
      (await f.pool.query('SELECT id FROM rezics_account_recovery_guardian_invitation')).rowCount,
    ).toBe(0);
    expect((await f.pool.query('SELECT id FROM rezics_account_recovery_policy')).rowCount).toBe(0);
    await f.pool.query('DROP TRIGGER reject_invitation_mail ON rezics_account_email');
    expect((await enroll(f, owner, 'mailbox@example.test', recoveryCode)).status).toBe(200);
    expect(await (await enroll(f, owner, 'mailbox@example.test', recoveryCode)).json()).toEqual({
      generation: '0',
      replayed: true,
    });
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: concurrent withdrawal and activation share one policy fence and keep immutable approval history', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('withdraw-race-owner@example.test');
    const guardian = await f.signup('withdraw-race-guardian@example.test');
    const proof = await recoveryProof(f, owner, guardian);
    const id = (await policy(f, owner)).invitationId;
    const [withdrawn, activated] = await Promise.all([
      change(f, guardian, id, 'withdraw'),
      proof.activate(),
    ]);
    expect([
      [200, 409],
      [409, 200],
    ]).toContainEqual([withdrawn.status, activated.status]);
    expect(
      (
        await f.pool.query(
          'SELECT approver_user_id FROM rezics_account_recovery_approval WHERE id = $1',
          [proof.claimId],
        )
      ).rows,
    ).toEqual([{ approver_user_id: guardian.id }]);
    expect(
      (
        await f.pool.query('SELECT id FROM rezics_account_recovery_activation WHERE id = $1', [
          proof.claimId,
        ])
      ).rowCount,
    ).toBe(activated.ok ? 1 : 0);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: concurrent acceptance and deletion serialize without losing credentials behind an accepted duty', async () => {
  const f = await accountFixture({ accessDeletionFence: async () => {} });
  try {
    const owner = await f.signup('race-owner@example.test');
    const guardian = await f.signup('race-guardian@example.test');
    expect((await enroll(f, owner, guardian.email)).status).toBe(200);
    const id = (await policy(f, owner)).invitationId;
    expect(
      (
        await f.request(
          '/api/account/reauthenticate',
          { password: guardian.password },
          guardian.cookie,
        )
      ).status,
    ).toBe(200);
    const [accepted, deleted] = await Promise.all([
      change(f, guardian, id, 'accept'),
      f.request('/api/auth/delete-user', { password: guardian.password }, guardian.cookie),
    ]);
    expect([
      [200, 409],
      [403, 200],
    ]).toContainEqual([accepted.status, deleted.status]);
    expect(
      (await f.pool.query('SELECT id FROM account WHERE "userId" = $1', [guardian.id])).rowCount,
    ).toBe(accepted.ok ? 1 : 0);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: pagination traverses pending and accepted duties and cancelled mail is never sent', async () => {
  const f = await accountFixture();
  try {
    const guardian = await f.signup('pages-guardian@example.test');
    const owners: RecoveryMember[] = [];
    // Signup drains one shared mailbox queue; its verification helper must not
    // race another signup's drain for the same delivery worker.
    for (const name of ['one', 'two', 'three'])
      owners.push(await f.signup(`${name}-pages@example.test`));
    for (const owner of owners) expect((await enroll(f, owner, guardian.email)).status).toBe(200);
    await acceptGuardian(f, owners[1]!, guardian);
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await f.request(
        '/api/account/recovery-guardians/read',
        { limit: 1, ...(cursor ? { cursor } : {}) },
        guardian.cookie,
      );
      expect(response.status).toBe(200);
      const page = (await response.json()) as {
        items: { ownerEmail: string }[];
        nextCursor: string | null;
      };
      expect(page.items).toHaveLength(1);
      found.push(page.items[0]!.ownerEmail);
      cursor = page.nextCursor;
    } while (cursor);
    expect(found.sort()).toEqual(owners.map((owner) => owner.email).sort());
    for (const owner of owners) {
      const invitation = await policy(f, owner);
      expect(
        (
          await change(
            f,
            guardian,
            invitation.invitationId,
            invitation.state === 'accepted' ? 'withdraw' : 'decline',
          )
        ).status,
      ).toBe(200);
    }
    await f.email.drain();
    expect(
      f.messages.filter((mail) => mail.text.includes('/security/recovery?invitationId=')),
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 120_000);

test('guardian consent: migration removes unconfirmed legacy authority without erasing its original identity', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('legacy-owner@example.test');
    const guardian = await f.signup('legacy-guardian@example.test');
    await f.pool.query(
      `INSERT INTO rezics_account_recovery_policy (id,guardian_user_id,code_hash)
      VALUES ($1,$2,repeat('a',64))`,
      [owner.id, guardian.id],
    );
    await f.pool.query(
      readFileSync(new URL('../migrations/167_guardian_consent.sql', import.meta.url), 'utf8'),
    );
    const current = (
      await f.pool.query(
        'SELECT guardian_user_id,code_hash FROM rezics_account_recovery_policy WHERE id = $1',
        [owner.id],
      )
    ).rows[0];
    expect(current).toEqual({ guardian_user_id: null, code_hash: null });
    expect(
      (
        await f.pool.query(
          `SELECT legacy_guardian_user_id,state FROM rezics_account_recovery_guardian_invitation
      WHERE owner_user_id = $1`,
          [owner.id],
        )
      ).rows[0],
    ).toEqual({ legacy_guardian_user_id: guardian.id, state: 'unconfirmed' });
  } finally {
    await f.close();
  }
}, 120_000);
