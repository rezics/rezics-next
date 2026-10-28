import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import { routeOf } from '../route/route.ts';
import { subjectAlias, subjectIndexName } from './indices.ts';
import { type OpenSearch, SearchUnavailableError } from './opensearch.ts';
import type { SearchPlan, SearchResult } from './query.ts';
import type { PublicRatingEpoch } from './rating-source.ts';

export type RatingQueryPlan = Pick<
  SearchPlan,
  'query' | 'filter' | 'boost' | 'size' | 'after' | 'overflowProperties' | 'ratingPhase' | 'generation'
> & { rating: PublicRatingEpoch };

function routableId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && routeOf(value) !== null;
}

/** Admission only. Native ranking awaits engine strategy selection. */
export async function searchRatingSubjects(
  _search: OpenSearch,
  prefix: string,
  plan: RatingQueryPlan,
  _templateId: string,
): Promise<SearchResult> {
  const rating = plan.rating;
  if (
    !rating ||
    typeof rating !== 'object' ||
    Array.isArray(rating) ||
    !routableId(rating.questionId) ||
    rating.populationId !== GLOBAL_CONTEXT.id ||
    !(rating.priorEpoch === null || (Number.isSafeInteger(rating.priorEpoch) && rating.priorEpoch > 0))
  )
    throw new TypeError('Invalid Global rating query metadata');
  if (!Number.isInteger(plan.size) || plan.size < 1 || plan.size > 200)
    throw new RangeError('Search size must be an integer from 1 to 200');
  subjectAlias(prefix);
  if (plan.generation !== undefined) subjectIndexName(prefix, plan.generation);
  const phase = plan.ratingPhase;
  if (
    (phase !== undefined && phase !== 'scored' && phase !== 'unscored') ||
    (phase === 'scored' && rating.priorEpoch === null)
  )
    throw new TypeError('Invalid rating query phase');
  if (plan.after !== undefined) {
    const after = plan.after;
    const scored = phase === 'scored';
    if (!Array.isArray(after) || phase === undefined || after.length !== (scored ? 3 : 2))
      throw new TypeError('Invalid rating query tuple');
    const score: unknown = after[0];
    const name: unknown = after[scored ? 1 : 0];
    const id: unknown = after[scored ? 2 : 1];
    if (
      (scored && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10)) ||
      !(name === null || (typeof name === 'string' && name.length <= 512 && name.isWellFormed())) ||
      !routableId(id)
    )
      throw new TypeError('Invalid rating query tuple');
  }
  throw new SearchUnavailableError('Global rating query is not implemented');
}
