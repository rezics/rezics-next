import type { FilterCondition, ResourceQuery } from '../../../../model/definitions/filter-document-v1.ts';
import { iriOf } from './scope.ts';
import type { DiscoverState } from './state.ts';
import { failureOf, type DiscoveryPage, type DiscoveryQuery, type Loaded, type MainClient, problemCode }
  from './types.ts';

/** Filtered shelves use the Concept Works Query, including top-rated, Mine and exclude-only. */
export async function readQueryDiscovery(main: MainClient, state: DiscoverState,
  shelf: DiscoveryQuery): Promise<Loaded<DiscoveryPage>> {
  const conditions = state.conditions;
  const included = conditions?.include.length ?? 0;
  const excluded = conditions?.exclude.length ?? 0;
  const mine = state.scope.kind === 'mine';
  const top = shelf.sort === 'top-rated';
  if ((!included && !excluded) || state.term || (top && !shelf.context)) return { ok: false, failure: 'unsupported' };
  if (mine && !shelf.actingSubject) return { ok: false, failure: 'sign-in' };
  const all: FilterCondition[] = [];
  if (shelf.type) all.push({ facet: 'type', any: [String(shelf.type)] });
  if (included) all.push(conditions!.match === 'any' ? { facet: 'concept', any: conditions!.include.map(iriOf) }
    : { facet: 'concept', all: conditions!.include.map(iriOf) });
  if (excluded) all.push({ facet: 'concept', none: conditions!.exclude.map(iriOf) });
  const filter: NonNullable<ResourceQuery['filter']> = { all };
  const query: ResourceQuery = { context: state.scope.kind === 'realm' ? { realm: iriOf(state.scope.realm) }
    : 'global', scope: mine ? { kind: 'mine' } : { kind: 'all' }, filter,
    sort: top ? 'top-rated' : 'newest',
    ...(top || mine ? { ratingContext: shelf.context ?? undefined } : {}),
    ...(mine && shelf.actingSubject ? { actingSubject: shelf.actingSubject } : {}),
    page: { size: shelf.limit ?? 12, ...(shelf.cursor ? { continuation: shelf.cursor } : {}) } };
  const read = async (): Promise<Loaded<DiscoveryPage>> => {
    try {
      const { data, error } = await main.v1.query.post(query,
        { headers: { 'accept-language': shelf.language ?? 'en' } });
      if (error) return { ok: false, failure: failureOf(error.status, problemCode(error.value)) };
      if (data?.result.profile !== 'concept-works-v1') return { ok: false, failure: 'unavailable' };
      const result = data.result;
      return { ok: true, data: { profile: 'discovery-works-v1', order: top ? 'top-rated' : 'recent',
        context: shelf.context ?? null, matchedTerm: null,
        generation: result.generation, stale: result.stale, projectionPosition: result.projectionPosition,
        scope: result.scope, items: result.items, sourcePosition: result.sourcePosition,
        nextCursor: result.nextCursor, count: result.count, matches: result.matches } as DiscoveryPage };
    } catch { return { ok: false, failure: 'unavailable' }; }
  };
  const first = await read();
  return !first.ok && first.failure === 'moved' && !shelf.cursor ? read() : first;
}
