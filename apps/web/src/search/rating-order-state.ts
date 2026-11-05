import type { SearchLoaderDeps } from './search-params';
import { canonicalRealmRatingPopulationId } from './rating-population';

export type RatingOrder = 'relevance' | 'rating';
export type RatingOrderState = Pick<SearchLoaderDeps, 'cursor' | 'sort'> & {
  ratingPopulation?: string | undefined;
};

/** Change the ranking basis without decoding or rewriting an opaque native continuation. */
export function changeRatingOrder(
  state: RatingOrderState,
  order: RatingOrder,
  populationId?: string | null,
): RatingOrderState {
  const currentPopulation = canonicalRealmRatingPopulationId(state.ratingPopulation);
  const nextPopulation =
    populationId === undefined
      ? currentPopulation
      : populationId === null
        ? undefined
        : canonicalRealmRatingPopulationId(populationId);
  const nextSort = order === 'rating' ? 'rating' : undefined;
  const basisChanged = state.sort !== nextSort || currentPopulation !== nextPopulation;
  return {
    sort: nextSort,
    cursor: basisChanged ? undefined : state.cursor,
    ...(nextPopulation ? { ratingPopulation: nextPopulation } : {}),
  };
}

/** A native generation change restarts the same basis with a new first page. */
export function restartRatingOrder(state: RatingOrderState): RatingOrderState {
  return { ...state, cursor: undefined };
}
