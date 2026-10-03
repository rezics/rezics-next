import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrationDirectories, type SchemaOwner } from '../ops/migrate.ts';
import { migrationVersion, schemaFiles } from './schema-files.ts';

const root = resolve(import.meta.dir, '../..');

function fixture() {
  mkdirSync(join(root, '.temp'), { recursive: true });
  return mkdtempSync(join(root, '.temp/g-968-schema-'));
}

test('G-968: schema installs share release ordering and parse complete four-digit versions', () => {
  const directory = fixture();
  try {
    for (const owner of Object.keys(migrationDirectories) as SchemaOwner[]) {
      const migrations = join(directory, migrationDirectories[owner]);
      mkdirSync(migrations, { recursive: true });
      for (const name of [
        '1024_current.sql',
        '999_previous.sql',
        '1000_next.sql',
        '1010_branch.sql',
        '099_legacy.sql',
        '100_foundation.sql',
      ]) {
        writeFileSync(join(migrations, name), 'SELECT 1;');
      }
      writeFileSync(join(migrations, 'README.md'), 'Owner migration intent.');
      const files = schemaFiles(directory, owner);
      expect(files).toEqual([
        '099_legacy.sql',
        '100_foundation.sql',
        '999_previous.sql',
        '1000_next.sql',
        '1010_branch.sql',
        '1024_current.sql',
      ]);
      expect(files.map(migrationVersion)).toEqual([99, 100, 999, 1000, 1010, 1024]);
      // The Context foundation upgrade cannot treat 1010 as preceding migration 100.
      expect(files.filter((name) => migrationVersion(name) < 100)).toEqual(['099_legacy.sql']);
      expect(files.filter((name) => migrationVersion(name) > 100)).toEqual([
        '999_previous.sql',
        '1000_next.sql',
        '1010_branch.sql',
        '1024_current.sql',
      ]);
      expect(files.filter((name) => migrationVersion(name) < 1000)).toEqual([
        '099_legacy.sql',
        '100_foundation.sql',
        '999_previous.sql',
      ]);
      expect(files.filter((name) => migrationVersion(name) >= 1000)).toEqual([
        '1000_next.sql',
        '1010_branch.sql',
        '1024_current.sql',
      ]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-968: schema harnesses reject invalid and duplicate versions through the release reader', () => {
  const directory = fixture();
  const migrations = join(directory, migrationDirectories.access);
  mkdirSync(migrations, { recursive: true });
  try {
    writeFileSync(join(migrations, '1000_first.sql'), 'SELECT 1;');
    writeFileSync(join(migrations, '01000_duplicate.sql'), 'SELECT 1;');
    expect(() => schemaFiles(directory, 'access')).toThrow('Invalid access migration');
    rmSync(join(migrations, '01000_duplicate.sql'));
    writeFileSync(join(migrations, '1000.sql'), 'SELECT 1;');
    expect(() => schemaFiles(directory, 'access')).toThrow('Invalid migration');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G-968: every checked-in owner schema retains its full increasing release history', () => {
  for (const owner of Object.keys(migrationDirectories) as SchemaOwner[]) {
    const versions = schemaFiles(root, owner).map(migrationVersion);
    expect(versions.length).toBeGreaterThan(0);
    expect(new Set(versions).size).toBe(versions.length);
    for (let index = 1; index < versions.length; index++) {
      expect(versions[index]!).toBeGreaterThan(versions[index - 1]!);
    }
  }
  expect(schemaFiles(root, 'access').map(migrationVersion)).toContain(1024);
});
