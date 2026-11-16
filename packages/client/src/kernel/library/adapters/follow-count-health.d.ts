import { type CountRuntime } from './follow-count-runtime.ts';
export { requireFollowCountHealth, readFollowCountHealthObservation, type FollowCountHealthObservation, } from './follow-count-observation.ts';
/** A scheduled page shares a checkout and reduces each affected ancestor once.
 * Each home still has its own native fence, coverage, and indexed pending probes. */
export declare function sampleFollowCountHealthPage(deps: CountRuntime, partitions: number[]): Promise<number[]>;
export declare function sampleFollowCountHealth(deps: CountRuntime, partition: number): Promise<void>;
