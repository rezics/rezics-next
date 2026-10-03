import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { compareMigrationPaths, migrationVersion } from './migration-order.ts';
import { migrationDirectories, migrationRecords } from '../ops/migrate.ts';
import {
  MIGRATION_DIRECTORIES,
  migrationInventory,
  restoreCompatibility,
  type FixtureManifestCore,
} from '../fixture/manifest.ts';
import { loadCompatibility } from '../load/compatibility.ts';
import { FIXTURE_FORMAT } from '../fixture/corpus.ts';
import type { FixtureEngines } from '../fixture/stack.ts';

const root = resolve(import.meta.dir, '../..');
function temporaryRoot() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp/g-940-migrations-'));
}

test('G-940: numeric migration order preserves every existing owner version', () => {
  for (const directory of Object.values(migrationDirectories)) {
    const files = readdirSync(join(root, directory)).filter((name) => name.endsWith('.sql'));
    expect([...files].sort(compareMigrationPaths).map(migrationVersion)).toEqual(
      files.map(migrationVersion).sort((left, right) => left - right),
    );
    // Three-digit histories retain their original order; newer heads exceed 999.
    const legacy = files.filter((name) => migrationVersion(name) < 1000);
    expect([...legacy].sort(compareMigrationPaths)).toEqual([...legacy].sort());
  }
  for (const inventory of [migrationInventory(root), loadCompatibility(root).files]) {
    expect(Object.keys(inventory)).toEqual(Object.keys(inventory).sort(compareMigrationPaths));
  }
  expect(['1000_next.sql', '999_previous.sql', '986_gap.sql'].sort(compareMigrationPaths)).toEqual([
    '986_gap.sql',
    '999_previous.sql',
    '1000_next.sql',
  ]);
  expect(['1000_b.sql', '1000_a.sql'].sort(compareMigrationPaths)).toEqual([
    '1000_a.sql',
    '1000_b.sql',
  ]);
  expect(migrationVersion('1000_next.sql')).toBe(1000);
  for (const invalid of [
    '000_zero.sql',
    '1000.sql',
    '1000_Upper.sql',
    '9007199254740992_overflow.sql',
  ]) {
    expect(() => migrationVersion(invalid)).toThrow('Invalid migration');
  }
});

test('G-940: release records accept four-digit versions and reject duplicate numeric versions', () => {
  const fixture = temporaryRoot();
  try {
    for (const owner of Object.keys(
      migrationDirectories,
    ) as (keyof typeof migrationDirectories)[]) {
      const directory = join(fixture, migrationDirectories[owner]);
      mkdirSync(directory, { recursive: true });
      for (const file of ['1000_next.sql', '999_previous.sql', '986_gap.sql'])
        writeFileSync(join(directory, file), 'SELECT 1;');
      expect(migrationRecords(fixture, owner).map((record) => record.version)).toEqual([
        986, 999, 1000,
      ]);
      writeFileSync(join(directory, '0999_duplicate.sql'), 'SELECT 1;');
      expect(() => migrationRecords(fixture, owner)).toThrow(`Invalid ${owner} migration`);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('G-940: the Content applier executes 1000 after 999 and skips applied versions on replay', async () => {
  const fixture = temporaryRoot();
  try {
    // Mirror just the real runner and its dependency; never add unreserved migrations to an owner.
    for (const directory of [
      'services/content/src',
      'services/content/migrations',
      'scripts/lib',
    ]) {
      mkdirSync(join(fixture, directory), { recursive: true });
    }
    copyFileSync(
      join(root, 'services/content/src/migrate.ts'),
      join(fixture, 'services/content/src/migrate.ts'),
    );
    copyFileSync(
      join(root, 'scripts/lib/migration-order.ts'),
      join(fixture, 'scripts/lib/migration-order.ts'),
    );
    for (const version of [1000, 999])
      writeFileSync(
        join(fixture, `services/content/migrations/${version}_probe.sql`),
        `SELECT ${version};`,
      );
    const applied: number[] = [],
      statements: string[] = [];
    const pool = {
      connect: async () => ({
        release() {},
        query: async (sql: string, params?: unknown[]) => {
          if (sql.startsWith('SELECT version FROM content.schema_migration'))
            return { rows: applied.map((version) => ({ version })) };
          if (/^SELECT \d+;$/.test(sql)) statements.push(sql);
          if (sql.startsWith('INSERT INTO content.schema_migration'))
            applied.push(params![0] as number);
          return { rows: [] };
        },
      }),
    } as unknown as Pool;
    const { migrateContent } = (await import(
      join(fixture, 'services/content/src/migrate.ts')
    )) as typeof import('../../services/content/src/migrate.ts');
    await migrateContent(pool);
    expect(statements).toEqual(['SELECT 999;', 'SELECT 1000;']);
    expect(applied).toEqual([999, 1000]);
    await migrateContent(pool);
    expect(statements).toHaveLength(2);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('G-940: fixture restore accepts 1000 after 999 and refuses insertion before an applied 1000', () => {
  const engines = Object.fromEntries(
    ['fuseki', 'postgres', 'rustfs'].map((name) => [name, { image: name, id: name }]),
  ) as unknown as FixtureEngines;
  const manifest = {
    format: 'rezics-fixture-manifest-v1',
    fixture: FIXTURE_FORMAT,
    owners: {},
    engines,
    migrations: Object.fromEntries(
      MIGRATION_DIRECTORIES.map((directory) => [`${directory}/999_previous.sql`, 'old']),
    ),
  } as FixtureManifestCore;
  const pending = MIGRATION_DIRECTORIES.map((directory) => `${directory}/1000_next.sql`).sort(
    compareMigrationPaths,
  );
  const current = {
    owners: {},
    engines,
    migrations: {
      ...manifest.migrations,
      ...Object.fromEntries(pending.map((path) => [path, 'new'])),
    },
  };
  expect(restoreCompatibility(manifest, current)).toMatchObject({
    compatible: true,
    pendingMigrations: pending,
  });
  const access = MIGRATION_DIRECTORIES[0];
  const inserted = `${access}/998_inserted.sql`;
  const ahead = { ...manifest, migrations: { [`${access}/1000_next.sql`]: 'new' } };
  expect(
    restoreCompatibility(ahead, {
      ...current,
      migrations: { ...ahead.migrations, [inserted]: 'inserted' },
    }),
  ).toMatchObject({
    compatible: false,
    reasons: [`migration inserted before applied files: ${inserted}`],
  });
});
