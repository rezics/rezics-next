import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export const PLATFORM_SCOPE = 'platform:access';
export const PLATFORM_COST = Object.freeze({
  grants: 128,
  groups: 16,
  groupDepth: 8,
  operations: 64,
  cacheEntries: 1024,
  statementMs: 5000,
});
export class PlatformAccessUnavailable extends Error {}
export interface PlatformPermission {
  id: string;
  action: string;
  scope_id: string;
  generation: string;
  valid_until: Date | null;
  witness: string;
}

/** Cost: <=129 direct rows, <=17 membership roots, <=16*9 ancestry rows and
 * <=129 group grants. No resource lookup, user scan or operation inventory. */
export async function readPlatformPermissions(
  client: Pick<PoolClient, 'query'>,
  principalId: string,
): Promise<PlatformPermission[]> {
  const direct = (
    await client.query<PlatformPermission>(
      `SELECT g.id,g.action,g.scope_id,g.generation,
    CASE WHEN g.valid_until = 'infinity' THEN NULL ELSE g.valid_until END AS valid_until,
    e.receipt || ':' || g.generation::text AS witness
    FROM access.principal_permission_grant g JOIN access.platform_grant_episode e ON e.principal_grant_id = g.id
    WHERE g.principal_id = $1 AND g.active AND g.action LIKE 'platform:%'
      AND (g.private_membership_id IS NULL OR EXISTS (SELECT 1 FROM access.private_membership m
        WHERE m.id = g.private_membership_id AND m.principal_id = g.principal_id
          AND m.state = 'joined' AND m.generation = g.private_membership_generation))
      AND g.valid_until > clock_timestamp() ORDER BY g.id LIMIT $2`,
      [principalId, PLATFORM_COST.grants + 1],
    )
  ).rows;
  if (direct.length > PLATFORM_COST.grants)
    throw new PlatformAccessUnavailable('Platform grant budget exceeded');
  const memberships = (
    await client.query<{
      id: string;
      group_id: string;
      generation: string;
      private_membership_generation: string;
    }>(
      `SELECT m.id,m.group_id,m.generation,m.private_membership_generation
    FROM access.private_group_member m JOIN access.private_membership p ON p.id = m.private_membership_id
    WHERE m.principal_id = $1 AND m.active AND p.state = 'joined' AND p.principal_id = m.principal_id
      AND p.generation = m.private_membership_generation ORDER BY m.id LIMIT $2`,
      [principalId, PLATFORM_COST.groups + 1],
    )
  ).rows;
  if (memberships.length > PLATFORM_COST.groups)
    throw new PlatformAccessUnavailable('Platform membership budget exceeded');
  if (!memberships.length) return direct;
  const group = (
    await client.query<PlatformPermission & { depth: number; parent_id: string | null }>(
      `
    WITH RECURSIVE ancestry(id,parent_id,depth,witness) AS (
      SELECT g.id,g.parent_id,0,g.id::text || ':' || g.generation::text
        FROM access.recipient_group g WHERE g.id = ANY($1::uuid[])
      UNION ALL SELECT g.id,g.parent_id,a.depth+1,a.witness || ':' || g.id::text || ':' || g.generation::text
        FROM access.recipient_group g JOIN ancestry a ON g.id = a.parent_id WHERE a.depth < $2
    ) SELECT g.id,g.action,g.scope_id,g.generation,
      CASE WHEN g.valid_until = 'infinity' THEN NULL ELSE g.valid_until END AS valid_until,
      e.receipt || ':' || g.generation::text || ':' || a.witness AS witness,a.depth,a.parent_id
      FROM ancestry a JOIN access.group_permission_grant g ON g.group_id = a.id
      JOIN access.platform_grant_episode e ON e.group_grant_id = g.id
      WHERE g.active AND g.action LIKE 'platform:%' AND g.valid_until > clock_timestamp()
      ORDER BY g.id LIMIT $3`,
      [memberships.map((m) => m.group_id), PLATFORM_COST.groupDepth, PLATFORM_COST.grants + 1],
    )
  ).rows;
  if (
    direct.length + group.length > PLATFORM_COST.grants ||
    group.some((row) => row.depth === PLATFORM_COST.groupDepth && row.parent_id !== null)
  ) {
    throw new PlatformAccessUnavailable('Platform group grant budget exceeded');
  }
  const membershipWitness = JSON.stringify(memberships);
  return [
    ...direct,
    ...group.map((row) => ({ ...row, witness: `${row.witness}:${membershipWitness}` })),
  ];
}

export function platformPermissionDigest(permission: PlatformPermission): string {
  return `urn:rezics:access-receipt:${createHash('sha256')
    .update(JSON.stringify([permission.id, permission.generation, permission.witness]))
    .digest('hex')}`;
}

export async function platformPermissionProof(
  client: Pick<PoolClient, 'query'>,
  principalId: string,
  action: string,
  scope = PLATFORM_SCOPE,
): Promise<PlatformPermission | null> {
  return findPlatformPermission(await readPlatformPermissions(client, principalId), action, scope);
}

export function findPlatformPermission(
  permissions: readonly PlatformPermission[],
  action: string,
  scope = PLATFORM_SCOPE,
): PlatformPermission | null {
  return (
    permissions.find(
      (row) =>
        row.action === action &&
        (action === 'platform:grant' ||
          action.startsWith('platform:use:') ||
          row.scope_id === scope ||
          (row.scope_id.endsWith(':*') && scope.startsWith(row.scope_id.slice(0, -1)))),
    ) ?? null
  );
}
