import type { PoolClient } from 'pg';
import { ROUTES, routeOf } from '../route/route.ts';
import sessionPage from './maintenance-session-page.sql';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
type MaintenanceSession = Awaited<ReturnType<typeof sessionPage.run>>[number];

/**
 * Private source inputs only, with exact stored timestamps. The caller owns the repeatable-read snapshot and
 * maintenance fence; these rows confer no run authority. Keep each session checkpointed until its children exhaust.
 */
export async function readMaintenanceSessions(
  client: Pick<PoolClient, 'query'>,
  input: { route: number; accountId: string; after: string | null; limit?: number },
): Promise<{ sessions: readonly MaintenanceSession[]; after: string | null; complete: boolean }> {
  const { route, accountId, after, limit = 100 } = input;
  if (!Number.isSafeInteger(route) || route < 0 || route >= ROUTES)
    throw new RangeError('Route must be an integer from 0 to 65535');
  if (routeOf(accountId) !== route) throw new RangeError('Account id must carry the owner route');
  if (after !== null && routeOf(after) !== route) throw new RangeError('Session cursor must carry the owner route');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Limit must be an integer from 1 to 100');

  const sessions = await sessionPage.run(client, {
    route,
    account_id: accountId,
    after: after ?? NIL_UUID,
    page_limit: limit,
  });
  return { sessions, after: sessions.at(-1)?.sessionId ?? after, complete: sessions.length < limit };
}
