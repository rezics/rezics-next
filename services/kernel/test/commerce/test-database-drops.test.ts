import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = [
  'test/commerce/governance.test.ts',
  'test/commerce/payout-mark-paid.test.ts',
  'test/commerce/support/outcome-driver.ts',
  'test/library/support/outcome-driver.ts',
];
const kernel = resolve(import.meta.dir, '../..');
const forcedDrop = /DROP\s+DATABASE[^;`'"]*WITH\s*\(\s*FORCE\s*\)/i;
const helperImport = /import\s*\{[^}]*\bdropTestDatabase\b[^}]*\}\s*from\s*'[^']*support\/drop-test-database\.ts'/;

test('commerce and library tests drop their databases through dropTestDatabase', () => {
  for (const file of files) {
    const source = readFileSync(resolve(kernel, file), 'utf8');
    expect({ file, raw: forcedDrop.test(source) }).toEqual({ file, raw: false });
    expect({ file, helper: helperImport.test(source) && source.includes('dropTestDatabase(') }).toEqual({
      file,
      helper: true,
    });
  }
  const guard = readFileSync(resolve(kernel, 'test/support/drop-test-database.test.ts'), 'utf8');
  expect(files.filter((file) => guard.includes(file))).toEqual([]);
});
