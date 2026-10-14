import type { ResourceCard, ServedPage } from './api.ts';
import { browseQuery, emptyBrowse, type BrowseState } from './browse-state.ts';
import type { MainClient } from './types.ts';

const id = (index: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const closureSearchState: BrowseState = { ...emptyBrowse,
  q: 'Lantern original', scope: { kind: 'realm', realm: id(1).split('/').at(-1)! } };
export const independentOriginal: ResourceCard = {
  id: id(2), kind: 'work', types: ['https://schema.org/Book'],
  name: { value: 'Lantern original', language: 'en', direction: 'ltr', basis: 'requested' },
  icon: { kind: 'fallback', policy: 'avatar-fallback-v1', resourceType: 'work', key: 'original' },
  work: { primaryCredits: [{ id: id(3), role: 'author', participantKind: 'agent', identityStatus: 'active',
    agent: id(4), displayName: 'Original author', handle: 'original-author', provider: null, key: null, ordinal: null }],
    creditCount: { value: 1, kind: 'exact' }, rating: null },
};
export type RealmSearchState = 'closed' | 'closed-continuation' | 'global' | 'empty' | 'error';

/** Contract-only examples. Closure has no recorded answer file; these are wave-prove capture requests. */
export function realmSearchFixture(kind: RealmSearchState) {
  const state: BrowseState = { ...closureSearchState,
    ...(kind === 'global' || kind === 'empty' ? { scope: { kind: 'global' as const } } : {}),
    ...(kind === 'closed-continuation' ? { cursor: 'opaque-preclosure-continuation' } : {}),
    ...(kind === 'empty' ? { q: 'Unmatched original title' } : {}),
  };
  const query = browseQuery(state);
  const page: ServedPage<ResourceCard, 'resource-list-v1'> = {
    profile: 'resource-list-v1', items: kind === 'global' ? [independentOriginal] : [],
    complete: true, nextCursor: null, count: { value: kind === 'global' ? 1 : 0, kind: 'exact' },
    sourcePosition: { dataEpoch: 'contract-fixture', sequence: '12' }, stale: false,
  };
  type QueryAnswer = NonNullable<Awaited<ReturnType<MainClient['v1']['query']['post']>>['data']>;
  const success: QueryAnswer = { profile: 'query-v1', template: 'resource-list-v1',
    selection: { context: query.context, scope: query.scope, filter: query.filter ?? { all: [] },
      text: query.q ? { phrase: query.q } : null, sort: query.sort, pageSize: query.limit ?? 20,
      facetRefs: [], semanticRevisions: [] }, result: page };
  const status = kind === 'closed' || kind === 'closed-continuation' ? 404 : kind === 'error' ? 503 : 200;
  const answer = status === 200 ? success : { type: 'about:blank', title: status === 404 ? 'Not found' : 'Unavailable', status,
    code: status === 404 ? 'realm_not_found' : 'discovery_unavailable' };
  return { source: 'contract' as const, kind, state, method: 'POST', path: '/v1/query', query, status, answer };
}

export const missingRealmSearchStates = (['closed', 'closed-continuation', 'global', 'empty', 'error'] as const)
  .map(realmSearchFixture);
