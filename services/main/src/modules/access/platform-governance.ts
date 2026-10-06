import type { Pool } from 'pg';
import { PLATFORM_SCOPE } from './platform-permissions.ts';

export const PLATFORM_GOVERNANCE_COST = Object.freeze({
  statements: 1,
  holders: 2,
  statementMs: 5000,
});

/** One permanent-direct-grant lookup returns at most two distinct active
 * principals. Two means at least two; duplicate grants never count as backups.
 * Callers bound the statement timeout, including scans past inactive holders. */
export async function assertPlatformGovernance(pool: Pick<Pool, 'query'>): Promise<1 | 2> {
  const result = await pool.query<{ principal_id: string }>(
    `SELECT DISTINCT g.principal_id FROM access.principal_permission_grant g
    JOIN access.principal p ON p.id = g.principal_id
    JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
    WHERE g.action = 'platform:grant' AND g.active AND g.valid_until = 'infinity'
      AND g.scope_id = $1 AND g.private_membership_id IS NULL AND p.active
    ORDER BY g.principal_id LIMIT $2`,
    [PLATFORM_SCOPE, PLATFORM_GOVERNANCE_COST.holders],
  );
  if (!result.rows.length)
    throw new Error(
      'Production opening requires an active principal with a permanent platform:grant',
    );
  return result.rows.length === 1 ? 1 : 2;
}
