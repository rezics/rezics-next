import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { migrationVersion } from './migration-order.ts';
import { migrationDirectories } from '../ops/migrate.ts';

const root = resolve(import.meta.dir, '../..');
const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

/** Files a branch adds to a migration directory must sort after every migration main already applies; an inserted
 * migration is out of order on existing databases and supersedes every retained fixture generation. */
export function insertedMigrations(directory: string, onMain: readonly string[], onBranch: readonly string[]): string[] {
  const applied = new Set(onMain);
  const head = Math.max(0, ...onMain.map(migrationVersion));
  return onBranch.filter(name => !applied.has(name) && migrationVersion(name) <= head).map(name => `${directory}/${name}`);
}

test('a migration added on a branch is numbered after every migration on main', () => {
  if (git('rev-parse', '--verify', '--quiet', 'main^{commit}').status !== 0) return;
  const inserted = Object.values(migrationDirectories).flatMap(directory => {
    const listed = git('ls-tree', '--name-only', 'main', `${directory}/`);
    const onMain = listed.status === 0 ? listed.stdout.split('\n').filter(Boolean).map(path => path.split('/').pop()!)
      .filter(name => name.endsWith('.sql')) : [];
    const onBranch = readdirSync(join(root, directory)).filter(name => name.endsWith('.sql'));
    return insertedMigrations(directory, onMain, onBranch);
  });
  expect(inserted).toEqual([]);
});

test('an inserted migration is reported and an appended one is not', () => {
  expect(insertedMigrations('access', ['2073_a.sql', '2074_b.sql'], ['2073_a.sql', '2074_b.sql', '1870_new.sql', '2075_next.sql']))
    .toEqual(['access/1870_new.sql']);
  expect(insertedMigrations('access', [], ['1000_first.sql'])).toEqual([]);
});
