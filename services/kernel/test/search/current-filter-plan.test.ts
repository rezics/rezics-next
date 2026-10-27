import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import {
  anyCurrentMatch,
  compileCurrentFilter,
  currentClauseKey,
  type CurrentFilterPlan,
} from '../../src/search/current-filter-plan.ts';
import type { FactClause } from '../../src/search/disclosure/check.ts';
import type { RelationFacetMatch } from '../../src/search/source.ts';

// Pure Boolean specifications. Leaf results are supplied evidence, not proof of source membership.
const a: FilterDocument = { type: { in: ['item:book'] } };
const b: FilterDocument = { statement: { property: 'item:author', in: ['person:alice'] } };
const c: FilterDocument = { statement: { property: 'item:year', range: { gte: 2000 } } };
const clauses: FactClause[] = [
  { facet: 'type', values: ['item:book'] },
  { facet: 'statement', property: 'item:author', values: ['person:alice'] },
  { facet: 'statement', property: 'item:year', range: { gte: 2000 } },
];
const truthTable: readonly (readonly [
  RelationFacetMatch,
  RelationFacetMatch,
  RelationFacetMatch,
  RelationFacetMatch,
])[] = [
  [true, true, true, true],
  [true, false, false, true],
  [true, 'not_proven', 'not_proven', true],
  [false, true, false, true],
  [false, false, false, false],
  [false, 'not_proven', false, 'not_proven'],
  ['not_proven', true, 'not_proven', true],
  ['not_proven', false, false, 'not_proven'],
  ['not_proven', 'not_proven', 'not_proven', 'not_proven'],
];

for (const [left, right, and, or] of truthTable) {
  test(`current AND(${left}, ${right}) = ${and}`, () => {
    expect(compileCurrentFilter({ and: [a, b] }).evaluate([left, right])).toBe(and);
  });
  test(`current OR(${left}, ${right}) = ${or}`, () => {
    expect(compileCurrentFilter({ or: [a, b] }).evaluate([left, right])).toBe(or);
  });
  test(`alternative evidence OR(${left}, ${right}) = ${or}`, () => {
    expect(anyCurrentMatch([left, right])).toBe(or);
  });
}

test('empty alternative evidence is false and single evidence retains its truth value', () => {
  expect(anyCurrentMatch([])).toBe(false);
  for (const value of [true, false, 'not_proven'] as const) expect(anyCurrentMatch([value])).toBe(value);
});

for (const [value, negated] of [
  [true, false],
  [false, true],
  ['not_proven', 'not_proven'],
] as const) {
  test(`NOT ${value} = ${negated}; double NOT restores ${value}`, () => {
    expect(compileCurrentFilter({ not: a }).evaluate([value])).toBe(negated);
    expect(compileCurrentFilter({ not: { not: a } }).evaluate([value])).toBe(value);
  });
}

test('nested expressions share first-occurrence leaves and evaluate their original occurrences', () => {
  const plan: CurrentFilterPlan = compileCurrentFilter({ or: [{ and: [a, { not: b }] }, { and: [b, c, a] }] });
  expect(plan.leaves).toEqual(clauses);
  expect([...plan.indices]).toEqual(clauses.map((clause, index) => [currentClauseKey(clause), index]));
  expect([...plan.positive].sort()).toEqual([0, 1, 2]);
  expect(plan.evaluate([true, false, 'not_proven'])).toBe(true);
  expect(plan.evaluate([true, 'not_proven', false])).toBe('not_proven');
  expect(plan.evaluate([false, true, true])).toBe(false);
  expect(plan.evaluate([true, true, true])).toBe(true);
});

test('positive tracks any positive occurrence, including double NOT, regardless of visit order', () => {
  for (const occurrences of [
    [{ not: a }, a],
    [a, { not: a }],
  ]) {
    const plan = compileCurrentFilter({ and: [...occurrences, { not: b }, { not: { not: c } }] });
    expect(plan.leaves).toEqual(clauses);
    expect([...plan.positive].sort()).toEqual([0, 2]);
    expect(plan.evaluate(['not_proven', false, true])).toBe('not_proven');
  }
  expect([...compileCurrentFilter({ not: { or: [a, b] } }).positive]).toEqual([]);
  expect([...compileCurrentFilter({ not: { and: [{ not: a }, b] } }).positive]).toEqual([0]);
});

