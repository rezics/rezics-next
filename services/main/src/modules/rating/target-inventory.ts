import type { Pool } from 'pg';
import { readTargetRatingAggregateInventory, checkRatingAggregateFence } from '../access/rating-aggregate-inventory.ts';

/** Exact Context/target, k+1 private heads, and primary-key sealed admission joins. */
export class TargetRatingInventoryStore {
  constructor(private readonly pool: Pool) {}
  read(context: string, target: string, signal?: AbortSignal) {
    return readTargetRatingAggregateInventory(this.pool, context, target, signal);
  }
  checkFence(generation: string, signal?: AbortSignal) {
    return checkRatingAggregateFence(this.pool, generation, signal);
  }
}
