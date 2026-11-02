import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, type AccessPathSample } from './growth-access-path.ts';
import type { Cost } from './growth-cost.ts';

const relation = 'content.report';

function cost(relations: Cost['relations']): Cost {
  return {
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    rows: 1,
    blocks: 1,
    sharedHit: 1,
    sharedRead: 0,
    relations,
  };
}

function sample(repetitions: readonly Cost[], relationSizes = { [relation]: { reltuples: 1, relpages: 9 } }): AccessPathSample {
  return { scale: 32, repetitions, relationSizes };
}

test('empty and sparse repetition evidence is distinct from a measured index path', () => {
  expect(() => assertGrowthAccessPaths('empty', [], [relation])).toThrow('sample 1, repetition 1, field samples');
  expect(() => assertGrowthAccessPaths('empty repetition', [sample([])], [relation])).toThrow('field repetitions');
  expect(() => assertGrowthAccessPaths('sparse repetition', [sample(new Array<Cost>(1))], [relation])).toThrow(
    'repetition 1, field repetitions[1]',
  );
  expect(() => assertGrowthAccessPaths('measured index', [sample([cost({
    [relation]: { rows: 1, blocks: 1, nodes: 1, sequentialScans: 0 },
  })])], [relation])).not.toThrow();
});

test('unexecuted relations need no footprint and scan counts must be integers', () => {
  expect(() => assertGrowthAccessPaths('not executed', [sample([cost({})], {})], [relation])).not.toThrow();
  const fractional = cost({ [relation]: { rows: 1, blocks: 1, nodes: 1, sequentialScans: 0.5 } });
  expect(() => assertGrowthAccessPaths('fractional scan', [sample([fractional])], [relation])).toThrow(
    'field repetitions[1].relations.content.report.sequentialScans',
  );
});
