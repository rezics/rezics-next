import { expect, test } from 'bun:test';

// Reproduce the retained owner state from the manager's failing integration
// shard in one Bun process, rather than resetting storage between files.
const predecessors = [
  './credit-source-reported.test.ts',
  './export-api.test.ts',
  './export-method-evaluation.test.ts',
  './export-owner.test.ts',
  './export-planner.test.ts',
  './export-source-vndb.test.ts',
  './export-verification.test.ts',
  './fresh-install.test.ts',
  './erasure-schema.test.ts',
  './g-1007-follow-provenance.test.ts',
];
for (const file of predecessors) await import(file);
await import('./discovery-projection.test.ts');
await import('./g-1001-work-cards.test.ts');
await import('./g-1011-optional-work-reads.test.ts');

test('G1064: discovery seek, card cost and optional reads run after ten predecessor files', () => {
  expect(new Set(predecessors).size).toBe(10);
});
