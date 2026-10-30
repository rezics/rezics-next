import type { PublicSuggestionCaptureInput } from './public-filter-consumer-contract.ts';

/** Match existing public suggestion bounds, with the native candidate bound of 1..50. */
export function validatePublicSuggestionInput(input: PublicSuggestionCaptureInput): void {
  const keys = new Set(['purpose', 'prefix', 'size', 'generation', 'filterDocument', 'text']);
  if (
    Object.keys(input).some((key) => !keys.has(key)) ||
    input.purpose !== 'suggest' ||
    typeof input.prefix !== 'string' ||
    input.prefix.length > 128 ||
    [...input.prefix].length < 1 ||
    [...input.prefix].length > 64 ||
    !Number.isInteger(input.size) ||
    input.size < 1 ||
    input.size > 50 ||
    !Object.hasOwn(input, 'filterDocument') ||
    input.filterDocument !== undefined ||
    !Object.hasOwn(input, 'text') ||
    input.text !== undefined ||
    (input.generation !== undefined && (!Number.isSafeInteger(input.generation) || input.generation < 1))
  )
    throw new TypeError('Invalid canonical public suggestion input');
}

/** The existing search_as_you_type prefix semantics, with no user-selected fields or DSL. */
export function compilePublicSuggestion(input: PublicSuggestionCaptureInput) {
  validatePublicSuggestionInput(input);
  return {
    multi_match: {
      query: input.prefix,
      type: 'bool_prefix',
      fields: ['names.typeahead', 'names.typeahead._2gram', 'names.typeahead._3gram'],
    },
  };
}
