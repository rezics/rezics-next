import { iriOf } from '../discover/scope.ts';
import { authorHref } from '../author/route.ts';
import { workTypes } from '../discover/state.ts';
import type { ResourceQuery } from '../../../../model/definitions/filter-document-v1.ts';
import { type MainClient, problemCode, type WorkCover, type WorkName } from '../discover/types.ts';
import type { SearchState } from './state.ts';
import { reasonsOf, type SearchContinuation, searchFailureOf, type SearchLoaded, type SearchPage,
  } from './types.ts';

export const SEARCH_PAGE_SIZE = 10;

/** One FilterDocument for the phrase; the UI keeps all chosen values in Query's grammar. */
export function searchRequest(state: SearchState, continuation?: SearchContinuation): ResourceQuery {
  const included = [...(state.term ? [state.term] : []), ...(state.concepts?.include ?? [])];
  const excluded = state.concepts?.exclude ?? [];
  const filter: NonNullable<ResourceQuery['filter']> = { all: [
    ...(state.includeTypes?.length ? [{ facet: 'type', any: state.includeTypes.map(key =>
      workTypes.find(type => type.key === key)!.iri) }] : []),
    ...(state.excludeTypes?.length ? [{ facet: 'type', none: state.excludeTypes.map(key =>
      workTypes.find(type => type.key === key)!.iri) }] : []),
    ...(state.language ? [{ facet: 'language', any: [state.language] }] : []),
    ...(included.length ? [{ facet: 'concept', [state.concepts?.match === 'any' ? 'any' : 'all']:
      included.map(iriOf) }] : []),
    ...(excluded.length ? [{ facet: 'concept', none: excluded.map(iriOf) }] : []),
  ] };
  return { context: state.scope.kind === 'realm' ? { realm: iriOf(state.scope.realm) } : 'global',
    scope: { kind: 'all' }, text: { phrase: state.phrase }, sort: 'relevance', filter,
    page: { size: SEARCH_PAGE_SIZE, ...(continuation ? { continuation } : {}) } };
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
    const { data, error } = await clients.search.v1.query.post(searchRequest(state, options.continuation));
    if (error) return { ok: false, failure: searchFailureOf(error.status, problemCode(error.value)) };
    if (!data || !('results' in data.result)
      || data.result.profile === 'public-content-phrase-page-v1') return { ok: false, failure: 'unavailable' };
    page = data.result as SearchPage;
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  const matches = page.results.map(match => ({ match, reasons: reasonsOf(match) }));
  const selected = [...(state.term ? [iriOf(state.term)] : []), ...(state.concepts?.include ?? []).map(iriOf),
    ...(state.concepts?.exclude ?? []).map(iriOf)];
  const concepts = [...new Set([...matches.flatMap(({ reasons }) => reasons.classification?.concept ?? []),
    ...selected])];
  // Main's cards carry a title in the Work's own language; summaries name it in the reader's, when there is one.
  const named = await readSummaries(clients.names, [...new Set([...matches.map(({ match }) => match.work),
    ...concepts])], options.language, options.actingSubject);
  const hits = matches.map(({ match, reasons }) => ({ matchUnit: match.matchUnit, work: match.work,
    mainVersion: match.mainVersion, types: match.types,
    title: named?.get(match.work)?.name ?? match.title ?? null,
    cover: named?.get(match.work)?.avatar ?? (mediaCover(match.cover) ? match.cover! : null),
    authors: (match.primaryCredits ?? []).flatMap(credit => {
      if (!credit.displayName) return [];
      const href = credit.participantKind === 'agent' ? credit.handle
        ? authorHref({ kind: 'agent', handle: credit.handle }) : null
        : credit.provider === 'open-library' && credit.key
          ? authorHref({ kind: 'external', key: credit.key }) : null;
      return [{ name: credit.displayName, href }];
    }),
    rating: match.rating ? { mean: match.rating.mean, count: match.rating.count,
      max: 'scale' in match.rating ? match.rating.scale.max : 5 } : null,
    tagline: match.tagline ?? null, completion: match.completionStatus ?? null,
    reasons: { ...reasons, classification: reasons.classification ? { ...reasons.classification,
      concept: reasons.classification.concept ?? (selected.length === 1 ? selected[0]! : null),
      conceptName: named?.get(reasons.classification.concept
        ?? (selected.length === 1 ? selected[0]! : ''))?.name ?? null } : null } }));
  return { ok: true, page: { total: page.total, population: page.population, sequence: page.sourcePosition.sequence,
    indexGeneration: page.indexGeneration, next: page.next as SearchContinuation | null,
    facets: 'facets' in page ? page.facets : undefined,
    concepts: selected.flatMap(id => {
      const label = named?.get(id)?.name;
      return label ? [{ id, name: label.value, language: label.language }] : [];
    }),
    titles: hits.every(hit => hit.title !== null), hits } };
}

/** A cover Main may show: its generated fallback, or an image served from Main's media paths. */
const mediaCover = (cover: WorkCover | undefined) =>
  cover !== undefined && (cover.kind === 'fallback' || cover.url.startsWith('/v1/media/'));
