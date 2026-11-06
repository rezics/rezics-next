import type { Pool } from 'pg';
import {
  NATIVE_TEST_ORDER_RETENTION_FIELDS,
  NATIVE_TEST_ORDER_RETENTION_PURPOSE,
  ORDER_RETENTION_STORE,
  prepareCommerceOrderRetention,
} from '../../../src/commerce/erasure-participant.ts';
import inspectRetained from '../../../src/commerce/erasure-retained-inspect.sql';
import { withConnection } from '../../../src/database/pool.ts';
import { routeOf } from '../../../src/route/route.ts';
import type { KeyRing } from '../../../src/tokens/seal.ts';

export {
  NATIVE_TEST_ORDER_RETENTION_FIELDS,
  NATIVE_TEST_ORDER_RETENTION_PURPOSE,
  ORDER_RETENTION_STORE,
  prepareCommerceOrderRetention,
};

export type NativeRetainedOrder = Readonly<{
  orderId: string;
  buyerAccountId: string;
  checkoutUrl: string;
  expiresAt: string;
}>;

/**
 * Trusted Commerce owner seam for Accounts' terminal graph. No HTTP policy input.
 * Native genuine-order setup compiles Access from the composed kernel catalogue and
 * authenticates through Content's Score `nativeAuth.handler`; grant.create attaches
 * this policy after a real purchase, never as an HTTP default.
 */
export async function prepareNativeRetainedOrder(pool: Pool, orderId: string, expiresAt: Date) {
  return (await prepareCommerceOrderRetention(pool, { orderId, expiresAt })).value;
}

/** Independent exact-locator inspection of the participant-owned retained record. */
export async function inspectNativeRetainedOrder(pool: Pool, orderId: string): Promise<NativeRetainedOrder | null> {
  const route = routeOf(orderId);
  if (route === null) throw new Error('Invalid native retained-order locator');
  return withConnection(pool, async (connection) => {
    const row = await inspectRetained.run(connection, { route, order_id: orderId });
    const record = Array.isArray(row) ? row[0] : row;
    return record ?? null;
  });
}

export function encodeNativeKeyRing(keys: KeyRing): string {
  return `${keys.current}:${Buffer.from(keys.keys.get(keys.current)!).toString('base64url')}`;
}

export function encodeNativeRouteKey(routeKey: Uint8Array): string {
  return Buffer.from(routeKey).toString('base64url');
}
