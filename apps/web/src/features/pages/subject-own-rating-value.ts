import type { KernelClient } from '@rezics/client';

type SubjectRoutes = ReturnType<KernelClient['subjects']>;
type VoteRoute = ReturnType<SubjectRoutes['ratings']>['vote'];
type OwnVote = NonNullable<Awaited<ReturnType<VoteRoute['get']>>['data']>;

/** Decode only the consumed native field; absence is transported as 404, never nullable units. */
export function decodeOwnRatingValue(value: unknown): Pick<OwnVote, 'units'> | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('units' in value) ||
    typeof value.units !== 'number' ||
    !Number.isSafeInteger(value.units)
  )
    return null;
  return { units: value.units };
}
