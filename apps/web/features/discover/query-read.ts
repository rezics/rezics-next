import type { FilterCondition, ResourceQuery } from '../../../../model/definitions/filter-document-v1.ts';
import { iriOf } from './scope.ts';
import type { DiscoverState } from './state.ts';
import { failureOf, type DiscoveryPage, type DiscoveryQuery, type Loaded, type MainClient, problemCode }
  from './types.ts';

/** Filtered shelves use the Concept Works Query template and its bounded newest page. */
export async function readQueryDiscovery(main: MainClient, state: DiscoverState,
  shelf: DiscoveryQuery): Promise<Loaded<DiscoveryPage>> {
  const conditions = state.conditions;
  if (!conditions?.include.length || state.term || state.scope.kind === 'mine' || shelf.sort !== 'recent') {
    return { ok: false, failure: 'unsupported' };
  }
  const all: FilterCondition[] = [];
  if (shelf.type) all.push({ facet: 'type', any: [String(shelf.type)] });
  all.push(conditions.match === 'any' ? { facet: 'concept', any: conditions.include.map(iriOf) }
    : { facet: 'concept', all: conditions.include.map(iriOf) });
  if (conditions.exclude.length) all.push({ facet: 'concept', none: conditions.exclude.map(iriOf) });
  const filter: NonNullable<ResourceQuery['filter']> = { all };
  const query: ResourceQuery = { context: state.scope.kind === 'realm' ? { realm: iriOf(state.scope.realm) }
    : 'global', scope: { kind: 'all' }, filter, sort: 'newest', page: { size: shelf.limit ?? 12,
      ...(shelf.cursor ? { continuation: shelf.cursor } : {}) } };
  const read = async (): Promise<Loaded<DiscoveryPage>> => {
    try {
      const { data, error } = await main.v1.query.post(query,
        { headers: { 'accept-language': shelf.language ?? 'en' } });
      if (error) return { ok: false, failure: failureOf(error.status, problemCode(error.value)) };
      if (data?.result.profile !== 'concept-works-v1') return { ok: false, failure: 'unavailable' };
      const result = data.result;
      return { ok: true, data: { profile: 'discovery-works-v1', order: 'recent', context: null, matchedTerm: null,
        generation: result.generation, stale: result.stale, projectionPosition: result.projectionPosition,
        scope: result.scope, items: result.items, sourcePosition: result.sourcePosition,
        nextCursor: result.nextCursor, count: result.count, matches: result.matches } as DiscoveryPage };
    } catch { return { ok: false, failure: 'unavailable' }; }
  };
  const first = await read();
  return !first.ok && first.failure === 'moved' && !shelf.cursor ? read() : first;
}
