import { expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { nativeFixture, password, scopes } from './support/erasure-native.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';

async function eventually(probe: () => Promise<boolean>, timeout = 30_000) {
  const until = Date.now() + timeout;
  while (!(await probe())) {
    if (Date.now() > until) throw new Error('Native erasure did not progress');
    await Bun.sleep(100);
  }
}

test('existing deletion caller drains real Auth stores before user deletion; default host resumes native progress and preserves the original consent cutoff without custody or ACK fabrication', async () => {
  const f = await nativeFixture();
  try {
    const victim = await f.person('erased');
    const survivor = await f.person('survivor');
    const owner = victim.accountId;
    // More than one client and one raw-key page, with surviving subjects on the
    // erased owner's clients. These are native fixture writes, never erasure writes.
    for (let i = 0; i < 3; i++) {
      const client = `owned-${i}`;
      await f.host.service.internal.registerClient({ clientId: client, firstParty: true, scopes });
      await f.pool.query('UPDATE auth_client SET "userId"=$2,"clientSecret"=$3 WHERE client_id=$1', [
        client,
        owner,
        `secret-${i}`,
      ]);
      await f.pool.query(
        `INSERT INTO "oauthAccessToken" (id,token,"clientId","userId","expiresAt","createdAt",scopes)
        SELECT $1||i,$1||i,$2,$3,now()+interval '300 seconds',now(),'[]'::jsonb FROM generate_series(1,105) i`,
        [`owned-token-${i}-`, client, survivor.accountId],
      );
    }
    const actingSession = (
      await f.pool.query<{ id: string }>('SELECT id FROM session WHERE "userId"=$1', [survivor.accountId])
    ).rows[0]!.id;
    await f.pool.query(
      `INSERT INTO auth_session_opening (session_id,subject_account_id,acting_human_id,operator_account_id,receipt_id)
      VALUES ($1,$2,$3,$3,'operating-human')`,
      [actingSession, survivor.accountId, owner],
    );
    const staged = await f.host.service.internal.stageCredentialEffect({
      key: 'stalled-password',
      subjectAccountId: owner,
      headers: new Headers({ cookie: victim.cookie }),
      credential: { kind: 'password', password: 'replacement secret password' },
    });
    expect(staged.effectRef).toBeString();
    const recovery = await f.call('/recovery/start', { email: victim.email });
    expect(recovery.status).toBe(200);
    const options = await f.call('/passkeys/register/options', {}, victim.cookie);
    expect(options.status).toBe(200);
    expect(
      (await f.pool.query('SELECT id FROM verification WHERE erasure_account_id=$1', [owner])).rowCount,
    ).toBeGreaterThan(0);
    const survivorPassword = (
      await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [survivor.accountId])
    ).rows[0]!.password;
    // The native zero-child guard is a real database check, including legacy
    // recovered callers. No FK cascade can substitute for these child pages.
    await expect(f.pool.query('DELETE FROM "user" WHERE id=$1', [owner])).rejects.toThrow(
      'Auth native user children remain',
    );
    const result = await f.delete(victim);
    expect({ status: result.status, body: await result.json() }).toEqual({ status: 200, body: { accountId: owner } });
    const obligation = (await f.pool.query('SELECT * FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]!;
    expect(obligation.applicable).toBe(true);
    expect(obligation.user_deleted_at).toBeInstanceOf(Date);
    expect(obligation.consent_due_at.getTime() - obligation.user_deleted_at.getTime()).toBeGreaterThanOrEqual(309_900);
    expect((await f.pool.query('SELECT id FROM "user" WHERE id=$1', [owner])).rowCount).toBe(0);
    for (const [table, column] of [
      ['account', 'userId'],
      ['session', 'userId'],
      ['passkey', 'userId'],
      ['verification', 'erasure_account_id'],
      ['auth_effect_receipt', 'account_id'],
      ['auth_registration_stage', 'account_id'],
      ['auth_provisioning_receipt', 'account_id'],
      ['auth_recovery', 'account_id'],
      ['auth_client', 'userId'],
    ] as const) {
      expect((await f.pool.query(`SELECT 1 FROM "${table}" WHERE "${column}"=$1 LIMIT 1`, [owner])).rowCount).toBe(0);
    }
    expect(
      (await f.pool.query('SELECT id FROM "oauthAccessToken" WHERE "clientId" LIKE $1 LIMIT 1', ['owned-%'])).rowCount,
    ).toBe(0);
    expect(
      (
        await f.pool.query(
          'SELECT session_id FROM auth_session_opening WHERE acting_human_id=$1 OR operator_account_id=$1',
          [owner],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await f.pool.query('SELECT password FROM account WHERE "userId"=$1', [survivor.accountId])).rows[0]!.password,
    ).toBe(survivorPassword);
    const signed = await f.call('/signin', {
      email: survivor.email,
      password,
      client_id: 'erasure-web',
      scope: scopes,
    });
    expect(signed.status).toBe(200);
    const access = (
      await f.kernel.query('SELECT state,authn_epoch FROM access.account WHERE route=$1 AND account_id=$2', [
        f.routeOf(owner),
        owner,
      ])
    ).rows[0]!;
    expect(access.state).toBe('deleted');
    expect(Number(access.authn_epoch)).toBe(obligation.barrier);
    const due = obligation.consent_due_at;
    // Stale native issuance/recovery/reduction cannot recreate any of these rows.
    await expect(
      f.pool.query('INSERT INTO auth_recovery (proof_hash,account_id,authn_epoch,expires_at) VALUES ($1,$2,1,now())', [
        'stale',
        owner,
      ]),
    ).rejects.toThrow('Auth erasure fence');
    await expect(
      f.host.service.internal.registerClient({ clientId: 'owned-0', firstParty: true, scopes }),
    ).rejects.toThrow('Auth erased client fence');
    await f.host.service.internal.eraseAccount(owner);
    expect(
      (await f.pool.query('SELECT consent_due_at,applicable FROM auth_erasure WHERE account_id=$1', [owner])).rows[0],
    ).toEqual({ consent_due_at: due, applicable: true });
    expect(await f.host.service.internal.eraseDueConsents()).toBe(0);
    // Remove the original job through the SDK, then restart the actual executor.
    // Only native obligations/markers survive; no replacement scheduler is installed.
    const jobs = (
      await f.pool.query(
        `SELECT workflow_uuid FROM ${AUTH_SYSTEM_SCHEMA}.workflow_status WHERE name='auth.accounts.operation'`,
      )
    ).rows;
    await DBOS.deleteWorkflows(jobs.map((row) => row.workflow_uuid));
    await f.host.workflows.close();
    await f.host.workflows.start();
    await eventually(
      async () =>
        !!(await f.pool.query('SELECT native_completed_at FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]
          ?.native_completed_at,
      90_000,
    );
    expect(
      (await f.pool.query('SELECT pending_code FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]!.pending_code,
    ).toBe('consent');
    // Real elapsed cutoff and the registered native due scheduler, not a fixture
    // UPDATE of due_at or an elapsed-lifetime shortcut.
    await Bun.sleep(Math.max(0, due.getTime() - Date.now() + 20));
    await eventually(
      async () =>
        !!(await f.pool.query('SELECT consent_completed_at FROM auth_erasure WHERE account_id=$1', [owner])).rows[0]
          ?.consent_completed_at,
      90_000,
    );
    expect((await f.pool.query('SELECT 1 FROM auth_consent WHERE account_id=$1', [owner])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM auth_consent_erasure WHERE account_id=$1', [owner])).rowCount).toBe(0);
    expect(
      (
        await f.pool.query('SELECT applicable,pending_code,consent_due_at FROM auth_erasure WHERE account_id=$1', [
          owner,
        ])
      ).rows[0],
    ).toEqual({ applicable: true, pending_code: 'shared-copy-custody', consent_due_at: due });
    // No trusted acknowledgement port or supported copy recorder exists in the
    // composition. A native completion marker must never pretend otherwise.
    expect(
      (
        await f.pool.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='auth_erasure' AND column_name IN ('acknowledged_at','erased_at','none_at')",
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
}, 540_000);
