// sql-relations-allow: access.upgrade_identity -- Synthetic relation created in an isolated migration-runner test database.
// sql-relations-allow: access.upgrade_version -- Synthetic online index created in an isolated migration-runner test database.
// sql-relations-allow: access.must_roll_back -- Deliberately failed synthetic migration must roll back this relation.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { applyQaSqlMigrations } from '../qa/bootstrap.ts';
import { preserveReapEnvironment } from '../qa/container-reaper.ts';
import { migrateTracked, migrationDirectories, repositoryRoot, withDatabaseLock } from './migrate.ts';

test('QA receipts share the owner lock, exact selection, transactions and subsequent upgrades', async () => {
  mkdirSync(join(repositoryRoot, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repositoryRoot, '.temp/qa-tracked-test-'));
  const directory = join(root, migrationDirectories.access);
  mkdirSync(directory, { recursive: true });
  const name = `qa-tracked-${randomUUID()}`;
  let started = false;
  let db: Client | undefined;
  const docker = (args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000,
      env: preserveReapEnvironment(process.env) });
    if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  try {
    docker(['run', '--detach', '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432',
      'postgres:18.6-trixie@sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722']);
    started = true;
    const port = docker(['port', name, '5432/tcp']).split(':').at(-1)!;
    const url = `postgres://postgres@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 60_000;
    while (true) {
      db = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
      try { await db.connect(); break; }
      catch (error) { await db.end(); if (Date.now() > deadline) throw error; await Bun.sleep(100); }
    }
    writeFileSync(join(directory, '001_baseline.sql'), `SELECT pg_sleep(0.4);
      CREATE SCHEMA access; CREATE TABLE access.upgrade_identity(id text PRIMARY KEY, version integer NOT NULL);
      INSERT INTO access.upgrade_identity VALUES ('original-subject',1);`);
    writeFileSync(join(directory, '002_online.sql'), `-- migrate: concurrent-index access.upgrade_version
      CREATE INDEX CONCURRENTLY upgrade_version ON access.upgrade_identity(version);`);
    writeFileSync(join(directory, '003_upgrade.sql'), 'ALTER TABLE access.upgrade_identity ADD COLUMN preserved boolean NOT NULL DEFAULT true;');
    // An explicit subset does not mark its unselected neighbours applied.
    await applyQaSqlMigrations(url, directory, ['001_baseline.sql']);
    expect((await db.query('SELECT name FROM public.rezics_local_migration')).rows)
      .toEqual([{ name: `${migrationDirectories.access}/001_baseline.sql` }]);
    expect((await db.query("SELECT to_regclass('access.upgrade_version') AS name")).rows[0].name).toBeNull();
    await applyQaSqlMigrations(url, directory, []);
    expect((await db.query('SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count).toBe(1);
    await expect(applyQaSqlMigrations(url, directory, ['../001_baseline.sql'])).rejects.toThrow('Invalid access migration selection');
    await expect(applyQaSqlMigrations(url, directory, ['001_baseline.sql', '001_baseline.sql'])).rejects.toThrow('Invalid access migration selection');
    await Promise.all([applyQaSqlMigrations(url, directory), migrateTracked(url, root, migrationDirectories.access)]);
    expect(await migrateTracked(url, root, migrationDirectories.access)).toEqual([]);
    expect((await db.query('SELECT name FROM public.rezics_local_migration ORDER BY name')).rows).toHaveLength(3);
    expect((await db.query('SELECT * FROM access.upgrade_identity')).rows)
      .toEqual([{ id: 'original-subject', version: 1, preserved: true }]);
    writeFileSync(join(directory, '004_failure.sql'), `CREATE TABLE access.must_roll_back(id integer);
      UPDATE access.upgrade_identity SET version=2; SELECT 1/0;`);
    await expect(applyQaSqlMigrations(url, directory)).rejects.toThrow('division by zero');
    expect((await db.query("SELECT to_regclass('access.must_roll_back') AS name")).rows[0].name).toBeNull();
    expect((await db.query('SELECT version FROM access.upgrade_identity')).rows[0].version).toBe(1);
    expect((await db.query('SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count).toBe(3);
    writeFileSync(join(directory, '004_failure.sql'), 'UPDATE access.upgrade_identity SET version=2;');
    expect(await migrateTracked(url, root, migrationDirectories.access))
      .toEqual([`${migrationDirectories.access}/004_failure.sql`]);
    await applyQaSqlMigrations(url, directory);
    expect((await db.query('SELECT * FROM access.upgrade_identity')).rows)
      .toEqual([{ id: 'original-subject', version: 2, preserved: true }]);

    await db.query('CREATE DATABASE race');
    const race = new URL(url);
    race.pathname = '/race';
    await Promise.all([applyQaSqlMigrations(race.href, directory), migrateTracked(race.href, root, migrationDirectories.access)]);
    // Production never adopts the same preexisting schema without receipts.
    await db.query('CREATE DATABASE untracked');
    const untracked = new URL(url);
    untracked.pathname = '/untracked';
    const old = new Client({ connectionString: untracked.href });
    await old.connect();
    try {
      await old.query('CREATE SCHEMA access');
      await expect(migrateTracked(untracked.href, root, migrationDirectories.access)).rejects.toThrow('already exists');
      expect((await old.query('SELECT count(*)::int AS count FROM public.rezics_local_migration')).rows[0].count).toBe(0);
    } finally { await old.end(); }

    await db.query("SELECT pg_advisory_lock(hashtextextended('rezics-release-migrations', 0))");
    try {
      await expect(withDatabaseLock(url, async () => { throw new Error('entered locked owner'); }, 100))
        .rejects.toThrow('Timed out waiting for migration lock');
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtextextended('rezics-release-migrations', 0))");
    }
    expect(await withDatabaseLock(url, async () => 'released', 100)).toBe('released');
  } finally {
    await db?.end();
    if (started) docker(['rm', '--force', '--volumes', name]);
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
