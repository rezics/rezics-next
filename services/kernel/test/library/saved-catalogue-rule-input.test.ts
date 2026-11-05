import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import { parseCollectionRule } from '../../src/library/collection-rules.ts';

const filter = { type: { in: ['schema:Book'] } };

function refusal(input: unknown): ProblemError {
  try {
    parseCollectionRule(input);
  } catch (error) {
    if (error instanceof ProblemError) return error;
    throw error;
  }
  throw new Error('a closed rule input was accepted');
}

test('an omitted source is the owner compatibility source, and an explicit catalogue source is retained', () => {
  expect(parseCollectionRule({ filter })).toMatchObject({ sort: 'id', source: { kind: 'owner' } });
  expect(parseCollectionRule({ filter, sort: 'id', source: { kind: 'catalogue' } })).toMatchObject({
    sort: 'id',
    source: { kind: 'catalogue' },
  });
});

test('the rule input is closed: source is exactly one owner or catalogue object, and no other field is accepted', () => {
  for (const source of ['catalogue', { kind: 'public' }, { kind: 'catalogue', scope: 'all' }, null]) {
    expect(refusal({ filter, source })).toMatchObject({ code: 'invalid_request' });
  }
  expect(refusal({ filter, publication: 'public' })).toMatchObject({ code: 'invalid_request' });
  expect(refusal({ sort: 'id' })).toMatchObject({ code: 'invalid_request' });
  expect(refusal({ filter, sort: 'name' })).toMatchObject({ code: 'unsupported_query' });
});
