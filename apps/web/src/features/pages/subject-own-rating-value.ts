import type { VoteRead } from '@rezics/client';

/** Decode only the consumed native field; absence is transported as 404, never nullable units. */
export function decodeOwnRatingValue(value: unknown): Pick<VoteRead, 'units'> | null {
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