test('equivalent values and qualifier sets have stable keys and share one leaf', () => {
  const first = {
    property: 'item:author',
    in: ['person:bob', 'person:alice', 'person:bob'],
    qualifiers: [
      { property: 'item:role', in: ['role:editor', 'role:writer', 'role:editor'] },
      { property: 'item:language', in: ['language:en'] },
      { property: 'item:role', in: ['role:writer', 'role:editor'] },
    ],
  };
  const second = {
    property: 'item:author',
    in: ['person:alice', 'person:bob'],
    qualifiers: [
      { property: 'item:language', in: ['language:en'] },
      { property: 'item:role', in: ['role:writer', 'role:editor'] },
    ],
  };
  const key = currentClauseKey({
    facet: 'statement',
    property: first.property,
    values: first.in,
    qualifiers: first.qualifiers,
  });
  expect(key).toBe(
    currentClauseKey({
      facet: 'statement',
      property: second.property,
      values: second.in,
      qualifiers: second.qualifiers,
    }),
  );
  expect(currentClauseKey({ facet: 'type', values: ['item:book', 'item:film', 'item:book'] })).toBe(
    currentClauseKey({ facet: 'type', values: ['item:film', 'item:book'] }),
  );
  expect(currentClauseKey({ facet: 'statement', property: first.property, values: first.in })).toBe(
    currentClauseKey({ facet: 'statement', property: first.property, values: first.in, qualifiers: [] }),
  );
  const plan = compileCurrentFilter({ or: [{ statement: first }, { not: { statement: second } }] });
  expect(plan.leaves).toHaveLength(1);
  expect([...plan.indices]).toEqual([[key, 0]]);
  expect([...plan.positive]).toEqual([0]);
  expect(plan.evaluate(['not_proven'])).toBe('not_proven');
});

test('keys retain property, facet, range bounds, unit and conjunctive qualifier distinctions', () => {
  const facts: FactClause[] = [
    ...clauses,
    { facet: 'statement', property: 'item:author', values: ['person:bob'] },
    { facet: 'statement', property: 'item:editor', values: ['person:alice'] },
    { facet: 'statement', property: 'item:year', range: { lte: 2000 } },
    { facet: 'statement', property: 'item:year', range: { gte: 2000, unit: 'unit:year' } },
    {
      facet: 'statement',
      property: 'item:author',
      values: ['person:alice'],
      qualifiers: [{ property: 'item:role', in: ['role:writer'] }],
    },
    {
      facet: 'statement',
      property: 'item:author',
      values: ['person:alice'],
      qualifiers: [{ property: 'item:role', in: ['role:editor'] }],
    },
    {
      facet: 'statement',
      property: 'item:author',
      values: ['person:alice'],
      qualifiers: [{ property: 'item:role', in: ['role:writer', 'role:editor'] }],
    },
    {
      facet: 'statement',
      property: 'item:author',
      values: ['person:alice'],
      qualifiers: [
        { property: 'item:role', in: ['role:writer'] },
        { property: 'item:role', in: ['role:editor'] },
      ],
    },
  ];
  expect(new Set(facts.map(currentClauseKey)).size).toBe(facts.length);
  expect(currentClauseKey({ facet: 'statement', property: 'item:year', range: { gte: 1900, lte: 2000 } })).toBe(
    currentClauseKey({ facet: 'statement', property: 'item:year', range: { lte: 2000, gte: 1900 } }),
  );
});

test('compiling, keying and evaluating never mutate frozen inputs or aligned results', () => {
  const values = Object.freeze(['person:bob', 'person:alice', 'person:bob']);
  const qualifiers = Object.freeze([Object.freeze({ property: 'item:role', in: values })]);
  const statement = Object.freeze({ property: 'item:author', in: values, qualifiers });
  const filter = Object.freeze({ and: Object.freeze([Object.freeze({ statement }), Object.freeze({ not: a })]) });
  const clause: FactClause = Object.freeze({ facet: 'statement', property: statement.property, values, qualifiers });
  const before = structuredClone({ filter, clause });
  const plan = compileCurrentFilter(filter);
  currentClauseKey(clause);
  const results = Object.freeze(['not_proven', false] as const);
  expect(plan.evaluate(results)).toBe('not_proven');
  expect(anyCurrentMatch(results)).toBe('not_proven');
  expect({ filter, clause }).toEqual(before);
  expect(results).toEqual(['not_proven', false]);
});

test('saved nodes reject at the root and inside Boolean expressions', () => {
  expect(() => compileCurrentFilter({ saved: 'filter:unexpanded' })).toThrow('admitted, expanded');
  expect(() => compileCurrentFilter({ or: [a, { not: { saved: 'filter:unexpanded' } }] })).toThrow(
    'admitted, expanded',
  );
});

test('evaluation rejects wrong lengths and invalid runtime results before Boolean shortcuts', () => {
  const expressions: FilterDocument[] = [a, { not: a }, { and: [a, b] }, { or: [a, b] }];
  for (const filter of expressions) {
    const plan = compileCurrentFilter(filter);
    for (const length of [0, plan.leaves.length - 1, plan.leaves.length + 1]) {
      expect(() => plan.evaluate(Array.from({ length }, () => true))).toThrow();
    }
    for (const invalid of [undefined, null, 'unknown', 'true', 'false', 0, 1, {}, []]) {
      for (let index = 0; index < plan.leaves.length; index++) {
        for (const valid of [true, false] as const) {
          const malformed: unknown[] = Array.from({ length: plan.leaves.length }, () => valid);
          malformed[index] = invalid;
          expect(() => plan.evaluate(malformed as readonly RelationFacetMatch[])).toThrow();
        }
      }
    }
    const sparse: RelationFacetMatch[] = new Array(plan.leaves.length);
    expect(() => plan.evaluate(sparse)).toThrow();
    for (const malformed of [null, undefined, {}, 'true']) {
      expect(() => plan.evaluate(malformed as unknown as readonly RelationFacetMatch[])).toThrow();
    }
  }
});
