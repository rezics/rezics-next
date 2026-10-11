import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateAccount } from '../../../scripts/ops/migrate.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import {
  ACCOUNT_RECOVERY_USAGE_EXCLUSIONS,
  accountRecoveryCoverage,
  assertAccountRecoveryCoverage,
} from '../src/recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');

test('Account recovery usage exclusions require an explicit profile review', () => {
  expect(ACCOUNT_RECOVERY_USAGE_EXCLUSIONS).toEqual({
    version: 1,
    columns: { rezics_account_grant: ['last_used_at'] },
    tables: [],
  });
});

test('Account recovery ignores grant usage while retaining every authority change', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection });
  const url = new URL(`postgresql://127.0.0.1:${cluster.port}/postgres`);
  url.username = cluster.user;
  try {
    await migrateAccount({
      ACCOUNT_DATABASE_URL: url.href,
      ACCOUNT_BASE_URL: 'http://127.0.0.1:3002',
      ACCOUNT_SECRET: 'account-coverage-test-secret-32-characters',
      ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.test',
    }, root);
    await pool.query(`INSERT INTO public."user"
      (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('coverage-member', 'Recovery coverage', 'coverage@example.test', true, now(), now())`);
    await pool.query(`INSERT INTO public."oauthClient"
      (id, "clientId", "redirectUris", scopes, "createdAt", "updatedAt")
      VALUES ('coverage-client-row', 'coverage-client', '["https://app.example.test/callback"]',
        '["work:read"]', now(), now())`);
    await pool.query(`INSERT INTO public.rezics_account_grant (user_id, client_id, scopes)
      VALUES ('coverage-member', 'coverage-client', '["work:read"]')`);
    await pool.query(`INSERT INTO public."session"
      (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      VALUES ('coverage-session', 'coverage-member', 'coverage-session-token',
        now(), now(), now() + interval '1 day')`);
    await pool.query(`INSERT INTO public.passkey
      (id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp", "createdAt")
      VALUES ('coverage-passkey', 'Recovery key', 'retained-key', 'coverage-member',
        'coverage-credential', 0, 'singleDevice', false, now())`);
    await pool.query(`INSERT INTO public.rezics_policy_acceptance (user_id, policy_id, version_digest)
      VALUES ('coverage-member', 'terms', $1)`, ['a'.repeat(64)]);
    await pool.query(`INSERT INTO public.rezics_account_rate_limit (key)
      VALUES ('coverage-rate-limit')`);

    const retained = await accountRecoveryCoverage(pool);
    for (const timestamp of ['2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', null]) {
      const updated = await pool.query(`UPDATE public.rezics_account_grant SET last_used_at = $1
        WHERE user_id = 'coverage-member' AND client_id = 'coverage-client'`, [timestamp]);
      expect(updated.rowCount).toBe(1);
      expect(await accountRecoveryCoverage(pool)).toEqual(retained);
      await assertAccountRecoveryCoverage(pool, retained);
    }

    // Each committed mutation starts from its own retained snapshot, so an earlier
    // refusal cannot conceal a later omitted authority field. These edits keep the
    // row count constant and use the real migrated scanner and PostgreSQL JSONB.
    for (const sql of [
      `UPDATE public.rezics_account_grant SET revoked_at = now()
        WHERE user_id = 'coverage-member' AND client_id = 'coverage-client'`,
      `UPDATE public.rezics_account_grant SET generation = generation + 1
        WHERE user_id = 'coverage-member' AND client_id = 'coverage-client'`,
      `UPDATE public.rezics_account_grant SET scopes = '["work:write"]'
        WHERE user_id = 'coverage-member' AND client_id = 'coverage-client'`,
      `UPDATE public."session" SET "expiresAt" = "expiresAt" - interval '1 hour'
        WHERE id = 'coverage-session'`,
      `UPDATE public."session" SET token = 'changed-session-token' WHERE id = 'coverage-session'`,
      `UPDATE public.passkey SET "publicKey" = 'changed-key' WHERE id = 'coverage-passkey'`,
      `UPDATE public.passkey SET counter = counter + 1 WHERE id = 'coverage-passkey'`,
      `UPDATE public.rezics_policy_acceptance SET accepted_at = accepted_at + interval '1 second'
        WHERE user_id = 'coverage-member' AND policy_id = 'terms'`,
      `UPDATE public.rezics_policy_acceptance SET version_digest = repeat('b', 64)
        WHERE user_id = 'coverage-member' AND policy_id = 'terms'`,
      `UPDATE public.rezics_account_security SET suspended_at = now()
        WHERE user_id = 'coverage-member'`,
      // Rate limits remain covered until measured evidence and review establish
      // an exclusion. Their counters enforce an active admission policy today.
      `UPDATE public.rezics_account_rate_limit SET count = count + 1 WHERE key = 'coverage-rate-limit'`,
      `UPDATE public.rezics_account_rate_limit SET started_at = started_at + interval '1 second'
        WHERE key = 'coverage-rate-limit'`,
    ]) {
      const before = await accountRecoveryCoverage(pool);
      expect((await pool.query(sql)).rowCount).toBe(1);
      const after = await accountRecoveryCoverage(pool);
      expect(after.rowCount).toBe(before.rowCount);
      expect(after.rowDigest).not.toBe(before.rowDigest);
      await expect(assertAccountRecoveryCoverage(pool, before))
        .rejects.toThrow('Account rows differ from retained recovery coverage');
    }

    const beforeNewRow = await accountRecoveryCoverage(pool);
    await pool.query(`INSERT INTO public."user"
      (id, name, email, "emailVerified", "createdAt", "updatedAt")
      VALUES ('coverage-new-member', 'New member', 'new-coverage@example.test', true, now(), now())`);
    const afterNewRow = await accountRecoveryCoverage(pool);
    expect(BigInt(afterNewRow.rowCount)).toBeGreaterThan(BigInt(beforeNewRow.rowCount));
    expect(afterNewRow.rowDigest).not.toBe(beforeNewRow.rowDigest);
    await expect(assertAccountRecoveryCoverage(pool, beforeNewRow))
      .rejects.toThrow('Account rows differ from retained recovery coverage');
  } finally {
    try { await pool.end(); }
    finally { cluster.remove(); }
  }
}, 30_000);
