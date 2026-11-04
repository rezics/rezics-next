import { t } from 'elysia';
import type { Freshness } from './freshness.ts';

/** Deliberately contains no relay identity, lag count or event timestamp. */
export const SearchFreshnessSchema = t.Object({
  state: t.Union([t.Literal('current'), t.Literal('catching-up'), t.Literal('unavailable')]),
}, { additionalProperties: false });
export type SearchFreshness = { state: 'current' | 'catching-up' | 'unavailable' };
export type SearchObservation = { as_of: string; freshness: SearchFreshness };

export function publicFreshness(observed: Freshness): SearchFreshness {
  if (!Number.isFinite(observed.asOf.getTime()) || !Number.isSafeInteger(observed.behind) || observed.behind < 0)
    return { state: 'unavailable' };
  return { state: observed.catchingUp ? 'catching-up' : 'current' };
}

export function searchObservation(observed: Freshness): SearchObservation {
  // An invalid native timestamp cannot satisfy the existing result readiness contract.
  return { as_of: observed.asOf.toISOString(), freshness: publicFreshness(observed) };
}
