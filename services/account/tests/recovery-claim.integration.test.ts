import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { accountAuthOptions } from '../src/auth.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { accountRecoveryCoverage } from '../src/recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');

test('IAM08: Account recovery migration installs fresh and upgrades the prior owner head', async () => {
  const cluster = await startPostgresCluster();
  const database = (name: string) => new Pool({ ...cluster.connection, database: name });
  const admin = database('postgres');
  const fresh = database('fresh');
  const upgrade = database('upgrade');
  const migrateAuth = async (pool: Pool) => {
    const plan = await getMigrations(accountAuthOptions({
      baseURL: 'http://127.0.0.1:3002', secret: 'account-recovery-test-secret-32-characters',
      resource: 'https://main.rezics.test', pool, operatorUserIds: new Set(),
    }));
    expect(plan.unsafeChanges).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
    await plan.runMigrations();
  };
  try {
    await admin.query('CREATE DATABASE fresh');
    await admin.query('CREATE DATABASE upgrade');
    await migrateAuth(fresh);
    await installConsentRefreshFence(fresh);
    await installConsentRefreshFence(fresh);
    const verificationIndex = `SELECT am.amname FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid JOIN pg_am am ON am.oid = idx.relam
      WHERE idx.relname = 'account_verification_value_lookup'`;
    expect((await fresh.query(verificationIndex)).rows).toEqual([{ amname: 'hash' }]);
    expect((await fresh.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'rezics_account_recovery_%'`)).rows)
      .toHaveLength(5);
    await expect(accountRecoveryCoverage(fresh)).resolves.toMatchObject({ rowCount: '0' });

    await migrateAuth(upgrade);
    for (const name of ['001_consent_refresh_fence.sql', '002_restored_code_basis.sql',
      '004_signing_key_generations.sql', '005_oauth_installations.sql']) {
      await upgrade.query(readFileSync(join(root, 'services/account/migrations', name), 'utf8'));
    }
    expect((await upgrade.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'rezics_account_recovery_%'`)).rowCount)
      .toBe(0);
    await upgrade.query(readFileSync(join(root,
      'services/account/migrations/020_independent_credential_recovery.sql'), 'utf8'));
    await installConsentRefreshFence(upgrade);
    expect((await upgrade.query(verificationIndex)).rows).toEqual([{ amname: 'hash' }]);
    expect((await upgrade.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rezics_oauth_code_basis'
        AND column_name = 'recovery_generation'`)).rowCount).toBe(1);
    expect((await upgrade.query(`SELECT tgname FROM pg_trigger
      WHERE tgname IN ('rezics_recovery_code_basis', 'rezics_refresh_recovery_guard')`)).rowCount)
      .toBe(2);
    await expect(accountRecoveryCoverage(upgrade)).resolves.toMatchObject({ rowCount: '0' });
  } finally {
    try { await Promise.all([fresh.end(), upgrade.end(), admin.end()]); }
    finally { cluster.remove(); }
  }
}, 30_000);
