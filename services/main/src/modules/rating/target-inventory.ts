import type { Pool } from 'pg';
import { readTargetRatingSnapshot, checkRatingAggregateFence }
  from './aggregate-inventory.ts';

/** Access owner boundary of target aggregates: sealed components, and for one
 * small target its private heads, from a single snapshot. */
export class TargetRatingInventoryStore {
  constructor(private readonly pool: Pool) {}
  read(context: string, target: string, signal?: AbortSignal) {
    return readTargetRatingSnapshot(this.pool, context, [target], signal, { heads: true });
  }
  /** Components of up to 200 members and the Context seal; no head is read. */
  readMembers(context: string, targets: readonly string[], signal?: AbortSignal) {
    return readTargetRatingSnapshot(this.pool, context, targets, signal);
  }
  checkFence(generation: string, signal?: AbortSignal) {
    return checkRatingAggregateFence(this.pool, generation, signal);
  }
}
