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
  // One live controller, then one ceiling row and its link. Revocation updates that row.
  assignmentCeilingReads: 1,
  assignmentCeilingWrites: 2,
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

/** One statement reads <=129 direct rows, <=17 membership roots, <=16*9
 * ancestry rows and <=129 group grants. SQL materializes the bounded proof
 * before a consumer can accept any permission, including rate-limit trust. */
export async function readPlatformPermissions(
  client: Pick<PoolClient, 'query'>,
  principalId: string,
): Promise<PlatformPermission[]> {
  try {
    return (
      await client.query<PlatformPermission>('SELECT * FROM access.read_platform_permissions($1)', [
        principalId,
      ])
    ).rows;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '54000')
      throw new PlatformAccessUnavailable('Platform proof budget exceeded');
    throw error;
  }
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
