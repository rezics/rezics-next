import { pageCompletePublicRelation, type PublicPhrasePageRequest } from '../work/search-continuation.ts';

export const SEARCH_CARD_WINDOW = 20;
type Query = PublicPhrasePageRequest extends infer Page ? Page extends PublicPhrasePageRequest
  ? Omit<Page, 'profile' | 'pageSize' | 'continuation'> & {
    profile: Page['profile'] extends `${infer Prefix}-page-v1` ? `${Prefix}-v1` : never }
  : never : never;
type Relation<Row> = { resultGrain: 'mainVersion'; complete: true;
  context: 'main-version-default' | { kind: 'realm-local'; id: string };
  population: number; total: number; results: Row[];
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
  indexGeneration: string };

/** Preserve the complete <=512-row matching relation and exact facets. Only
 * the first 20 rows gain cards: enriching all 512 would multiply owner reads.
 * The next request uses the existing page operation and its query/result/mute
 * fences, with no new cursor cache or independent snapshot semantics. */
export function searchCardWindow<Row>(query: Query, relation: Relation<Row>,
  presentationGeneration?: string, now = Date.now()) {
  const request = { ...query, profile: query.profile.replace(/-v1$/, '-page-v1'),
    pageSize: SEARCH_CARD_WINDOW } as PublicPhrasePageRequest;
  const page = pageCompletePublicRelation(request, relation, now, presentationGeneration);
  return { page: { ...relation, ...page }, cardWindow: {
    hydrated: page.results.length, limit: SEARCH_CARD_WINDOW,
    next: page.next ? { ...request, continuation: page.next } : null } };
}
