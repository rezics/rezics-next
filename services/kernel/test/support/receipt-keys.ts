import type { Pool } from 'pg';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { configureReceiptKeys } from '../../src/command/receipt-key.ts';

/** Fixed dedicated native fixture material, independent of token sealing keys. */
export function testReceiptKeys(): KeyRing {
  return { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) };
}

/** Composed entries sharing native fixture receipts must retain the same keys. */
export function testReceiptKeysEnv(): { KERNEL_RECEIPT_KEYS: string } {
  const ring = testReceiptKeys();
  return {
    KERNEL_RECEIPT_KEYS: [...ring.keys]
      .map(([version, bytes]) => `${version}:${Buffer.from(bytes).toString('base64url')}`)
      .join(','),
  };
}

export function configureTestReceiptKeys(pool: Pool): void {
  configureReceiptKeys(pool, testReceiptKeys());
}

/** Ordinary configured hosts receive the same dedicated material as native command fixtures. */
export function testReceiptKeysEnv(): Record<'KERNEL_RECEIPT_KEYS', string> {
  return {
    KERNEL_RECEIPT_KEYS: [...testReceiptKeys().keys]
      .map(([version, key]) => `${version}:${Buffer.from(key).toString('base64url')}`)
      .join(','),
  };
}
