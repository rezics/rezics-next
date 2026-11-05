import type { Pool } from 'pg';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { configureReceiptKeys } from '../../src/command/receipt-key.ts';

/** Fixed dedicated native fixture material, independent of token sealing keys. */
export function testReceiptKeys(): KeyRing {
  return { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
}

export function configureTestReceiptKeys(pool: Pool): void {
  configureReceiptKeys(pool, testReceiptKeys());
}
