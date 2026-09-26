import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

function migrations(): Array<{ version: number; sql: string }> {
  const directory = join(import.meta.dir, '../migrations');
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  if (!files.length) throw new Error('Content migrations are missing');
  // Versions strictly increase; gaps are allowed because parallel owner work reserves number ranges.
  let previous = 0;
  return files.map(name => {
    if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) {
      throw new Error(`Content migration filename is invalid: ${name}`);
    }
    const version = Number(name.slice(0, 3));
    if (version <= previous) throw new Error(`Content migration sequence repeats a version at ${name}`);
    previous = version;
    return { version, sql: readFileSync(join(directory, name), 'utf8') };
  });
}

/** Apply Content and private source-staging schemas in Main's PostgreSQL database. */
export async function migrateContent(pool: Pool): Promise<void> {
  const pending = migrations();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-content-schema', 0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS content');
    await client.query(`CREATE TABLE IF NOT EXISTS content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query<{ version: number }>(
      'SELECT version FROM content.schema_migration ORDER BY version');
    const versions = applied.rows.map(row => row.version);
    if (versions.some((version, index) => version !== pending[index]?.version)) {
      throw new Error('Content schema history differs from local migrations');
    }
    for (const migration of pending.slice(versions.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO content.schema_migration (version) VALUES ($1)',
        [migration.version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
