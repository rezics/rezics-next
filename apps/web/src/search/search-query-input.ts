import { parseFilter } from '@rezics/filter';
import { isSearchResourceScope, parseSearchResourceScope, searchFilterWithScope } from './advanced-scope';
import { canonicalRealmRatingPopulationId, RATING_POPULATION_FIELD } from './rating-population';
import { searchUrlIntake } from './search-params';
import type { SearchRequestParams } from './search-query-contract';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate the server-function boundary once before the application receives a typed request. */
export function validateSearchInput(input: unknown): SearchRequestParams {
  if (
    !isRecord(input) ||
    typeof input.query !== 'string' ||
    typeof input.locale !== 'string' ||
    !input.locale ||
    input.locale.length > 35
  )
    throw new Error('Invalid search');
  if (input.facetValues !== undefined && !isRecord(input.facetValues)) throw new Error('Invalid facets');
  const urlInput: Record<string, unknown> = {
    q: input.query,
    type: input.type,
    cursor: input.cursor,
    sort: input.sort,
    kinds: input.kinds,
    language: input.languages,
    filter: input.filter,
    [RATING_POPULATION_FIELD]: input.ratingPopulation,
  };
  if (isRecord(input.facetValues)) {
    for (const [property, values] of Object.entries(input.facetValues)) urlInput[`f.${property}`] = values;
  }
  const intake = searchUrlIntake(urlInput);
  if (intake.kind !== 'ready') throw new Error('Invalid search');
  const parsed = {
    q: intake.request.query,
    type: intake.request.type,
    cursor: intake.request.cursor,
    sort: intake.request.sort,
    kinds: intake.request.kinds,
    language: intake.request.languages,
    filter: intake.request.filter,
  };
  if (input.resourceScope !== undefined && !isSearchResourceScope(input.resourceScope))
    throw new Error('Invalid search resource scope');
  if (input.reader !== undefined && (typeof input.reader !== 'string' || input.reader.length > 256))
    throw new Error('Invalid search reader');
  if (parsed.filter !== undefined && typeof parsed.filter !== 'string') throw new Error('Invalid search filter');
  const ratingPopulation =
    input.ratingPopulation === undefined || input.ratingPopulation === ''
      ? undefined
      : canonicalRealmRatingPopulationId(input.ratingPopulation);
  if (input.ratingPopulation !== undefined && input.ratingPopulation !== '' && !ratingPopulation)
    throw new Error('Invalid Search rating population');
  const filterScope = typeof parsed.filter === 'string' ? parseSearchResourceScope(parsed.filter) : {};
  if (filterScope.invalidInput) throw new Error('Invalid search resource scope');
  if (
    isSearchResourceScope(input.resourceScope) &&
    filterScope.scope &&
    (input.resourceScope.kind !== filterScope.scope.kind ||
      input.resourceScope.id.toLowerCase() !== filterScope.scope.id)
  )
    throw new Error('Search resource scope does not match its filter');
  const resourceScope = isSearchResourceScope(input.resourceScope) ? input.resourceScope : filterScope.scope;
  const filter = searchFilterWithScope(typeof parsed.filter === 'string' ? parsed.filter : undefined, resourceScope);
  if (input.kindCursor !== undefined && (typeof input.kindCursor !== 'string' || input.kindCursor.length > 4864))
    throw new Error('Invalid kind cursor');
  const facetValues = intake.request.facets;
  return {
    query: parsed.q,
    locale: input.locale,
    type: parsed.type,
    cursor: parsed.cursor,
    sort: parsed.sort,
    ...(ratingPopulation ? { ratingPopulation } : {}),
    kinds: parsed.kinds,
    languages: parsed.language,
    ...(filter !== undefined ? { filter } : {}),
    ...(resourceScope ? { resourceScope } : {}),
    ...(typeof input.reader === 'string' ? { reader: input.reader } : {}),
    facetValues,
    ...(isRecord(input.ranges)
      ? {
          ranges: Object.fromEntries(
            Object.entries(input.ranges).map(([property, range]) => {
              const parsed = parseFilter({ statement: { property, range } });
              if (!('statement' in parsed) || !('range' in parsed.statement)) throw new Error('Invalid range');
              return [property, parsed.statement.range];
            }),
          ),
        }
      : {}),
    ...(input.condition ? { condition: parseFilter(input.condition) } : {}),
    ...(input.representation === 'subjects-v1' ? { representation: 'subjects-v1' } : {}),
    ...(typeof input.kindCursor === 'string' ? { kindCursor: input.kindCursor } : {}),
  };
}
