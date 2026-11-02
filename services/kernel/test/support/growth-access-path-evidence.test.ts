import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, type AccessPathSample } from './growth-access-path.ts';
import type { Cost } from './growth-cost.ts';
import type { RelationIdentity } from './growth-relation-identity.ts';

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

function sample(
  repetitions: readonly Cost[],
  relationSizes: AccessPathSample['relationSizes'] = { [relation]: { reltuples: 1, relpages: 9 } },
): AccessPathSample {
  return { scale: 32, repetitions, relationSizes };
}

test('empty and sparse repetition evidence is distinct from a measured index path', () => {
  expect(() => assertGrowthAccessPaths('empty', [], [relation])).toThrow('sample 1, repetition 1, field samples');
  expect(() => assertGrowthAccessPaths('empty repetition', [sample([])], [relation])).toThrow('field repetitions');
  expect(() => assertGrowthAccessPaths('sparse repetition', [sample(new Array<Cost>(1))], [relation])).toThrow(
    'repetition 1, field repetitions[1]',
  );
  expect(() =>
    assertGrowthAccessPaths(
      'measured index',
      [
        sample([
          cost({
            [relation]: { rows: 1, blocks: 1, nodes: 1, sequentialScans: 0 },
          }),
        ]),
      ],
      [relation],
    ),
  ).not.toThrow();
});

test('unexecuted relations need no footprint and scan counts must be integers', () => {
  expect(() => assertGrowthAccessPaths('not executed', [sample([cost({})], {})], [relation])).not.toThrow();
  const fractional = cost({ [relation]: { rows: 1, blocks: 1, nodes: 1, sequentialScans: 0.5 } });
  expect(() => assertGrowthAccessPaths('fractional scan', [sample([fractional])], [relation])).toThrow(
    'field repetitions[1].relations.content.report.sequentialScans',
  );
});

test('relation costs and footprints are traversed once per repetition and sample', () => {
  const identities: RelationIdentity[] = Array.from({ length: 24 }, (_, index) => ({
    database: 'kernel',
    schema: 'content',
    kind: 'relation',
    name: `relation_${index}`,
  }));
  const relationTraversals = [0, 0, 0];
  let footprintTraversals = 0;
  const relationSizes = new Proxy(
    Object.fromEntries(identities.map((identity, index) => [String(index), { identity, reltuples: 1, relpages: 9 }])),
    {
      ownKeys(target) {
        footprintTraversals++;
        return Reflect.ownKeys(target);
      },
    },
  );
  const repetitions = relationTraversals.map((_, repetitionIndex) => {
    const relations = Object.fromEntries(
      identities.map((identity, index) => [
        String(index),
        { identity, rows: 1, blocks: 1, nodes: 1, sequentialScans: 0 },
      ]),
    ) as Cost['relations'];
    const measuredRelations = new Proxy(relations, {
      ownKeys(target) {
        relationTraversals[repetitionIndex] = relationTraversals[repetitionIndex]! + 1;
        return Reflect.ownKeys(target);
      },
    });
    return cost(measuredRelations);
  });

  expect(() =>
    assertGrowthAccessPaths(
      'indexed evidence',
      [{ scale: 32, repetitions, relationSizes: relationSizes as AccessPathSample['relationSizes'] }],
      identities,
    ),
  ).not.toThrow();
  expect(relationTraversals).toEqual([1, 1, 1]);
  expect(footprintTraversals).toBe(1);
});
