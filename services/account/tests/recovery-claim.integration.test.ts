import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions } from '../src/auth.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { accountRecoveryCoverage } from '../src/recovery-coverage.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM08: Account recovery migration installs fresh and upgrades the prior owner head', async () => {
  const state = join(root, '.temp', `account-recovery-migration-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pgdata');
  const sockets = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const port = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${port} -k ${sockets}`, '-w', 'start'], { cwd: state });
  const database = (name: string) => new Pool({ host: '127.0.0.1', port,
    user: process.env.USER, database: name });
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
    expect((await fresh.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE 'rezics_account_recovery_%'`)).rows)
      .toHaveLength(4);
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
    expect((await upgrade.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'rezics_oauth_code_basis'
        AND column_name = 'recovery_generation'`)).rowCount).toBe(1);
    expect((await upgrade.query(`SELECT tgname FROM pg_trigger
      WHERE tgname IN ('rezics_recovery_code_basis', 'rezics_refresh_recovery_guard')`)).rowCount)
      .toBe(2);
    await expect(accountRecoveryCoverage(upgrade)).resolves.toMatchObject({ rowCount: '0' });
  } finally {
    await Promise.all([fresh.end(), upgrade.end(), admin.end()]);
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 30_000);
