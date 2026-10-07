import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Pool } from 'pg';
import { rehearseRefreshMigrations } from '../../../scripts/dev/refresh-stack.ts';
import { applySqlMigration, sqlMigration } from '../../../scripts/lib/concurrent-index.ts';
import { migrateContentFromArtifact, migrateTracked, migrationDirectories } from '../../../scripts/ops/migrate.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';

const root = resolve(import.meta.dir, '../../..');

for (const owner of ['access', 'relay', 'content', 'account', 'qa'] as const) {
  test(`${owner} rehearses and applies online indexes, preserves valid lost receipts and repairs a cancelled build`, async () => {
    if (!process.env.REZICS_QA_RUN_ID) throw new Error('Run through isolated integration QA');
    const env = { ...process.env, MAIN_RELAY_DATABASE_URL: process.env.ACCOUNT_RELAY_DATABASE_URL } as Record<string, string>;
    const database = owner === 'qa' ? 'access' : owner;
    const url = { access: env.ACCESS_DATABASE_URL, relay: env.MAIN_RELAY_DATABASE_URL,
      content: env.CONTENT_DATABASE_URL, account: env.ACCOUNT_DATABASE_URL }[database]!;
    mkdirSync(join(root, '.temp'), { recursive: true });
    const directory = mkdtempSync(join(root, '.temp/concurrent-index-'));
    for (const relative of Object.values(migrationDirectories)) mkdirSync(join(directory, relative), { recursive: true });
    // Content validates its complete version history; retain the installed
    // inventory and add only this disposable test's pending migration.
    if (owner === 'content') cpSync(join(root, migrationDirectories.content),
      join(directory, migrationDirectories.content), { recursive: true });
    const schema = `online_probe_${randomUUID().replaceAll('-', '')}`;
    const migrationName = `${migrationDirectories[database]}/999999_online_probe.sql`;
    const indexName = `${schema}.by_value`;
    const sql = `-- migrate: concurrent-index ${indexName}\nCREATE INDEX CONCURRENTLY by_value ON ${schema}.source (value) WHERE value > 0;`;
    writeFileSync(join(directory, migrationName), sql);
    const pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5_000 });
    const blocker = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    let connected = false;
    const index = async () => (await pool.query<{ oid: number; indisvalid: boolean }>(
      'SELECT indexrelid::oid AS oid, indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [indexName])).rows[0];
    const clearReceipt = async () => {
      if (owner === 'content') await pool.query('DELETE FROM content.schema_migration WHERE version = 999999');
      if (owner === 'access' || owner === 'relay') await pool.query(
        'DELETE FROM public.rezics_local_migration WHERE name = $1', [migrationName]);
    };
    const apply = async () => {
      if (owner === 'access' || owner === 'relay') return migrateTracked(url, directory, migrationDirectories[owner]);
      if (owner === 'content') return migrateContentFromArtifact(url, directory);
      if (owner === 'account') return installConsentRefreshFence(pool,
        pathToFileURL(join(directory, migrationDirectories.account) + '/'));
      const client = await pool.connect();
      try { await applySqlMigration(client, sqlMigration(sql, migrationName)); }
      finally { client.release(); }
    };
    const rehearse = () => rehearseRefreshMigrations(directory, env, [migrationName]);
    let build: Promise<{ error?: unknown }> | undefined;
    try {
      await pool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.source (id integer, value integer);
        INSERT INTO ${schema}.source SELECT id, id FROM generate_series(1, 2000) AS id`);
      await rehearse();
      expect(await index()).toBeUndefined();
      await apply();
      const valid = await index();
      expect(valid?.indisvalid).toBe(true);
      // Lost receipt: the valid build must be accepted without being rebuilt.
      await clearReceipt();
      await rehearse();
      expect(await index()).toEqual(valid);
      await apply();
      expect(await index()).toEqual(valid);

      // A wrong-column rehearsal still fails and leaves no index or row changes.
      await pool.query(`DROP INDEX ${indexName}`);
      await clearReceipt();
      writeFileSync(join(directory, migrationName), sql.replace('(value)', '(missing_column)'));
      await expect(rehearse()).rejects.toThrow('column "missing_column" does not exist');
      expect(await index()).toBeUndefined();
      writeFileSync(join(directory, migrationName), sql);

      // Hold an existing writer so CREATE INDEX CONCURRENTLY has committed its
      // catalog entry but cannot start scanning. Cancel that actual build.
      await blocker.connect();
      connected = true;
      await blocker.query('BEGIN');
      await blocker.query(`UPDATE ${schema}.source SET value = value WHERE id = 1`);
      build = apply().then(() => ({}), error => ({ error }));
      const deadline = Date.now() + 10_000;
      let pid: number | undefined;
      while (Date.now() < deadline) {
        const active = (await pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
            AND query = $1 AND state = 'active' AND wait_event_type = 'Lock'`, [sql])).rows[0];
        if (active && (await index())?.indisvalid === false) { pid = active.pid; break; }
        await Bun.sleep(20);
      }
      if (!pid) throw new Error('Online build did not reach its invalid-index writer wait');
      expect((await pool.query<{ cancelled: boolean }>(
        'SELECT pg_cancel_backend($1) AS cancelled', [pid])).rows[0]?.cancelled).toBe(true);
      const interrupted = await build;
      expect(String(interrupted.error)).toContain('canceling statement due to user request');
      const invalid = await index();
      expect(invalid?.indisvalid).toBe(false);
      await blocker.query('ROLLBACK');
      await rehearse();
      expect(await index()).toEqual(invalid);
      await apply();
      const repaired = await index();
      expect(repaired?.indisvalid).toBe(true);
      expect(repaired?.oid).not.toBe(invalid?.oid);
      expect((await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${schema}.source`)).rows[0]?.count)
        .toBe(2000);
      if (owner === 'access' || owner === 'relay' || owner === 'content') expect(await apply()).toEqual([]);
      else { await apply(); expect(await index()).toEqual(repaired); }
    } finally {
      if (connected) { await blocker.query('ROLLBACK'); await blocker.end(); }
      if (build) await build;
      try { await clearReceipt(); await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await pool.end(); rmSync(directory, { recursive: true, force: true }); }
    }
  }, 60_000);
}
