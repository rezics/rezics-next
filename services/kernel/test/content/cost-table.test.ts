import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { costTableProblems, readCostTable } from '../support/growth-cost-table.ts';

const missingGrowthChecks = ['Report effect projection', 'Realm board point read'];

test('the content README Cost table cites an existing growth check for every row', () => {
  const readme = join(import.meta.dir, '../../src/content/README.md');
  const options = {
    testRoot: join(import.meta.dir, '../..'),
    repositoryRoot: join(import.meta.dir, '../../../..'),
  };
  const rows = readCostTable(readme);
  const missing = rows.filter((row) => row.check.startsWith('Missing:'));

  expect(missing.map((row) => row.operation).sort()).toEqual([...missingGrowthChecks].sort());
  expect(costTableProblems(readme, options)).toEqual(
    missing.map(
      (row) =>
        `${readme}: operation "${row.operation}": growth check must be a test citation or "None:" followed by a reason`,
    ),
  );
});
