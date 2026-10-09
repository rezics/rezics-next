// sql-relations-allow: public.unrelated_recovery_state -- The test creates this stray table to prove coverage still rejects unknown Account tables.
import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { migrateAccount, migrationRecords } from '../../../scripts/ops/migrate.ts';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import {
  AccountRecoveryCoverageConflict,
  accountRecoveryCoverage,
  assertAccountRecoveryCoverage,
} from '../src/recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');

test('Account release migration ledger is covered without accepting unrelated tables', async () => {
  const cluster = await startPostgresCluster();
  const port = cluster.port;
  const url = new URL(`postgresql://127.0.0.1:${port}/postgres`);
  url.username = cluster.user;
  const pool = new Pool({ ...cluster.connection });
  try {
    const configuration = {
      ACCOUNT_DATABASE_URL: url.href,
      ACCOUNT_BASE_URL: 'http://127.0.0.1:3002',
      ACCOUNT_SECRET: 'account-coverage-test-secret-32-characters',
      ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.test',
    };
    const names = migrationRecords(root, 'account').map(file => file.name);
    expect(await migrateAccount(configuration, root)).toEqual(names);
    const retained = await accountRecoveryCoverage(pool);
    expect(retained.rowCount).toBe(String(names.length));
    await assertAccountRecoveryCoverage(pool, retained);
    expect(await migrateAccount(configuration, root)).toEqual([]);
    expect(await accountRecoveryCoverage(pool)).toEqual(retained);

    // Completion times matter even when the set of migration names is unchanged.
    await pool.query(`UPDATE public.rezics_local_migration
      SET applied_at = applied_at + interval '1 second' WHERE name = $1`, [names[0]]);
    try {
      await expect(assertAccountRecoveryCoverage(pool, retained))
        .rejects.toThrow('Account rows differ from retained recovery coverage');
    } finally {
      await pool.query(`UPDATE public.rezics_local_migration
        SET applied_at = applied_at - interval '1 second' WHERE name = $1`, [names[0]]);
    }
    expect(await accountRecoveryCoverage(pool)).toEqual(retained);

    // Exercise the ledger's text key beyond the scanner's first 1,000-row page.
    await pool.query(`INSERT INTO public.rezics_local_migration(name, applied_at)
      SELECT 'coverage/' || lpad(i::text, 4, '0'), '2026-01-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 1001) AS i`);
    const paged = await accountRecoveryCoverage(pool);
    expect(paged.rowCount).toBe(String(names.length + 1001));
    await pool.query("DELETE FROM public.rezics_local_migration WHERE name = 'coverage/1001'");
    await expect(assertAccountRecoveryCoverage(pool, paged))
      .rejects.toThrow('Account rows differ from retained recovery coverage');
    await pool.query("DELETE FROM public.rezics_local_migration WHERE name LIKE 'coverage/%'");
    expect(await accountRecoveryCoverage(pool)).toEqual(retained);

    await pool.query('CREATE TABLE public.unrelated_recovery_state (id text PRIMARY KEY)');
    await expect(accountRecoveryCoverage(pool)).rejects.toThrow(AccountRecoveryCoverageConflict);
    await expect(accountRecoveryCoverage(pool)).rejects.toThrow('unexpected ["unrelated_recovery_state"]');
    await pool.query('DROP TABLE public.unrelated_recovery_state');
    expect(await accountRecoveryCoverage(pool)).toEqual(retained);

    // Legacy direct bootstrap has no ledger, but cannot match a retained release cut.
    await pool.query('DROP TABLE public.rezics_local_migration');
    await expect(accountRecoveryCoverage(pool)).resolves.toMatchObject({ rowCount: '0' });
    await expect(assertAccountRecoveryCoverage(pool, retained))
      .rejects.toThrow('Account rows differ from retained recovery coverage');
    await pool.query('ALTER TABLE public.verification RENAME TO missing_verification');
    await expect(accountRecoveryCoverage(pool)).rejects.toThrow('missing ["verification"]');
  } finally {
    try { await pool.end(); }
    finally { cluster.remove(); }
  }
}, 30_000);
