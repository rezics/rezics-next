import {
  FilterError,
  FILTER_LIMITS,
  parseFilter,
  type FilterDocument,
  type FilterRange,
} from '@rezics/filter';
import { isWithinGlobalSearchQueryLimit } from '../query-text-limit';
import { canonicalRealmRatingPopulationId, RATING_POPULATION_FIELD } from '../rating-population';
import {
  parseSearchResourceScope,
  type SearchResourceScope,
} from '../advanced-scope';
import { canonicalResourceLanguageValues, RESOURCE_LANGUAGE_PROPERTY } from '../language-refinement';
import type { SearchLoaderDeps, SearchFacetValues } from '../search-params';

export const SEARCH_VISIT_ADDRESS_CHARACTER_LIMIT = 131_072;
const SEARCH_STRUCTURED_VALUE_BYTE_LIMIT = 16_384;
const languageTag = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;

export type SearchInputIssueReason =
  | 'invalid-shape'
  | 'repeated-scalar'
  | 'too-many'
  | 'invalid-query'
  | 'invalid-type'
  | 'invalid-language'
  | 'invalid-order'
  | 'invalid-cursor'
  | 'invalid-condition'
  | 'invalid-filter'
  | 'invalid-range'
  | 'invalid-facet'
  | 'invalid-population';

export type SearchInputIssue = {
  key: string;
  value: string;
  reason: SearchInputIssueReason;
  occurrence?: number;
  maximum?: number;
  removal: 'field' | 'occurrence' | 'structured' | 'cursor';
};

export type SearchUrlIntake =
  | { kind: 'ready'; request: SearchLoaderDeps; fingerprint: string }
  | { kind: 'invalid'; issues: SearchInputIssue[]; fingerprint: string }
  | { kind: 'over-budget'; fingerprint: 'over-budget' };

type AuthoredValue = { value: unknown; repeated: boolean };

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? String(value);
}

function knownSearchKey(key: string): boolean {
  return (
    key === 'q' ||
    key === 'type' ||
    key === 'cursor' ||
    key === 'kinds' ||
    key === 'language' ||
    key === 'condition' ||
    key === 'filter' ||
    key === 'sort' ||
    key === RATING_POPULATION_FIELD ||
    key.startsWith('f.') ||
    key.startsWith('r.')
  );
}

function estimatedAddressLength(search: Record<string, unknown>): number {
  let total = 0;
  for (const [key, value] of Object.entries(search)) {
    total += key.length + 2;
    if (typeof value === 'string') total += value.length;
    else if (Array.isArray(value)) {
      for (const item of value) total += textValue(item).length + 1;
    } else if (value !== undefined) total += textValue(value).length;
    if (total > SEARCH_VISIT_ADDRESS_CHARACTER_LIMIT) return total;
  }
  return total;
}

function authoredValue(
  search: Record<string, unknown>,
  key: string,
  rawParams: URLSearchParams | undefined,
  list: boolean,
): AuthoredValue {
  const parsed = search[key];
  if (!rawParams) return { value: parsed, repeated: Array.isArray(parsed) };

  const submitted = rawParams.getAll(key);
  if (!submitted.length) return { value: parsed, repeated: Array.isArray(parsed) };
  if (submitted.length > 1) return { value: submitted, repeated: true };
  if (Array.isArray(parsed)) return { value: list ? parsed : submitted[0], repeated: false };
  return { value: submitted[0], repeated: false };
}

function addIssue(
  issues: SearchInputIssue[],
  key: string,
  value: unknown,
  reason: SearchInputIssueReason,
  options: { occurrence?: number; maximum?: number; removal?: SearchInputIssue['removal'] } = {},
) {
  issues.push({
    key,
    value: textValue(value),
    reason,
    ...(options.occurrence === undefined ? {} : { occurrence: options.occurrence }),
    ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
    removal:
      options.removal ??
      (options.occurrence === undefined
        ? key === 'condition' || key === 'filter' || key.startsWith('r.')
          ? 'structured'
          : 'field'
        : 'occurrence'),
  });
}

function scalarValue(
  issues: SearchInputIssue[],
  key: string,
  input: AuthoredValue,
  valid: (value: string) => boolean,
  reason: SearchInputIssueReason,
  removal: SearchInputIssue['removal'] = 'field',
): string | undefined {
  const value = input.value;
  if (Array.isArray(value)) {
    if (removal === 'cursor') {
      addIssue(issues, key, value, 'invalid-cursor', { removal: 'cursor' });
    } else if (input.repeated && value.length) {
      value.forEach((item, occurrence) =>
        addIssue(issues, key, item, 'repeated-scalar', { occurrence, removal: 'occurrence' }),
      );
    } else addIssue(issues, key, value, 'invalid-shape', { removal });
    return undefined;
  }
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !valid(value)) {
    addIssue(issues, key, value, reason, { removal });
    return undefined;
  }
  return value;
}

