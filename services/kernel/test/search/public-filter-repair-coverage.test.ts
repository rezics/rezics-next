import { expect, test } from 'bun:test';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import type { DiscoveryConsumerCaptureInput } from '../../src/search/discovery.ts';
import { hasDispatchableRepairCoverage } from '../../src/search/public-filter-repair-coverage.ts';

test('all-key Subject publication can dispatch repair while a negated predicate remains unproved', () => {
  const records = [{ indexed: null }];
  const scope = {
    capture: { filterDocument: undefined, text: undefined, sort: 'id', size: 1 },
    subjectPublication: true,
    mixedPreparation: false,
  } as const;
  expect(hasDispatchableRepairCoverage(records, scope)).toBe(true);
  expect(hasDispatchableRepairCoverage(records, { ...scope, subjectPublication: false })).toBe(false);

  const filterDocument = {
    not: { statement: { property: 'schema:author', in: ['018f0000-0000-7000-8000-00a000000009'] } },
  };
  expect(compileCurrentFilter(filterDocument).evaluate(['not_proven'])).toBe('not_proven');
  expect(hasDispatchableRepairCoverage(records, { ...scope, capture: { ...scope.capture, filterDocument } })).toBe(
    false,
  );
});

test('complete mixed Home repair dispatches with the retained 17 unresolved projections out of 33', () => {
  const records = Array.from({ length: 33 }, (_, index) => ({
    indexed: index < 17 ? null : { property: 'schema:name', value: 'Book' },
  }));
  const filterDocument = { kind: { in: ['schema:Book', 'schema:BookSeries', 'bf:Instance'] } };
  const capture: DiscoveryConsumerCaptureInput = {
    representation: 'discovery-v1',
    comparator: 'mixed-public-v1',
    filterDocument,
    filter: {
      bool: {
        filter: [
          { terms: { kind: [...filterDocument.kind.in, 'account'] } },
          { terms: { kind: filterDocument.kind.in } },
        ],
      },
    },
    text: undefined,
    sort: 'name',
    size: 41,
    pageSize: 20,
    overflowProperties: [],
  };
  const scope = { capture, mixedPreparation: true, subjectPublication: false };
  expect(hasDispatchableRepairCoverage(records, scope)).toBe(true);
  expect(hasDispatchableRepairCoverage(records, { ...scope, mixedPreparation: false })).toBe(false);
  for (const change of [
    { filterDocument: { kind: { in: ['schema:Book', 'schema:Book', 'bf:Instance'] } } },
    { filterDocument: { kind: { in: ['schema:Book', 'schema:BookSeries', 'account'] } } },
    { filterDocument: { not: filterDocument } },
    { filterDocument: { and: [filterDocument, { statement: { property: 'schema:author', in: ['author'] } }] } },
    { text: { kind: 'term', value: 'Book' } },
  ] satisfies Partial<DiscoveryConsumerCaptureInput>[]) {
    expect(hasDispatchableRepairCoverage(records, { ...scope, capture: { ...capture, ...change } })).toBe(false);
  }
});
