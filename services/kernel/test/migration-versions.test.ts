import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMigrationVersions } from '../scripts/database.ts';

const fixtureDirectories: string[] = [];
const temporaryDirectory = join(import.meta.dir, '../../../.temp');

function migrationFixture(files: Record<string, string>): { directory: string; paths: string[] } {
  mkdirSync(temporaryDirectory, { recursive: true });
  const directory = mkdtempSync(join(temporaryDirectory, 'migration-versions-'));
  fixtureDirectories.push(directory);
  for (const [file, contents] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return { directory, paths: Object.keys(files) };
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('a migration more than five minutes in the future is refused with its file name', () => {
  const file = 'db/content/migrations/20261025120600_content_future.sql';
  const fixture = migrationFixture({ [file]: '-- migrate:up\nselect 1;\n' });
  expect(() => validateMigrationVersions(fixture.paths, new Date('2026-10-25T12:00:00Z'), fixture.directory)).toThrow(
    new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*date -u \\+%Y%m%d%H%M%S`, 's'),
  );
});

test('migration versions are unique across modules', () => {
  const first = 'db/access/migrations/20261025110000_access.sql';
  const second = 'db/content/migrations/20261025110000_content.sql';
  const fixture = migrationFixture({
    [first]: '-- migrate:up\nselect 1;\n',
    [second]: '-- migrate:up\nselect 1;\n',
  });
  expect(() => validateMigrationVersions(fixture.paths, new Date('2026-10-25T12:00:00Z'), fixture.directory)).toThrow(
    new RegExp(
      `${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*${second.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*date -u \\+%Y%m%d%H%M%S`,
      's',
    ),
  );
});

test('dbmate up markers accept normal and no-transaction headers after leading comments', () => {
  const fixture = migrationFixture({
    'db/core/migrations/20261025100000_default.sql': '-- generated header\n-- migrate:up\nselect 1;\n',
    'db/core/migrations/20261025100001_no_transaction.sql':
      '-- generated header\n-- migrate:up transaction:false\nselect 1;\n',
  });
  expect(() =>
    validateMigrationVersions(fixture.paths, new Date('2026-10-25T12:00:00Z'), fixture.directory),
  ).not.toThrow();
});

test('a down-only migration is refused with the file and minimal fix', () => {
  const file = 'db/core/migrations/20261025100000_down_only.sql';
  const fixture = migrationFixture({ [file]: '-- migrate:down\nselect 1;\n' });
  expect(() => validateMigrationVersions(fixture.paths, new Date('2026-10-25T12:00:00Z'), fixture.directory)).toThrow(
    `${file}: missing dbmate up marker; add \`-- migrate:up\` before the up SQL`,
  );
});

test('a header larger than the bounded scan gets an actionable diagnostic', () => {
  const file = 'db/core/migrations/20261025100000_long_header.sql';
  const fixture = migrationFixture({ [file]: `${'-- note\n'.repeat(80)}-- migrate:up\nselect 1;\n` });
  expect(() => validateMigrationVersions(fixture.paths, new Date('2026-10-25T12:00:00Z'), fixture.directory)).toThrow(
    `${file}: no dbmate up marker found within the first 512 bytes`,
  );
});
