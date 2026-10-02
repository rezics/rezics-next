import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compareMigrationPaths, migrationVersion } from '../lib/migration-order.ts';
import { Pool, type PoolClient } from 'pg';

export const migrationDirectories = {
  access: 'services/main/migrations/access',
  relay: 'services/main/migrations/relay',
  content: 'services/content/migrations',
  account: 'services/account/migrations',
} as const;
export type SchemaOwner = keyof typeof migrationDirectories;
export const repositoryRoot = resolve(import.meta.dir, '../..');

export function migrationRecords(root: string, owner: SchemaOwner) {
  const directory = migrationDirectories[owner];
  const files = readdirSync(join(root, directory))
    .filter((name) => name.endsWith('.sql'))
    .sort(compareMigrationPaths);
  const versions = new Set<number>();
  return files.map((name) => {
    const version = migrationVersion(name);
    if (versions.has(version)) {
      throw new Error(`Invalid ${owner} migration: ${name}`);
    }
    versions.add(version);
    return { name: `${directory}/${name}`, version };
  });
}

function migrationFiles(root: string, owner: SchemaOwner) {
  return migrationRecords(root, owner).map((file) => ({
    ...file,
    sql: readFileSync(join(root, file.name), 'utf8'),
  }));
}

async function withDatabaseLock<T>(
  url: string,
  action: (pool: Pool, lock: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5_000 });
  let lock: PoolClient | undefined;
  try {
    lock = await pool.connect();
    // Session lock spans provider DDL and all per-file transactions. Every owner
    // in one database shares the same key, including concurrent release jobs.
    await lock.query("SELECT pg_advisory_lock(hashtextextended('rezics-release-migrations', 0))");
    return await action(pool, lock);
  } finally {
    try {
      if (lock) {
        try {
          await lock.query(
            "SELECT pg_advisory_unlock(hashtextextended('rezics-release-migrations', 0))",
          );
        } finally {
          lock.release();
        }
      }
    } finally {
      await pool.end();
    }
  }
}

async function trackedIn(
  client: PoolClient,
  root: string,
  owner: Exclude<SchemaOwner, 'content'>,
): Promise<string[]> {
  const files = migrationFiles(root, owner);
  await client.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const history = (
    await client.query<{ name: string }>('SELECT name FROM public.rezics_local_migration')
  ).rows;
  const applied: string[] = [];
  for (const file of files) {
    await client.query('BEGIN');
    try {
      if (!history.some((row) => row.name === file.name)) {
        await client.query(file.sql);
        await client.query('INSERT INTO public.rezics_local_migration(name) VALUES ($1)', [
          file.name,
        ]);
        applied.push(file.name);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  return applied;
}

export async function migrateTracked(
  url: string,
  root: string,
  directory: string,
): Promise<string[]> {
  const owner = (Object.keys(migrationDirectories) as SchemaOwner[]).find(
    (owner) => migrationDirectories[owner] === directory,
  );
  if (!owner || owner === 'content' || owner === 'account')
    throw new Error('Use the owner migration runner');
  return withDatabaseLock(url, (_pool, client) => trackedIn(client, root, owner));
}

export async function migrateContentFromArtifact(url: string, root: string): Promise<string[]> {
  return withDatabaseLock(url, async (_pool, client) => {
    const files = migrationFiles(root, 'content');
    const applied: string[] = [];
    await client.query('BEGIN');
    try {
      // Also serialize with Main's existing Content migration runner.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('rezics-content-schema', 0))",
      );
      await client.query('CREATE SCHEMA IF NOT EXISTS content');
      await client.query(`CREATE TABLE IF NOT EXISTS content.schema_migration (
        version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const history = (
        await client.query<{ version: number }>('SELECT version FROM content.schema_migration')
      ).rows;
      for (const file of files) {
        if (!history.some((row) => row.version === file.version)) {
          await client.query(file.sql);
          await client.query('INSERT INTO content.schema_migration(version) VALUES ($1)', [
            file.version,
          ]);
          applied.push(file.name);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return applied;
  });
}

export async function migrateAccount(
  env: Record<string, string | undefined>,
  root = repositoryRoot,
): Promise<string[]> {
  const url = env.ACCOUNT_DATABASE_URL;
  if (!url || !env.ACCOUNT_BASE_URL || !env.ACCOUNT_SECRET || !env.ACCOUNT_MAIN_RESOURCE)
    throw new Error('Account migration configuration is incomplete');
  return withDatabaseLock(url, async (pool, client) => {
    // A verified local artifact must inspect its own provider schema and pinned
    // package, even when the invoking checkout has since changed.
    const { getMigrations } = (await import(
      Bun.resolveSync('better-auth/db/migration', join(root, 'services/account/src'))
    )) as typeof import('better-auth/db/migration');
    const { accountAuthOptions } = (await import(
      join(root, 'services/account/src/auth.ts')
    )) as typeof import('../../services/account/src/auth.ts');
    const plan = await getMigrations(
      accountAuthOptions({
        baseURL: env.ACCOUNT_BASE_URL!,
        secret: env.ACCOUNT_SECRET!,
        resource: env.ACCOUNT_MAIN_RESOURCE!,
        pool,
        operatorUserIds: new Set(),
      }),
    );
    if (plan.unsafeChanges.length || plan.schemaProblems.length)
      throw new Error('Unsafe Account migration');
    await plan.runMigrations();
    const { installConsentRefreshFence } = (await import(
      join(root, 'services/account/src/consent-fence.ts')
    )) as typeof import('../../services/account/src/consent-fence.ts');
    // Account SQL is deliberately idempotent and reapplied, including in-place
    // edits. Record completion in the existing tracker without skipping it.
    await installConsentRefreshFence(pool);
    await client.query(`CREATE TABLE IF NOT EXISTS public.rezics_local_migration (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied: string[] = [];
    await client.query('BEGIN');
    try {
      for (const file of migrationRecords(root, 'account')) {
        const result = await client.query(
          'INSERT INTO public.rezics_local_migration(name) VALUES ($1) ON CONFLICT DO NOTHING',
          [file.name],
        );
        if (result.rowCount) applied.push(file.name);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return applied;
  });
}

export async function migrateOwners(
  env: Record<string, string | undefined>,
  root = repositoryRoot,
): Promise<string[]> {
  for (const name of [
    'ACCESS_DATABASE_URL',
    'CONTENT_DATABASE_URL',
    'MAIN_RELAY_DATABASE_URL',
    'ACCOUNT_DATABASE_URL',
  ]) {
    if (!env[name]) throw new Error(`Migration job requires ${name}`);
  }
  return [
    ...(await migrateTracked(env.ACCESS_DATABASE_URL!, root, migrationDirectories.access)),
    ...(await migrateTracked(env.MAIN_RELAY_DATABASE_URL!, root, migrationDirectories.relay)),
    ...(await migrateContentFromArtifact(env.CONTENT_DATABASE_URL!, root)),
    ...(await migrateAccount(env, root)),
  ];
}

if (import.meta.main) {
  const { checkProductionEnv, readProductionEnv, assertNoPaymentProvider } =
    await import('./production-env.ts');
  const env = process.argv[2] ? readProductionEnv(process.argv[2]) : process.env;
  if (process.argv[2] || env.NODE_ENV === 'production') {
    checkProductionEnv(env, ['migrate']);
    await assertNoPaymentProvider(env.ACCESS_DATABASE_URL!, true);
  }
  const applied = await migrateOwners(env);
  if (process.argv[2] || env.NODE_ENV === 'production')
    await assertNoPaymentProvider(env.ACCESS_DATABASE_URL!);
  console.log(JSON.stringify({ applied }));
}
