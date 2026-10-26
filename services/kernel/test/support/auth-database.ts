import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type Pool } from 'pg';
import { migrate } from '../../../auth/scripts/database.ts';

const migrations = resolve(import.meta.dir, '../../../auth/db/migrations');

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** One name per Auth migration set: it changes exactly when a migration file is added, renamed or edited. */
export function authTemplateName(): string {
  const hash = createHash('sha256');
  for (const file of readdirSync(migrations)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(resolve(migrations, file)))
      .update('\0');
  }
  return `auth_template_${hash.digest('hex').slice(0, 16)}`;
}

/**
 * Clones a migrated Auth database named `name` from the template of this migration set and returns its URL. The
 * template is built once per cluster, under an advisory lock, and no connection ever opens it, so any number of
 * clones can proceed at once. The caller drops `name`; the template stays for the life of the cluster.
 */
export async function createAuthDatabase(baseUrl: string, name: string): Promise<string> {
  const template = authTemplateName();
  const building = `${template}_building`;
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  const owner = new Client({ connectionString: url.toString() });
  await owner.connect();
  try {
    await owner.query('SELECT pg_advisory_lock(hashtext($1))', [template]);
    try {
      const found = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [template]);
      if (found.rowCount === 0) {
        await owner.query(`DROP DATABASE IF EXISTS ${quote(building)} WITH (FORCE)`);
        await owner.query(`CREATE DATABASE ${quote(building)}`);
        url.pathname = `/${building}`;
        migrate(url.toString());
        await owner.query(`ALTER DATABASE ${quote(building)} RENAME TO ${quote(template)}`);
      }
    } finally {
      await owner.query('SELECT pg_advisory_unlock(hashtext($1))', [template]);
    }
    await owner.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template)}`);
  } finally {
    await owner.end();
  }
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Drops Auth database `name` once its owners have closed their pools. `pool.end()` resolves when the pool has handed
 * its clients to `client.end()`, not when the server has released their backends, so a `FORCE` drop issued right
 * after it can terminate a backend that is still closing; the pg client then raises an unhandled FATAL. This waits for
 * the backends to leave and keeps `FORCE` as the last step for any that never do.
 */
export async function dropAuthDatabase(admin: Pick<Pool, 'query'>, name: string, patienceMs = 5000): Promise<void> {
  const deadline = Date.now() + patienceMs;
  while (Date.now() < deadline) {
    const open = await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [
      name,
    ]);
    if (open.rowCount === 0) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
}
