import { join } from 'node:path';
import { test } from 'bun:test';
import { expectCostTable } from '../support/growth-cost-table.ts';

test('the access README Cost table cites an existing growth check for every row', () => {
  expectCostTable(join(import.meta.dir, '../../src/access/README.md'), {
    testRoot: join(import.meta.dir, '../..'),
    repositoryRoot: join(import.meta.dir, '../../../..'),
  });
});
