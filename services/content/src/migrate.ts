import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareMigrationPaths, migrationVersion } from '../../../scripts/lib/migration-order.ts';
import { applySqlMigration, sqlMigration, type SqlMigration } from '../../../scripts/lib/concurrent-index.ts';
import type { Pool } from 'pg';

function migrations(directory: string): Array<SqlMigration & { version: number }> {
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort(compareMigrationPaths);
  if (!files.length) throw new Error('Content migrations are missing');
  // Versions strictly increase; gaps are allowed because parallel owner work reserves number ranges.
  let previous = 0;
  return files.map(name => {
    const version = migrationVersion(name);
    if (version <= previous) throw new Error(`Content migration sequence repeats a version at ${name}`);
    previous = version;
    const sql = readFileSync(join(directory, name), 'utf8');
    return { version, ...sqlMigration(sql, name) };
  });
}

/** Apply Content and private source-staging schemas in Main's PostgreSQL database. */
export async function migrateContent(pool: Pool, directory = join(import.meta.dir, '../migrations')): Promise<number[]> {
  const pending = migrations(directory);
  const installed: number[] = [];
  const client = await pool.connect();
  let locked = false, inTransaction = false;
  try {
    // The same connection retains this lock across the online build's commits.
    await client.query("SELECT pg_advisory_lock(hashtextextended('rezics-content-schema', 0))");
    locked = true;
    await client.query('BEGIN');
    inTransaction = true;
    await client.query('CREATE SCHEMA IF NOT EXISTS content');
    await client.query(`CREATE TABLE IF NOT EXISTS content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM content.schema_migration ORDER BY version');
    // Parallel owner work merges reserved ranges in any order, so a lower version
    // can arrive after higher ones were applied (as Access and relay migrations,
    // tracked by name, already allow). Every applied version must still be known.
    const versions = new Set(applied.rows.map(row => row.version));
    const known = new Set(pending.map(migration => migration.version));
    if ([...versions].some(version => !known.has(version))) {
      throw new Error('Content schema history differs from local migrations');
    }
    for (const migration of pending.filter(migration => !versions.has(migration.version))) {
      if (migration.concurrentIndex) {
        // Release preceding DDL locks (including library revision triggers)
        // before waiting for any inventory-sized progress index build.
        await client.query('COMMIT');
        inTransaction = false;
        await applySqlMigration(client, migration);
        await client.query('BEGIN');
        inTransaction = true;
      } else await client.query(migration.sql);
      await client.query('INSERT INTO content.schema_migration (version) VALUES ($1)',
        [migration.version]);
      installed.push(migration.version);
    }
    await client.query('COMMIT');
    inTransaction = false;
    return installed;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended('rezics-content-schema', 0))");
    } finally { client.release(); }
  }
}
