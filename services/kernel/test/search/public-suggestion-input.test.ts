import { expect, test } from 'bun:test';
import { compilePublicSuggestion, validatePublicSuggestionInput } from '../../src/search/public-suggestion-input.ts';
import type { PublicSuggestionCaptureInput } from '../../src/search/public-filter-consumer-contract.ts';

const input = (prefix: string, size = 20): PublicSuggestionCaptureInput => ({
  purpose: 'suggest',
  prefix,
  size,
  filterDocument: undefined,
  text: undefined,
});

test('prefix capture keeps search_as_you_type semantics for partial tokens and literal punctuation', () => {
  for (const prefix of ['encyclop', 'two wor', 'a OR b*', '中文', '😀'.repeat(64)]) {
    expect(compilePublicSuggestion(input(prefix))).toEqual({
      multi_match: {
        query: prefix,
        type: 'bool_prefix',
        fields: ['names.typeahead', 'names.typeahead._2gram', 'names.typeahead._3gram'],
      },
    });
  }
  expect(() => validatePublicSuggestionInput(input('x', 1))).not.toThrow();
  expect(() => validatePublicSuggestionInput(input('x', 50))).not.toThrow();
});

test('prefix capture rejects caller DSL, text coercion, continuation and out-of-bound work', () => {
  for (const prefix of ['', 'x'.repeat(65), '😀'.repeat(65)])
    expect(() => validatePublicSuggestionInput(input(prefix))).toThrow();
  for (const size of [0, 51, 1.5, NaN, Infinity])
    expect(() => validatePublicSuggestionInput(input('x', size))).toThrow();
  // Additional properties reject even when passed by a structurally compatible caller.
  for (const extra of [{ query: { match_all: {} } }, { after: ['x'] }, { sort: 'name' }])
    expect(() => validatePublicSuggestionInput({ ...input('x'), ...extra })).toThrow();
});
