import { join } from 'node:path';
import { test } from 'bun:test';
import { expectCostTable } from '../../kernel/test/support/growth-cost-table.ts';

test('the Auth README Cost table cites an existing growth check for every row', () => {
  expectCostTable(join(import.meta.dir, '../README.md'), {
    testRoot: join(import.meta.dir, '..'),
    repositoryRoot: join(import.meta.dir, '../../..'),
  });
});