function listValues(
  issues: SearchInputIssue[],
  key: string,
  input: AuthoredValue,
  maximum: number,
  valid: (value: string) => boolean,
  reason: SearchInputIssueReason,
): string[] | undefined {
  const value = input.value;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' && !Array.isArray(value)) {
    addIssue(issues, key, value, 'invalid-shape');
    return undefined;
  }
  const values = typeof value === 'string' ? [value] : value;
  if (values.length > maximum)
    values.forEach((item, occurrence) => {
      if (occurrence >= maximum)
        addIssue(issues, key, item, 'too-many', { occurrence, maximum, removal: 'occurrence' });
    });
  values.forEach((item, occurrence) => {
    if (typeof item !== 'string')
      addIssue(issues, key, item, 'invalid-shape', {
        ...(Array.isArray(value) ? { occurrence } : {}),
      });
    else if (!valid(item))
      addIssue(issues, key, item, reason, {
        ...(Array.isArray(value) ? { occurrence } : {}),
      });
  });
  return values.every((item) => typeof item === 'string') ? (values as string[]) : undefined;
}

function parseStructured(
  issues: SearchInputIssue[],
  key: string,
  value: string,
  reason: SearchInputIssueReason,
): FilterDocument | undefined {
  if (new TextEncoder().encode(value).byteLength > SEARCH_STRUCTURED_VALUE_BYTE_LIMIT) {
    addIssue(issues, key, value, 'too-many', { maximum: SEARCH_STRUCTURED_VALUE_BYTE_LIMIT, removal: 'structured' });
    return undefined;
  }
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      addIssue(issues, key, value, reason, { removal: 'structured' });
      return undefined;
    }
    throw error;
  }
  try {
    return parseFilter(document);
  } catch (error) {
    if (error instanceof FilterError) {
      addIssue(issues, key, value, reason, { removal: 'structured' });
      return undefined;
    }
    throw error;
  }
}

function parseCondition(
  issues: SearchInputIssue[],
  input: AuthoredValue,
): FilterDocument | undefined {
  const value = scalarValue(issues, 'condition', input, (text) => text.length <= 16_384, 'invalid-condition', 'structured');
  return value === undefined ? undefined : parseStructured(issues, 'condition', value, 'invalid-condition');
}

function parseFilterInput(
  issues: SearchInputIssue[],
  input: AuthoredValue,
): { value?: string; scope?: SearchResourceScope } {
  const value = scalarValue(issues, 'filter', input, (text) => new TextEncoder().encode(text).byteLength <= SEARCH_STRUCTURED_VALUE_BYTE_LIMIT, 'invalid-filter', 'structured');
  if (value === undefined || value === '') return { ...(value === '' ? { value } : {}) };
  if (!parseStructured(issues, 'filter', value, 'invalid-filter')) return {};
  const scope = parseSearchResourceScope(value);
  if (scope.invalidInput) {
    addIssue(issues, 'filter', value, 'invalid-filter', { removal: 'structured' });
    return {};
  }
  return { value, ...(scope.scope ? { scope: scope.scope } : {}) };
}

function parseRanges(
  issues: SearchInputIssue[],
  search: Record<string, unknown>,
  rawParams: URLSearchParams | undefined,
): Record<string, FilterRange> {
  const ranges: Record<string, FilterRange> = Object.create(null);
  for (const key of Object.keys(search).filter((candidate) => candidate.startsWith('r.'))) {
    const property = key.slice(2);
    const input = authoredValue(search, key, rawParams, false);
    const value = scalarValue(issues, key, input, () => true, 'invalid-range', 'structured');
    if (value === undefined) continue;
    let parsed: FilterDocument | undefined;
    try {
      const range = JSON.parse(value);
      parsed = parseFilter({ statement: { property, range } });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof FilterError) {
        addIssue(issues, key, value, 'invalid-range', { removal: 'structured' });
        continue;
      }
      throw error;
    }
    if (parsed && 'statement' in parsed && 'range' in parsed.statement) ranges[property] = parsed.statement.range;
    else addIssue(issues, key, value, 'invalid-range', { removal: 'structured' });
  }
  return ranges;
}

export function searchInputFingerprint(search: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(search)
      .filter(knownSearchKey)
      .sort()
      .map((key) => [key, search[key]]),
  );
}

