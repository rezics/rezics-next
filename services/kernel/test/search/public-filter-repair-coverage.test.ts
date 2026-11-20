import { expect, test } from 'bun:test';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { hasDispatchableRepairCoverage } from '../../src/search/public-filter-repair-coverage.ts';

test('all-key Subject publication can dispatch repair while a negated predicate remains unproved', () => {
  const records = [{ indexed: null }];
  const capture = { filterDocument: undefined, text: undefined, sort: 'id', size: 1 } as const;
  expect(hasDispatchableRepairCoverage(records, { capture, subjectPublication: true })).toBe(true);
  expect(hasDispatchableRepairCoverage(records, { capture, subjectPublication: false })).toBe(false);

  const filterDocument = {
    not: { statement: { property: 'schema:author', in: ['018f0000-0000-7000-8000-00a000000009'] } },
  };
  expect(compileCurrentFilter(filterDocument).evaluate(['not_proven'])).toBe('not_proven');
  expect(
    hasDispatchableRepairCoverage(records, { capture: { ...capture, filterDocument }, subjectPublication: true }),
  ).toBe(false);
});
