import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');

const rules = [
  { id: 'numeric-migration-order', rule: { all: [
    { pattern: '$FILES.sort()' }, { regex: '\\.sql|\\b(?:migrations|sqlFiles)\\b' },
  ] } },
  { id: 'complete-migration-version', rule: { any: [
    { pattern: 'Number($FILE.slice(0, 3))' },
    { pattern: 'parseInt($FILE.slice(0, 3))' },
    { pattern: 'Number.parseInt($FILE.slice(0, 3))' },
  ] } },
  { id: 'complete-migration-filename', rule: { kind: 'regex', regex: '\\\\d\\{3\\}.*\\.sql' } },
  { id: 'numeric-migration-head', rule: { any: [
    { pattern: '$FILE < $HEAD' }, { pattern: '$FILE <= $HEAD' },
    { pattern: '$FILE > $HEAD' }, { pattern: '$FILE >= $HEAD' },
  ] }, constraints: {
    FILE: { regex: '^(?:file|name)$' },
    HEAD: { regex: `^(?:['"]\\d{3,}.*['"]|OWN|SOLO|migration)$` },
  } },
].map(rule => JSON.stringify({ ...rule, language: 'TypeScript', severity: 'error',
  message: 'Use the shared numeric migration reader and complete version parser.' })).join('\n---\n');

interface Match { file: string; ruleId: string; range: { start: { line: number } } }
function violations(source?: string): string[] {
  // Use the repository's pinned parser; literal fixture strings are not executable AST nodes.
  const result = spawnSync(join(root, 'node_modules/.bin/ast-grep'), ['scan',
    '--inline-rules', rules, '--json=compact',
    ...(source === undefined ? ['scripts', 'services', 'tests'] : ['--stdin'])],
  { cwd: root, input: source, encoding: 'utf8' });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(result.stderr || result.error?.message || 'Migration AST audit failed');
  }
  return (JSON.parse(result.stdout) as Match[]).map(match =>
    `${match.file}:${match.range.start.line + 1}: ${match.ruleId}`);
}

test('G-968: the migration source audit catches lexical installs and truncated upgrade heads', () => {
  const broken = `
    const files = [...new Bun.Glob('*.sql').scanSync({ cwd: migrations })].sort();
    const content = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
    const version = Number(file.slice(0, 3));
    const accepted = /^\\d{3}_[a-z0-9_]+\\.sql$/.test(file);
    const OWN = '100_context_selection.sql';
    const before = files.filter(file => file < OWN);
    const upgrade = files.filter(file => file >= '100');
  `;
  expect(violations(broken)).toHaveLength(6);
  expect(violations(`
    const files = schemaFiles(root, 'access');
    const versions = files.map(migrationVersion).sort((left, right) => left - right);
    const owned = files.filter(file => migrationVersion(file) >= 100 && migrationVersion(file) < 110);
    const fixtureFiles = [...new Bun.Glob('g-865-*-fixture.ts').scanSync({ cwd: dir })].sort();
    const sql = files.sort(compareMigrationPaths);
  `)).toEqual([]);
});

test('G-968: repository migration readers share numeric order and complete versions', () => {
  expect(violations()).toEqual([]);
});
