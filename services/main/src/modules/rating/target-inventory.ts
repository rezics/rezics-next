import type { Pool } from 'pg';
import { readTargetRatingSnapshot, recordTargetRatingValues, checkRatingAggregateFence }
  from '../access/rating-aggregate-inventory.ts';

/** Access owner boundary of target aggregates: sealed components, and for one
 * small target its private heads, from a single snapshot. */
export class TargetRatingInventoryStore {
  constructor(private readonly pool: Pool) {}
  read(context: string, target: string, signal?: AbortSignal) {
    return readTargetRatingSnapshot(this.pool, context, [target], signal, { heads: true });
  }
  /** Components of up to 200 members and the Context's own; no head is read. */
  readMembers(context: string, targets: readonly string[], signal?: AbortSignal) {
    return readTargetRatingSnapshot(this.pool, context, targets, signal);
  }
  record(context: string, target: string, generation: string,
    heads: readonly { slot: string; revision: string; value: number | null }[], signal?: AbortSignal) {
    return recordTargetRatingValues(this.pool, context, target, generation, heads, signal);
  }
  checkFence(generation: string, signal?: AbortSignal) {
    return checkRatingAggregateFence(this.pool, generation, signal);
  }
}
