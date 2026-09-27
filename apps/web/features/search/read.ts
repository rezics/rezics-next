import { iriOf } from '../discover/scope.ts';
import { workTypes } from '../discover/state.ts';
import { type MainClient, problemCode, type WorkCover, type WorkName } from '../discover/types.ts';
import type { SearchState } from './state.ts';
import { reasonsOf, type SearchContinuation, searchFailureOf, type SearchLoaded, type SearchPage,
  type SearchPageRequest } from './types.ts';

export const SEARCH_PAGE_SIZE = 10;

/** The phrase page profile for a state: Main or Realm context, with or without a classification term. */
export function searchRequest(state: SearchState, continuation?: SearchContinuation): SearchPageRequest {
  const base = { phrase: state.phrase, language: state.language, pageSize: SEARCH_PAGE_SIZE,
    ...(state.includeTypes?.length ? { includeTypes: state.includeTypes.map(key => workTypes.find(type => type.key === key)!.iri) } : {}),
    ...(state.excludeTypes?.length ? { excludeTypes: state.excludeTypes.map(key => workTypes.find(type => type.key === key)!.iri) } : {}),
    ...(continuation ? { continuation } : {}) };
  const context = state.scope.kind === 'realm'
    ? { kind: 'realm-local' as const, id: iriOf(state.scope.realm) } : null;
  if (state.term) {
    const sense = iriOf(state.term);
    return context ? { profile: 'public-realm-classified-phrase-page-v1', context, sense, ...base }
      : { profile: 'public-main-classified-phrase-page-v1', sense, ...base };
  }
  return context ? { profile: 'public-realm-phrase-page-v1', context, ...base }
    : { profile: 'public-main-phrase-page-v1', ...base };
}

type Named = { name: WorkName; avatar: WorkCover };

/**
 * Names and covers for results, in one bounded batch. Main declares this
 * response typed. Its availability and media URL are still checked before display.
 * Null when Main could not answer: the results still stand, without names.
 */
export async function readSummaries(main: MainClient, resources: readonly string[], language: string,
  actingSubject?: string): Promise<Map<string, Named> | null> {
  if (!resources.length) return new Map();
  try {
    const { data, error } = await main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
      resources: [...resources], language, ...(actingSubject ? { actingSubject } : {}) });
    if (error || !data) return null;
    const named = new Map<string, Named>();
    for (const item of data.summaries) {
      if (item.status !== 'available'
        || (item.avatar.kind === 'image' && !item.avatar.url.startsWith('/v1/media/'))) continue;
      named.set(item.reference, { name: item.name, avatar: item.avatar });
    }
    return named;
  } catch {
    return null;
  }
}

/**
 * One page of phrase results, then one typed summary batch for their Works and
 * concepts. `search` carries the session (for its mutes); `names` may be
 * anonymous, since only public Works are ever results.
 */
export async function readSearchPage(clients: { search: MainClient; names: MainClient }, state: SearchState,
  options: { language: string; actingSubject?: string; continuation?: SearchContinuation }): Promise<SearchLoaded> {
  let page: SearchPage;
  try {
    const { data, error } = await clients.search.v1.queries.page.post(searchRequest(state, options.continuation));
    if (error) return { ok: false, failure: searchFailureOf(error.status, problemCode(error.value)) };
    if (!data || data.profile === 'public-content-phrase-page-v1') return { ok: false, failure: 'unavailable' };
    page = data;
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  const matches = page.results.map(match => ({ match, reasons: reasonsOf(match) }));
  const concepts = matches.flatMap(({ reasons }) => reasons.classification?.concept ?? []);
  const named = await readSummaries(clients.names, [...new Set([...matches.map(({ match }) => match.work),
    ...concepts])], options.language, options.actingSubject);
  return { ok: true, page: { total: page.total, population: page.population, sequence: page.sourcePosition.sequence,
    indexGeneration: page.indexGeneration, next: page.next, titles: named !== null, facets: page.facets,
    hits: matches.map(({ match, reasons }) => ({ matchUnit: match.matchUnit, work: match.work,
      mainVersion: match.mainVersion, types: match.types, title: named?.get(match.work)?.name ?? null,
      cover: named?.get(match.work)?.avatar ?? null,
      reasons: { ...reasons, classification: reasons.classification ? { ...reasons.classification,
        conceptName: reasons.classification.concept
          ? named?.get(reasons.classification.concept)?.name ?? null : null } : null } })) } };
}
