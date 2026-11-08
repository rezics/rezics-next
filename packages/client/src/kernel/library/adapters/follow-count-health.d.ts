import { type CountRuntime } from './follow-count-runtime.ts';
export { requireFollowCountHealth, readFollowCountHealthObservation, type FollowCountHealthObservation, } from './follow-count-observation.ts';
/** One native partition sample, three bounded 16-child reductions. Stale children
 * retain their timestamp; a parent cannot refresh it by running again. */
export declare function sampleFollowCountHealth(deps: CountRuntime, partition: number): Promise<void>;