export function searchUrlIntake(
  search: Record<string, unknown>,
  searchString?: string,
  visitAddress?: string,
): SearchUrlIntake {
  const suppliedLength = visitAddress?.length ?? searchString?.length ?? estimatedAddressLength(search);
  if (suppliedLength > SEARCH_VISIT_ADDRESS_CHARACTER_LIMIT)
    return { kind: 'over-budget', fingerprint: 'over-budget' };

  const rawParams = searchString === undefined ? undefined : new URLSearchParams(searchString);
  const issues: SearchInputIssue[] = [];
  const q = scalarValue(
    issues,
    'q',
    authoredValue(search, 'q', rawParams, false),
    isWithinGlobalSearchQueryLimit,
    'invalid-query',
  ) ?? '';
  const type = scalarValue(
    issues,
    'type',
    authoredValue(search, 'type', rawParams, false),
    (value) => value.length <= 128,
    'invalid-type',
  );
  const cursor = scalarValue(
    issues,
    'cursor',
    authoredValue(search, 'cursor', rawParams, false),
    (value) => value.length <= 4864,
    'invalid-cursor',
    'cursor',
  );
  const rawSort = scalarValue(
    issues,
    'sort',
    authoredValue(search, 'sort', rawParams, false),
    (value) => value === '' || value === 'rating',
    'invalid-order',
  );
  const kinds = listValues(
    issues,
    'kinds',
    authoredValue(search, 'kinds', rawParams, true),
    FILTER_LIMITS.in,
    () => true,
    'invalid-shape',
  );
  const languages = listValues(
    issues,
    'language',
    authoredValue(search, 'language', rawParams, true),
    8,
    (value) => value.length <= 35 && languageTag.test(value),
    'invalid-language',
  );
  const conditionInput = authoredValue(search, 'condition', rawParams, false);
  const condition = parseCondition(issues, conditionInput);
  const filterInput = authoredValue(search, 'filter', rawParams, false);
  const filter = parseFilterInput(issues, filterInput);
  const ranges = parseRanges(issues, search, rawParams);

  const facetKeys = Object.keys(search).filter((key) => key.startsWith('f.'));
  let facets: SearchFacetValues = Object.create(null);
  facetKeys.forEach((key, index) => {
    const property = key.slice(2);
    const input = authoredValue(search, key, rawParams, true);
    const values = listValues(issues, key, input, FILTER_LIMITS.in, () => true, 'invalid-facet');
    if (!property) addIssue(issues, key, input.value, 'invalid-facet');
    if (index >= FILTER_LIMITS.leaves)
      addIssue(issues, key, input.value, 'too-many', { maximum: FILTER_LIMITS.leaves });
    if (property && values)
      facets[property] =
        property === RESOURCE_LANGUAGE_PROPERTY ? canonicalResourceLanguageValues(values) : values;
  });

  const rawPopulation = authoredValue(search, RATING_POPULATION_FIELD, rawParams, false);
  const populationValue = scalarValue(
    issues,
    RATING_POPULATION_FIELD,
    rawPopulation,
    (value) => value === '' || canonicalRealmRatingPopulationId(value) !== undefined,
    'invalid-population',
  );
  const ratingPopulation =
    populationValue === undefined || populationValue === ''
      ? undefined
      : canonicalRealmRatingPopulationId(populationValue);
  const fingerprint = JSON.stringify(
    Object.keys(search)
      .filter(knownSearchKey)
      .sort()
      .map((key) => [key, rawParams ? rawParams.getAll(key) : search[key]]),
  );

  if (issues.length) return { kind: 'invalid', issues, fingerprint };
  const rangesReady = ranges;
  const request: SearchLoaderDeps = {
    query: q,
    type,
    facets,
    ranges: rangesReady,
    ...(condition ? { condition } : {}),
    cursor,
    sort: rawSort === '' ? undefined : (rawSort as 'rating' | undefined),
    ...(kinds ? { kinds } : {}),
    ...(languages ? { languages } : {}),
    ...(filter.value !== undefined ? { filter: filter.value } : {}),
    ...(filter.scope ? { resourceScope: filter.scope } : {}),
    ...(ratingPopulation ? { ratingPopulation } : {}),
  };
  return { kind: 'ready', request, fingerprint };
}

export function searchInputDependency(search: Record<string, unknown>): string {
  return searchUrlIntake(search).fingerprint;
}

export function searchLoaderDepsFromIntake(intake: SearchUrlIntake): SearchLoaderDeps {
  if (intake.kind === 'ready') return intake.request;
  const first = intake.kind === 'invalid' ? intake.issues[0] : undefined;
  return {
    query: '',
    type: undefined,
    facets: {},
    cursor: undefined,
    sort: undefined,
    ...(first ? { invalidInput: { key: first.key, value: first.value } } : {}),
  };
}

export function facetValuesFromSearch(search: Record<string, unknown>): SearchFacetValues {
  const intake = searchUrlIntake(search);
  return intake.kind === 'ready' ? intake.request.facets : {};
}

export function rangeValuesFromSearch(search: Record<string, unknown>): Record<string, FilterRange> {
  const intake = searchUrlIntake(search);
  return intake.kind === 'ready' ? intake.request.ranges ?? {} : {};
}
