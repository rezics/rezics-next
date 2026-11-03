import { ProblemError } from '../http/problem.ts';
import type { RealmRatingSource } from './realm-rating-order.ts';

/**
 * Production readiness boundary for Content's complete Realm order.
 *
 * The installed createRealmRankSource supplies scored previews only. It cannot
 * establish complete predicates, canonical name ties or figure absence. Until
 * Content supplies that capability, both entry points must refuse the read.
 * Keep this binding separate from the public Global rating source.
 */
export function createRealmRatingNativeSource(): RealmRatingSource {
  const unavailable = async (): Promise<never> => {
    throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  };
  return {
    observe: unavailable,
    read: unavailable,
  };
}
