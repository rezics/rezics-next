import type { Pool } from 'pg';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { configureReceiptKeys } from '../../src/command/receipt-key.ts';

/** Fixed dedicated native fixture material, independent of token sealing keys. */
export function testReceiptKeys(): KeyRing {
  return { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
}

/** Composed entries sharing native fixture receipts must retain the same keys. */
export function testReceiptKeysEnv(ring: KeyRing = testReceiptKeys()): { KERNEL_RECEIPT_KEYS: string } {
  return {
    KERNEL_RECEIPT_KEYS: [...ring.keys]
      .map(([version, bytes]) => `${version}:${Buffer.from(bytes).toString('base64url')}`)
      .join(','),
  };
}

export function configureTestReceiptKeys(pool: Pool, ring: KeyRing = testReceiptKeys()): void {
  configureReceiptKeys(pool, ring);
}
