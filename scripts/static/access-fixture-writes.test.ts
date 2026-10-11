import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  accessFixtureWriteDebtFiles, scanAccessFixtureWriteText, scanAccessFixtureWrites,
  staleAccessFixtureWriteDebt,
} from './access-fixture-writes.ts';

const fixtures = resolve(import.meta.dir, 'fixtures/access-fixture-writes');
const readFixture = (name: string) => readFileSync(resolve(fixtures, name), 'utf8');

test('finds direct access writes, ignores an interpolated table name, and allows fixture authority calls', () => {
  const lines = readFixture('direct-write.fixture').trim().split('\n');
  const findings = scanAccessFixtureWriteText(lines.join('\n'), 'direct-write.fixture');
  expect(findings).toEqual([
    { file: 'direct-write.fixture', table: 'access.permission_grant' },
    { file: 'direct-write.fixture', table: 'access.representation' },
    { file: 'direct-write.fixture', table: 'access.scope_gate' },
  ]);
  expect(lines.slice(0, 5).map((line, index): string => scanAccessFixtureWriteText(line, `write-${index}`)[0]?.table ?? 'none')).toEqual([
    'access.permission_grant', 'none', 'access.representation', 'access.scope_gate', 'access.permission_grant',
  ]);
  // Each entry of a TRUNCATE list may carry ONLY before its name and * after it.
  expect(scanAccessFixtureWriteText('const q = `TRUNCATE content.work, ONLY access.permission_grant, access.scope_gate`;', 'only.fixture')
    .map(finding => finding.table)).toEqual(['access.permission_grant', 'access.scope_gate']);
  expect(scanAccessFixtureWriteText('const q = `TRUNCATE content.work *, access.permission_grant, access.scope_gate`;', 'star.fixture')
    .map(finding => finding.table)).toEqual(['access.permission_grant', 'access.scope_gate']);
  expect(scanAccessFixtureWriteText(lines[5]!, 'copy-to.fixture')).toEqual([]);
  expect(scanAccessFixtureWriteText(lines[6]!, 'read-only.fixture')).toEqual([]);
  expect(scanAccessFixtureWriteText(lines[7]!, 'truncate-list.fixture')).toEqual([
    { file: 'truncate-list.fixture', table: 'access.permission_grant' },
  ]);
  expect(scanAccessFixtureWriteText(readFixture('grant-authority.fixture'), 'grant-authority.fixture')).toEqual([]);
});

test('scans TypeScript below directories named migrations and excludes only the access module', () => {
  const temporaryBase = resolve(import.meta.dir, '../../.temp');
  mkdirSync(temporaryBase, { recursive: true });
  const root = mkdtempSync(join(temporaryBase, 'access-fixture-write-scan-'));
  try {
    const source = readFixture('direct-write.fixture');
    const migrationFile = join(root, 'scripts/migrations/direct-write.ts');
    const singularMigrationFile = join(root, 'services/migration/direct-write.ts');
    const accessFile = join(root, 'services/main/src/modules/access/direct-write.ts');
    mkdirSync(dirname(migrationFile), { recursive: true });
    mkdirSync(dirname(singularMigrationFile), { recursive: true });
    mkdirSync(dirname(accessFile), { recursive: true });
    writeFileSync(migrationFile, source);
    writeFileSync(singularMigrationFile, source);
    writeFileSync(accessFile, source);
    expect(accessFixtureWriteDebtFiles(scanAccessFixtureWrites(root))).toEqual([
      'scripts/migrations/direct-write.ts', 'services/migration/direct-write.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracked direct access writes only shrink', () => {
  const findings = scanAccessFixtureWrites();
  const debt = JSON.parse(readFileSync(resolve(import.meta.dir, 'access-fixture-writes-debt.json'), 'utf8')) as string[];
  const debtFiles = new Set(debt);
  const newWrites = findings.filter(item => !debtFiles.has(item.file));
  if (newWrites.length) {
    throw new Error(newWrites.map(item =>
      `${item.file}: writes ${item.table}; call grantFixtureAuthority from services/main/src/modules/access/fixture-authority.ts`,
    ).join('\n'));
  }
  const stale = staleAccessFixtureWriteDebt(findings, debt);
  if (stale.length) throw new Error(`listed files no longer write a protected table:\n${stale.join('\n')}`);
  expect(debt).toEqual(accessFixtureWriteDebtFiles(findings));
  expect(debt).toEqual([...new Set(debt)].sort());
});
