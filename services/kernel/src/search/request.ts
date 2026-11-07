import { FilterError, parseDiscoveryFilter, parseFilter } from '@rezics/filter';
import { SEARCH_GLOBAL_CONTEXT as GLOBAL_CONTEXT } from './global-context.ts';
import { ProblemError, type FieldErrorCode } from '../http/problem-error.ts';
import { routeOf } from '../route/route.ts';
import { validateHitOptions, validateSearchLimit, type HitOptions } from './hits.ts';
import { parseText, textSyntaxProblem, TextSyntaxError } from './text.ts';
import type { AdmittedSearchRequest, SearchFilterDocument, SearchRequest } from './service-contract.ts';

export function invalid(pointer: string, code: FieldErrorCode): never {
  throw new ProblemError('invalid_request', { errors: [{ pointer, code }] });
}

export function unsupported(pointer: string, code: FieldErrorCode = 'unsupported'): never {
  throw new ProblemError('unsupported_query', { errors: [{ pointer, code }] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function containsRealmPredicate(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.hasOwn(value, 'realm')) return true;
  if ('not' in value && containsRealmPredicate(value.not)) return true;
  return ['and', 'or'].some((key) => Array.isArray(value[key]) && value[key].some(containsRealmPredicate));
}

/** Parse and admit the caller's Search JSON once, before it reaches execution or cursor planning. */
export function admitSearchRequest(request: SearchRequest): AdmittedSearchRequest {
  let text: ReturnType<typeof parseText> | undefined;
  try {
    if (request.text !== undefined) {
      if (typeof request.text !== 'string') invalid('/text', 'invalid_type');
      text = parseText(request.text);
    }
  } catch (error) {
    if (error instanceof TextSyntaxError) throw new ProblemError('unsupported_query', textSyntaxProblem(error));
    throw error;
  }

  let filter: SearchFilterDocument | undefined;
  try {
    if (request.filter !== undefined) {
      const discovery = parseDiscoveryFilter(request.filter);
      filter = containsRealmPredicate(discovery) ? discovery : parseFilter(request.filter);
    }
  } catch (error) {
    if (error instanceof FilterError)
      throw new ProblemError(error.problem, {
        errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
      });
    throw error;
  }

  const realmFilter = filter !== undefined && containsRealmPredicate(filter);
  const sort = request.sort === undefined ? (realmFilter ? 'name' : text ? 'relevance' : 'name') : request.sort;
  if (sort !== 'relevance' && sort !== 'name' && sort !== 'id' && sort !== 'collections' && sort !== 'rating')
    invalid('/sort', 'invalid_format');
  if (sort === 'relevance' && !text) unsupported('/sort');
  let spoilerThreshold: AdmittedSearchRequest['spoilerThreshold'];
  if (request.spoilerThreshold !== undefined) {
    const value = request.spoilerThreshold;
    if (!Number.isSafeInteger(value) || value < 0 || value > 2) invalid('/spoilerThreshold', 'invalid_format');
    spoilerThreshold = value as NonNullable<typeof spoilerThreshold>;
  }
  if (spoilerThreshold !== undefined && !filter) unsupported('/spoilerThreshold');
  if (realmFilter && sort !== 'name') unsupported('/sort');
  if (request.population !== undefined) {
    const population = request.population;
    if (
      !population ||
      typeof population !== 'object' ||
      Array.isArray(population) ||
      Object.keys(population).length !== 1 ||
      typeof population.realm !== 'string' ||
      routeOf(population.realm) === null ||
      population.realm === GLOBAL_CONTEXT.id
    )
      invalid('/population', 'invalid_format');
    if (sort !== 'rating') unsupported('/population');
  }
  const limit = validateSearchLimit(request.limit);
  const hitOptions: HitOptions = validateHitOptions(request);

  return {
    ...(text === undefined ? {} : { text }),
    ...(filter === undefined ? {} : { filter }),
    sort,
    ...(spoilerThreshold === undefined ? {} : { spoilerThreshold }),
    limit,
    hitOptions,
    // Keep the validated JSON, rather than the compiler's internal representation, in the binding.
    bindingRequest: {
      ...(text ? { text: request.text } : {}),
      ...(filter ? { filter } : {}),
      sort,
      ...(spoilerThreshold !== undefined ? { spoilerThreshold } : {}),
      ...(request.population ? { population: request.population } : {}),
      limit,
      ...(hitOptions.descriptions ? { descriptions: true } : {}),
      ...(hitOptions.languages ? { languages: hitOptions.languages } : {}),
      ...(hitOptions.properties ? { properties: hitOptions.properties } : {}),
    },
  };
}

/** Classify the same bounded parser trees used by execution; never infer syntax from raw text. */
export function requiresAdvancedSearch(request: SearchRequest): boolean {
  const { text, filter, sort } = admitSearchRequest(request);
  const basicText = (node: NonNullable<typeof text>): boolean =>
    node.kind === 'term' ||
    node.kind === 'phrase' ||
    ((node.kind === 'and' || node.kind === 'or') && node.children.every(basicText));
  const basicFilter = (node: NonNullable<typeof filter>): boolean =>
    'type' in node || ('and' in node && node.and.every(basicFilter)) || ('or' in node && node.or.every(basicFilter));
  return (
    sort === 'rating' ||
    sort === 'collections' ||
    (text !== undefined && !basicText(text)) ||
    (filter !== undefined && !basicFilter(filter))
  );
}

export type SearchRequestPlanner = Readonly<{
  admit: typeof admitSearchRequest;
  requiresAdvanced: typeof requiresAdvancedSearch;
}>;

export function createSearchRequestPlanner(): SearchRequestPlanner {
  return Object.freeze({ admit: admitSearchRequest, requiresAdvanced: requiresAdvancedSearch });
}
