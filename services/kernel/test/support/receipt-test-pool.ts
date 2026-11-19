import { createPool } from '../../src/database/pool.ts';
import { configureTestReceiptKeys } from './receipt-keys.ts';

/** Native command fixtures own their receipt authority on the pool they use. */
export function createReceiptTestPool(url: string): ReturnType<typeof createPool> {
  const pool = createPool(url);
  configureTestReceiptKeys(pool);
  return pool;
}
