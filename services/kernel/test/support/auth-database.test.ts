import { afterAll, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { authTemplateName, createAuthDatabase } from './auth-database.ts';

const base = process.env.DATABASE_URL;
if (!base) throw new Error('DATABASE_URL must name the migrated test database');
const ownerUrl = new URL(base);
ownerUrl.pathname = '/postgres';
const owner = new Pool({ connectionString: ownerUrl.toString(), max: 1 });
const created: string[] = [];
afterAll(async () => {
  for (const name of created) await owner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await owner.end();
});

const migrations = readdirSync(resolve(import.meta.dir, '../../../auth/db/migrations'))
  .filter((file) => file.endsWith('.sql'))
  .map((file) => file.slice(0, file.indexOf('_')))
  .sort();

function name(): string {
  const value = `auth_probe_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  created.push(value);
  return value;
}

async function withDatabase<T>(url: string, work: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

const versions = (url: string) =>
  withDatabase(url, async (pool) =>
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map(
      (row) => row.version,
    ),
  );

test('Auth databases are clones of one migrated template', async () => {
  const template = authTemplateName();
  expect(template).toMatch(/^auth_template_[0-9a-f]{16}$/);
  const first = await createAuthDatabase(base, name());
  const second = await createAuthDatabase(base, name());
  expect(new URL(first).pathname).toBe(`/${created.at(-2)}`);
  expect(new URL(second).pathname).toBe(`/${created.at(-1)}`);
  expect(await versions(first)).toEqual(migrations);
  expect(await versions(second)).toEqual(migrations);
  const templates = await owner.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE starts_with(datname, 'auth_template_') ORDER BY datname",
  );
  expect(templates.rows.map((row) => row.datname)).toEqual([template]);
});

test('concurrent first use yields migrated isolated clones', async () => {
  const urls = await Promise.all([name(), name(), name(), name()].map((value) => createAuthDatabase(base, value)));
  for (const url of urls) expect(await versions(url)).toEqual(migrations);
  await withDatabase(urls[0]!, (pool) => pool.query('CREATE TABLE auth_database_probe (value integer)'));
  for (const url of urls.slice(1)) {
    const found = await withDatabase(url, (pool) =>
      pool.query("SELECT to_regclass('public.auth_database_probe') AS relation"),
    );
    expect(found.rows[0].relation).toBeNull();
  }
});

test('outcome drivers clone the Auth template and bootstrap governance in process', async () => {
  for (const path of ['../commerce/support/outcome-driver.ts', '../library/support/outcome-driver.ts']) {
    const source = await Bun.file(resolve(import.meta.dir, path)).text();
    expect(source, path).toContain('createAuthDatabase(');
    expect(source, path).toContain('bootstrapGovernance(');
    expect(source, path).not.toContain('auth/scripts/database.ts');
    expect(source, path).not.toContain('scripts/bootstrap-governance.ts');
  }
});
