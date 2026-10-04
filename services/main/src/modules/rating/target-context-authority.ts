import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';

/** A persisted scope distinguishes v4 target creation from legacy Global
 * standing creation at registration, saved-proof replay and claim. */
export const GLOBAL_TARGET_CONTEXT_SCOPE = `rating:context:target:${GLOBAL_RATING_POPULATION_OWNER}`;
export const GLOBAL_TARGET_CONTEXT_PROFILE =
  'https://rezics.com/definition/realm-target-rating-context-v4';
