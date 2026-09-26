import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { migrateContent } from '../../services/content/src/migrate.ts';
import { root, run } from './stack.ts';

const TRACKED = [['ACCESS_DATABASE_URL', 'services/main/migrations/access'],
  ['ACCOUNT_RELAY_DATABASE_URL', 'services/main/migrations/relay']] as const;

/** The `yarn dev` ledger, so a restored fixture and a dev stack agree on applied files. */
async function migrateTracked(url: string, directory: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of readdirSync(join(root, directory)).filter(name => name.endsWith('.sql')).sort()) {
      const key = `${directory}/${file}`;
      await client.query('BEGIN');
      try {
        const done = await client.query('SELECT 1 FROM public.rezics_local_migration WHERE name = $1', [key]);
        if (!done.rowCount) {
          await client.query(readFileSync(join(root, key), 'utf8'));
          await client.query('INSERT INTO public.rezics_local_migration (name) VALUES ($1)', [key]);
          applied.push(key);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally { await client.end(); }
  return applied;
}

/** Apply every owner's pending migrations; a fresh build applies all of them. */
export async function migrateFixtureOwners(apps: Record<string, string>): Promise<string[]> {
  const applied: string[] = [];
  for (const [key, directory] of TRACKED) applied.push(...await migrateTracked(apps[key]!, directory));
  const content = new Pool({ connectionString: apps.CONTENT_DATABASE_URL, max: 1 });
  try {
    const before = await content.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables
      WHERE table_schema = 'content' AND table_name = 'schema_migration'`);
    const versions = before.rows[0]?.n === '1'
      ? (await content.query<{ version: number }>('SELECT version FROM content.schema_migration')).rows.length : 0;
    await migrateContent(content);
    const after = (await content.query<{ version: number }>('SELECT version FROM content.schema_migration')).rows.length;
    for (let version = versions + 1; version <= after; version++) applied.push(`content:${version}`);
  } finally { await content.end(); }
  run('bun', ['services/account/src/migrate.ts'], { ...process.env, ...apps }, 120_000);
  return applied;
}
