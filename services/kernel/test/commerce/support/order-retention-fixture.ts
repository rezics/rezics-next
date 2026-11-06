import type { Pool } from 'pg';
import { prepareCommerceOrderRetention } from '../../../src/commerce/erasure-participant.ts';
import inspectRetained from '../../../src/commerce/erasure-retained-inspect.sql';
import { withConnection } from '../../../src/database/pool.ts';
import { routeOf } from '../../../src/route/route.ts';

export function prepareNativeRetainedOrder(pool: Pool, orderId: string, expiresAt: Date) {
  return prepareCommerceOrderRetention(pool, { orderId, expiresAt });
}

/** Independent exact-locator inspection of the participant-owned retained record. */
export async function inspectNativeRetainedOrder(pool: Pool, orderId: string) {
  const route = routeOf(orderId);
  if (route === null) throw new Error('Invalid native retained-order locator');
  return withConnection(pool, async (connection) => {
    return inspectRetained.run(connection, { route, order_id: orderId });
  });
}
