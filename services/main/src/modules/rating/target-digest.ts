import { hash } from '../work/activate.ts';
import { InvalidRatingObservationInput } from './observation.ts';
import { RATING_STANDING_CADENCE } from './context.ts';

export const TARGET_OBSERVATION_ID = 'realm-target-rating-observation-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface TargetRatingInput { context: string; target: string; expectedRevisionHead: string | null;
  value: number | null; actingSubject: string }

/** Shared by the graph writer and Access so a receipt cannot choose a new vote slot. */
export function targetRatingSlotIri(principalId: string, context: string, target: string): string {
  if (!/^[0-9a-f-]{36}$/.test(principalId) || ![context, target].every(value => nativeId.test(value))) {
    throw new InvalidRatingObservationInput('Invalid target slot');
  }
  return `urn:rezics:rating-slot:${hash(JSON.stringify({ family: TARGET_OBSERVATION_ID,
    principalId, context, target, cadence: RATING_STANDING_CADENCE }))}`;
}

/** Split from the write path so Access can bind a sealed value to its admitted
 * request without importing the graph command code. */
export function targetRatingDigest(input: TargetRatingInput): string {
  if (![input.context, input.target, input.actingSubject].every(value => nativeId.test(value))
    || input.expectedRevisionHead !== null && !nativeId.test(input.expectedRevisionHead)
    || input.value !== null && (!Number.isInteger(input.value) || input.value < 1 || input.value > 10)
    || input.value === null && input.expectedRevisionHead === null) {
    throw new InvalidRatingObservationInput('Invalid target rating');
  }
  return hash(JSON.stringify({ family: TARGET_OBSERVATION_ID, context: input.context, target: input.target,
    expectedRevisionHead: input.expectedRevisionHead, value: input.value, actingSubject: input.actingSubject }));
}
