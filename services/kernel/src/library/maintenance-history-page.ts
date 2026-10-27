import type { PoolClient } from 'pg';
import { partitionOf, routeOf } from '../route/route.ts';
import historyPage from './maintenance-history-page.sql';

export type MaintenanceHistoryPage = {
  count: number;
  after: number;
  lastChangedAt: string | null;
  complete: boolean;
};

/** Native history input only; the guarded runner must commit scratch and checkpoint together. */
export async function readMaintenanceHistoryPage(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; sessionId: string; after: number; limit?: number },
): Promise<MaintenanceHistoryPage | null> {
  const { route, accountId, sessionId, after, limit = 100 } = input;
  partitionOf(route);
  if (routeOf(accountId) !== route || routeOf(sessionId) !== route)
    throw new RangeError('Account and session ids must carry the requested route');
  if (!Number.isSafeInteger(after) || after < 0)
    throw new RangeError('History checkpoint must be a nonnegative safe integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('History page limit must be an integer from 1 to 100');

  const row = await historyPage.run(client, {
    route,
    account_id: accountId,
    session_id: sessionId,
    after_change_no: BigInt(after),
    page_limit: limit,
  });
  if (!row.owned) return null;
  return {
    count: row.count,
    after: row.after ?? after,
    lastChangedAt: row.lastChangedAt,
    complete: row.count < limit,
  };
}
