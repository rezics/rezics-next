import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  migrateOwners,
  migrateTracked,
  migrateAccount,
  migrationDirectories,
  repositoryRoot,
} from '../migrate.ts';
import { assertNoPaymentProvider } from '../production-env.ts';
import { assertSchemaReady } from '../../../services/main/src/schema-ready.ts';

function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  if (result.error || result.status !== 0)
    throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test('G-722 actual owner migrations serialize, rerun empty, check migration records and forbid providers', async () => {
  const name = `g722-${randomUUID()}`;
  const dir = join(repositoryRoot, '.temp', name);
  mkdirSync(dir, { recursive: true });
  let admin: Pool | undefined;
  const pools: Pool[] = [];
  try {
    docker([
      'run',
      '--detach',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=8d4cb67658b2d230',
      '-p',
      '127.0.0.1::5432',
      'postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722',
    ]);
    const port = docker(['port', name, '5432/tcp']).split(':').at(-1)!;
    const url = (database: string) =>
      `postgres://postgres:8d4cb67658b2d230@127.0.0.1:${port}/${database}`;
    admin = new Pool({ connectionString: url('postgres'), connectionTimeoutMillis: 1_000 });
    const deadline = Date.now() + 60_000;
    while (true) {
      try {
        await admin.query('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await Bun.sleep(250);
      }
    }
    for (const database of ['access', 'relay', 'content', 'account', 'lockproof'])
      await admin.query(`CREATE DATABASE ${database}`);
    const env = {
      ACCESS_DATABASE_URL: url('access'),
      MAIN_RELAY_DATABASE_URL: url('relay'),
      CONTENT_DATABASE_URL: url('content'),
      ACCOUNT_DATABASE_URL: url('account'),
      ACCOUNT_BASE_URL: 'https://accounts.rezics.com',
      ACCOUNT_MAIN_RESOURCE: 'https://main.rezics.com',
      ACCOUNT_SECRET: '8d4cb67658b2d230c437b8a97c2757e18d4cb67658b2d230c437b8a97c2757e1',
    };
    const first = await migrateOwners(env);
    expect(first.length).toBeGreaterThan(10);
    expect(await migrateOwners(env)).toEqual([]);
    expect(await Promise.all([migrateOwners(env), migrateOwners(env)])).toEqual([[], []]);
    for (const owner of ['access', 'relay', 'content', 'account'] as const) {
      const pool = new Pool({ connectionString: url(owner) });
      pools.push(pool);
      await expect(assertSchemaReady(pool, owner)).resolves.toBeUndefined();
    }
    await assertNoPaymentProvider(url('access'));
    await pools[0]!.query(
      "INSERT INTO commerce.payment_provider(id, kind, callback_key_reference, enabled) VALUES ('blocked', 'fake', 'custody-key', false)",
    );
    await expect(assertNoPaymentProvider(url('access'))).rejects.toThrow('provider');
    // A sleeping first migration makes overlapping runners observably compete;
    // without a lock the second CREATE TABLE fails rather than returning empty.
    const migrationDir = join(dir, migrationDirectories.access);
    mkdirSync(migrationDir, { recursive: true });
    writeFileSync(
      join(migrationDir, '001_lock.sql'),
      'SELECT pg_sleep(0.4); CREATE TABLE lock_proof(id integer);',
    );
    const results = await Promise.all([
      migrateTracked(url('lockproof'), dir, migrationDirectories.access),
      migrateTracked(url('lockproof'), dir, migrationDirectories.access),
    ]);
    expect(results.map((result) => result.length).sort()).toEqual([0, 1]);
    writeFileSync(
      join(migrationDir, '002_recovery.sql'),
      'CREATE TABLE recovery_proof(id integer); SELECT 1 / 0;',
    );
    await expect(
      migrateTracked(url('lockproof'), dir, migrationDirectories.access),
    ).rejects.toThrow();
    const recovery = new Pool({ connectionString: url('lockproof') });
    pools.push(recovery);
    expect(
      (await recovery.query("SELECT to_regclass('recovery_proof') AS name")).rows[0].name,
    ).toBeNull();
    writeFileSync(
      join(migrationDir, '002_recovery.sql'),
      'CREATE TABLE recovery_proof(id integer);',
    );
    expect(await migrateTracked(url('lockproof'), dir, migrationDirectories.access)).toEqual([
      `${migrationDirectories.access}/002_recovery.sql`,
    ]);
    expect(await migrateTracked(url('lockproof'), dir, migrationDirectories.access)).toEqual([]);
    writeFileSync(join(migrationDir, '001_lock.sql'), 'CREATE TABLE changed(id integer);');
    expect(await migrateTracked(url('lockproof'), dir, migrationDirectories.access)).toEqual([]);
    // A release artifact must use its own provider definition, not the invoking
    // checkout's auth options. Add a harmless field only in the artifact copy.
    await admin.query('CREATE DATABASE artifactaccount');
    const artifact = join(dir, 'artifact');
    mkdirSync(join(artifact, 'services/account/src'), { recursive: true });
    cpSync(
      join(repositoryRoot, 'services/account/migrations'),
      join(artifact, 'services/account/migrations'),
      { recursive: true },
    );
    cpSync(
      join(repositoryRoot, 'services/account/package.json'),
      join(artifact, 'services/account/package.json'),
    );
    // The release image ships the shared migration order beside Account (release-images.ts).
    mkdirSync(join(artifact, 'scripts/lib'), { recursive: true });
    cpSync(
      join(repositoryRoot, 'scripts/lib/migration-order.ts'),
      join(artifact, 'scripts/lib/migration-order.ts'),
    );
    // The copied fence resolves SQL relative to the artifact, and its supporting imports use this checkout.
    const fence = readFileSync(
      join(repositoryRoot, 'services/account/src/consent-fence.ts'),
      'utf8',
    ).replace(
      "'./installations.ts'",
      JSON.stringify(join(repositoryRoot, 'services/account/src/installations.ts')),
    );
    writeFileSync(join(artifact, 'services/account/src/consent-fence.ts'), fence);
    symlinkSync(join(repositoryRoot, 'node_modules'), join(artifact, 'node_modules'));
    writeFileSync(
      join(artifact, 'services/account/src/auth.ts'),
      `import { accountAuthOptions as current } from ${JSON.stringify(join(repositoryRoot, 'services/account/src/auth.ts'))};
      export function accountAuthOptions(config) { const options = current(config); return { ...options,
        user: { ...options.user, additionalFields: { ...options.user.additionalFields,
          g722ArtifactField: { type: 'string', required: false } } } }; }`,
    );
    await migrateAccount({ ...env, ACCOUNT_DATABASE_URL: url('artifactaccount') }, artifact);
    const artifactPool = new Pool({ connectionString: url('artifactaccount') });
    pools.push(artifactPool);
    expect(
      (
        await artifactPool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'g722ArtifactField'",
        )
      ).rowCount,
    ).toBe(1);
    // Account reruns an edited idempotent migration even after its name was recorded.
    writeFileSync(
      join(artifact, 'services/account/migrations/999_edit_proof.sql'),
      'CREATE TABLE IF NOT EXISTS edit_proof (id integer);',
    );
    await migrateAccount({ ...env, ACCOUNT_DATABASE_URL: url('artifactaccount') }, artifact);
    writeFileSync(
      join(artifact, 'services/account/migrations/999_edit_proof.sql'),
      'CREATE TABLE IF NOT EXISTS edit_proof (id integer); ALTER TABLE edit_proof ADD COLUMN IF NOT EXISTS updated integer;',
    );
    expect(
      await migrateAccount({ ...env, ACCOUNT_DATABASE_URL: url('artifactaccount') }, artifact),
    ).toEqual([]);
    expect(
      (
        await artifactPool.query(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'edit_proof' AND column_name = 'updated'",
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin?.end();
    docker(['rm', '--force', '--volumes', name]);
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
