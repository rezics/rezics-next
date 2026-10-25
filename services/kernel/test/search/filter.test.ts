import { expect, test } from 'bun:test';
import { compileFilter, FILTER_LIMITS, FilterError, parseFilter, positiveFilter } from '../../src/search/filter.ts';

const author = '018f0000-0000-7000-8000-00a000000009';
const leaf = { type: { in: ['schema:Book'] } };

function rejects(
  input: unknown,
  problem: 'invalid_request' | 'unsupported_query',
  errors: { pointer: string; code: string }[],
) {
  let error: unknown;
  try {
    parseFilter(input);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(FilterError);
  expect(error).toMatchObject({ problem, errors });
}

test('facet leaves and bounded boolean nodes parse into a closed document', () => {
  const input = {
    and: [
      { type: { in: ['schema:Book'] } },
      {
        or: [{ statement: { property: 'schema:author', in: [author] } }, { not: { type: { in: ['schema:Person'] } } }],
      },
    ],
  };
  expect(parseFilter(input)).toEqual(input);
  expect(parseFilter(input)).not.toBe(input);
});

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

test('structural errors are field errors at their JSON pointer', () => {
  rejects({ colour: { in: ['red'] } }, 'invalid_request', [{ pointer: '/colour', code: 'unknown_field' }]);
  rejects({ and: [{ type: { in: ['schema:Book'], eq: 'x' } }] }, 'invalid_request', [
    { pointer: '/and/0/type/eq', code: 'unknown_field' },
  ]);
  rejects({ type: { in: 'schema:Book' } }, 'invalid_request', [{ pointer: '/type/in', code: 'invalid_type' }]);
  rejects({ type: {} }, 'invalid_request', [{ pointer: '/type/in', code: 'required' }]);
  rejects({ statement: { in: [author] } }, 'invalid_request', [{ pointer: '/statement/property', code: 'required' }]);
  rejects({ statement: { property: 'author', in: [author] } }, 'invalid_request', [
    { pointer: '/statement/property', code: 'invalid_format' },
  ]);
  rejects({ type: { in: ['schema:Book'] }, not: leaf }, 'invalid_request', [{ pointer: '', code: 'unsupported' }]);
  rejects({}, 'invalid_request', [{ pointer: '', code: 'unsupported' }]);
  rejects([], 'invalid_request', [{ pointer: '', code: 'invalid_type' }]);
  rejects(null, 'invalid_request', [{ pointer: '', code: 'invalid_type' }]);
  rejects({ and: [] }, 'invalid_request', [{ pointer: '/and', code: 'out_of_range' }]);
  rejects({ type: { in: [] } }, 'invalid_request', [{ pointer: '/type/in', code: 'out_of_range' }]);
  rejects({ type: { in: [''] } }, 'invalid_request', [{ pointer: '/type/in/0', code: 'invalid_format' }]);
  rejects({ statement: { property: 'schema:name', in: ['a\u0000b'] } }, 'invalid_request', [
    { pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  rejects({ statement: { property: 'schema:name', in: ['x'.repeat(257)] } }, 'invalid_request', [
    { pointer: '/statement/in/0', code: 'invalid_format' },
  ]);
  rejects({ __proto__: leaf } as unknown, 'invalid_request', [{ pointer: '', code: 'unsupported' }]);
});

test('admission limits are typed refusals', () => {
  expect(FILTER_LIMITS).toEqual({ leaves: 32, depth: 4, or: 16, in: 64 });
  const pairs = Array.from({ length: 16 }, () => ({ or: [leaf, leaf] }));
  expect(() => parseFilter({ and: pairs })).not.toThrow();
  rejects({ and: [...pairs, leaf] }, 'unsupported_query', [{ pointer: '', code: 'out_of_range' }]);
  rejects({ or: Array.from({ length: 17 }, () => leaf) }, 'unsupported_query', [
    { pointer: '/or', code: 'out_of_range' },
  ]);
  const many = Array.from({ length: 65 }, (_, index) => `schema:T${index}`);
  rejects({ type: { in: many } }, 'unsupported_query', [{ pointer: '/type/in', code: 'out_of_range' }]);
  expect(() => parseFilter({ and: [{ or: [{ and: [{ not: leaf }, leaf] }, leaf] }] })).not.toThrow();
  rejects({ and: [{ or: [{ and: [{ or: [{ not: leaf }, leaf] }] }, leaf] }] }, 'unsupported_query', [
    { pointer: '/and/0/or/0/and/0/or/0', code: 'out_of_range' },
  ]);
  rejects({ not: { not: leaf } }, 'unsupported_query', [{ pointer: '/not', code: 'unsupported' }]);
});

test('a filter is positive only when every OR branch has a positive leaf outside negation', () => {
  expect(positiveFilter(parseFilter(leaf))).toBe(true);
  expect(positiveFilter(parseFilter({ not: leaf }))).toBe(false);
  expect(positiveFilter(parseFilter({ and: [{ not: leaf }, leaf] }))).toBe(true);
  expect(positiveFilter(parseFilter({ or: [{ not: leaf }, leaf] }))).toBe(false);
  expect(positiveFilter(parseFilter({ or: [leaf, { and: [leaf, { not: leaf }] }] }))).toBe(true);
});
