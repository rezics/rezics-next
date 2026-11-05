import type { PoolClient } from 'pg';
import { routeOf } from '../route/route.ts';
import readVersion from './owner-fact-version.sql';

/** Private invalidation metadata in the caller's native snapshot; never readiness or authority. */
export async function readOwnerFactVersion(
  client: Pick<PoolClient, 'query'>,
  accountId: string,
): Promise<bigint | null> {
  const route = routeOf(accountId);
  if (route === null || accountId.length !== 36) throw new TypeError('Invalid owner account route');
  const row = await readVersion.run(client, { route, account_id: accountId });
  return row === null ? null : BigInt(row.generation);
}
