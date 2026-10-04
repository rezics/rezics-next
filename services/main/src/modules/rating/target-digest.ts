import { hash } from '../work/activate.ts';
import { InvalidRatingObservationInput } from './observation.ts';

export const TARGET_OBSERVATION_ID = 'realm-target-rating-observation-v1';
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface TargetRatingInput { context: string; target: string; expectedRevisionHead: string | null;
  value: number | null; actingSubject: string }

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
