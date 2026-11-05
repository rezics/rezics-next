import { expect, test } from 'bun:test';
import { compileFilter } from '../../src/search/filter.ts';
import {
  compileCurrentFilter,
  currentConceptStatementsMatch,
  currentClauseKey,
} from '../../src/search/current-filter-plan.ts';

const scheme = '018f0000-0000-7000-8000-00a000000010';
const concept = '018f0000-0000-7000-8000-00a000000011';

test('concept candidates are broadened to the property and excluded concepts retain every candidate', () => {
  const compiled = compileFilter(
    {
      statement: {
        property: 'schema:genre',
        in: ['018f0000-0000-7000-8000-00a000000011'],
        concept: { scheme: '018f0000-0000-7000-8000-00a000000010', includeChildren: true },
      },
    },
    { prefix: 'f', relationOverflow: true },
  );
  expect(compiled.leaves[0]).toMatchObject({
    facet: 'statement',
    property: 'schema:genre',
    values: ['018f0000-0000-7000-8000-00a000000011'],
    concept: { scheme: '018f0000-0000-7000-8000-00a000000010', includeChildren: true },
  });
  expect(compiled.query).toEqual({
    bool: {
      should: [
        {
          nested: {
            path: 'facts',
            query: { term: { 'facts.property': 'schema:genre' } },
            score_mode: 'none',
            _name: 'f0',
          },
        },
        { term: { relation_facet_overflow: 'schema:genre' } },
      ],
      minimum_should_match: 1,
      _name: 'f0',
    },
  });
  expect(
    compileFilter(
      {
        not: {
          statement: {
            property: 'schema:genre',
            in: ['018f0000-0000-7000-8000-00a000000011'],
            concept: { scheme: '018f0000-0000-7000-8000-00a000000010', includeChildren: true },
          },
        },
      },
      { prefix: 'f', relationOverflow: true },
    ).query,
  ).toEqual({ match_all: { _name: 'f0' } });
});

test('current leaves retain scheme and descendant selection and keep unknown under exclusion', () => {
  const exact = compileCurrentFilter({
    statement: { property: 'schema:genre', in: [concept], concept: { scheme } },
  });
  const descendants = compileCurrentFilter({
    not: { statement: { property: 'schema:genre', in: [concept], concept: { scheme, includeChildren: true } } },
  });
  expect(exact.leaves[0]).toMatchObject({ concept: { scheme }, values: [concept] });
  expect(currentClauseKey(exact.leaves[0]!)).not.toBe(currentClauseKey(descendants.leaves[0]!));
  expect(descendants.evaluate(['not_proven'])).toBe('not_proven');
});

test('concept membership and qualifier witnesses combine per statement and preserve incomplete evidence', () => {
  expect(currentConceptStatementsMatch([{ membership: true, witness: true }], true)).toBe(true);
  expect(currentConceptStatementsMatch([{ membership: true, witness: false }], true)).toBe(false);
  expect(currentConceptStatementsMatch([{ membership: true, witness: 'not_proven' }], true)).toBe('not_proven');
  expect(currentConceptStatementsMatch([{ membership: false, witness: true }], false)).toBe('not_proven');
  expect(currentConceptStatementsMatch([{ membership: true, witness: true }], false)).toBe(true);
});
