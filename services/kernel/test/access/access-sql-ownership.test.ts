import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Inspect SQL files and embedded TypeScript SQL, preserving offsets for diagnostics.
function accessWrites(source: string): number[] {
  const code = source.replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, ' '));
  const identifier = '(?:"(?:[^"]|"")*"|[a-z_][a-z0-9_$]*)';
  const table = `${identifier}(?:\\s*\\.\\s*${identifier})?`;
  const targets = new RegExp(
    `\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|MERGE\\s+INTO)\\s+(?:ONLY\\s+)?(${table})|\\bTRUNCATE\\s+(?:TABLE\\s+)?((?:ONLY\\s+)?${table}(?:\\s*\\*?\\s*,\\s*(?:ONLY\\s+)?${table})*)`,
    'gi',
  );
  return [...code.matchAll(targets)]
    .filter((match) => /(?:^|,)\s*(?:ONLY\s+)?(?:access|"access")\s*\./i.test(match[1] ?? match[2]!))
    .map((match) => source.slice(0, match.index).split('\n').length);
}

test('only Access product code writes access tables', async () => {
  const root = resolve(import.meta.dir, '../..');
  const violations: string[] = [];
  for (const file of [...new Bun.Glob('src/**/*.{sql,ts}').scanSync({ cwd: root })].sort()) {
    if (file.startsWith('src/access/')) continue;
    for (const line of accessWrites(await Bun.file(resolve(root, file)).text())) violations.push(`${file}:${line}`);
  }
  expect(violations, `Access table writes outside src/access/:\n${violations.join('\n')}`).toEqual([]);
});

test('ownership scan recognizes every write form, multiline SQL, quoted names and truncate lists', () => {
  for (const sql of [
    'INSERT INTO access.account VALUES (1)',
    'update ONLY access.account SET state = $1',
    'DELETE\nFROM access.account',
    'MERGE INTO "access"."account" USING input ON true',
    'TRUNCATE access.account',
    'TRUNCATE TABLE commerce.offer, ONLY access.account, access.resource_grant',
    'INSERT /* command */ INTO access.account VALUES (1)',
    'const sql = `INSERT INTO access.account VALUES (1)`;',
  ])
    expect(accessWrites(`\n${sql}`)).toEqual([2]);
  expect(
    accessWrites('-- INSERT INTO access.account\n/* UPDATE access.account */ SELECT * FROM access.account'),
  ).toEqual([]);
  expect(accessWrites('UPDATE commerce.offer SET title = $1')).toEqual([]);
});
