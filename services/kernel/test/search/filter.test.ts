import { expect, test } from 'bun:test';
import { parseFilter } from '@rezics/filter';
import { compileFilter } from '../../src/search/filter.ts';

const author = '018f0000-0000-7000-8000-00a000000009';
const leaf = { type: { in: ['schema:Book'] } };

test('compiles to named filter clauses with lineage', () => {
  const compiled = compileFilter(
    parseFilter({
      and: [
        { type: { in: ['schema:Book', 'schema:Recipe'] } },
        { not: { statement: { property: 'schema:author', in: [author] } } },
      ],
    }),
    { prefix: 'f' },
  );
  expect(compiled.query).toEqual({
    bool: {
      filter: [{ terms: { type: ['schema:Book', 'schema:Recipe'], _name: 'f0' } }],
      must_not: [{ terms: { statements: [`schema:author=${author}`], _name: 'f1' } }],
    },
  });
  expect(compiled.leaves).toEqual([
    { name: 'f0', facet: 'type', values: ['schema:Book', 'schema:Recipe'], negated: false },
    { name: 'f1', facet: 'statement', property: 'schema:author', values: [author], negated: true },
  ]);
  const either = compileFilter(parseFilter({ or: [leaf, { type: { in: ['schema:Person'] } }] }), { prefix: 'f' });
  expect(either.query).toEqual({
    bool: {
      should: [{ terms: { type: ['schema:Book'], _name: 'f0' } }, { terms: { type: ['schema:Person'], _name: 'f1' } }],
      minimum_should_match: 1,
    },
  });
  expect(compileFilter(parseFilter(leaf), { prefix: 'g' }).query).toEqual({
    terms: { type: ['schema:Book'], _name: 'g0' },
  });
  expect(compileFilter(parseFilter({ not: leaf }), { prefix: 'f' }).query).toEqual({
    bool: { must_not: [{ terms: { type: ['schema:Book'], _name: 'f0' } }] },
  });
});
