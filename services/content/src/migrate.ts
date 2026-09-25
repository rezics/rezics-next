import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

/** Apply the Content owner schema to its own database before serving commands. */
export async function migrateContent(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('rezics-content-schema', 0))");
    await client.query('CREATE SCHEMA IF NOT EXISTS content');
    await client.query(`CREATE TABLE IF NOT EXISTS content.schema_migration (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = await client.query('SELECT 1 FROM content.schema_migration WHERE version = 1');
    if (!applied.rowCount) {
      await client.query(readFileSync(join(import.meta.dir, '../migrations/001_core.sql'), 'utf8'));
      await client.query('INSERT INTO content.schema_migration (version) VALUES (1)');
    }
    const projection = await client.query('SELECT 1 FROM content.schema_migration WHERE version = 2');
    if (!projection.rowCount) {
      await client.query(readFileSync(join(import.meta.dir, '../migrations/002_projection_checkpoint.sql'), 'utf8'));
      await client.query('INSERT INTO content.schema_migration (version) VALUES (2)');
    }
    const comments = await client.query('SELECT 1 FROM content.schema_migration WHERE version = 3');
    if (!comments.rowCount) {
      await client.query(readFileSync(join(import.meta.dir, '../migrations/003_comments.sql'), 'utf8'));
      await client.query('INSERT INTO content.schema_migration (version) VALUES (3)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
