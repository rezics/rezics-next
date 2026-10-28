import type { AccessClient, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import statement from './resource-role-held.sql';

const roleName = /^[a-z][a-z0-9_.-]*$/;

/** Reports only a direct identity role grant at T, using the caller's transaction snapshot.
 * The caller must already have authorized this read and must not disclose the answer to anyone else.
 * This is data, not a permission check: group grants, active_accounts and account state are ignored.
 */
export async function resourceRoleHeld(
  client: AccessClient,
  input: { resource: Resource; role: string; accountId: string; at: Date },
): Promise<boolean> {
  const { resource, role, accountId, at } = input;
  if (
    !resource ||
    routeOf(resource.id) === null ||
    resource.route !== routeOf(resource.id) ||
    routeOf(accountId) === null ||
    typeof role !== 'string' ||
    role.length > 128 ||
    roleName.exec(role)?.[0] !== role ||
    !(at instanceof Date) ||
    !Number.isFinite(at.getTime())
  )
    throw new TypeError('Invalid resource role read input');
  const row = await statement.run(client, {
    route: resource.route,
    resource_id: resource.id,
    grant_role: role,
    account_id: accountId,
    at: at.toISOString(),
  });
  return row.held;
}
