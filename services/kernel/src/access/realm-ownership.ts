import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import type { Access, AccessClient, Resource } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { requireResourceCommand, ResourceAccessWriteDeniedError } from './resource-denials.ts';
import catalogue from './resource-roles.json';
import { resourceRoleCatalogue } from './resource-roles.ts';
import read from './realm-ownership-read.sql';
import lock from './realm-ownership-lock.sql';
import holders from './realm-ownership-holders.sql';

export const REALM_OWNER_ROLE = 'community.realm.owner';
// This ordering is container data. It changes neither role actions nor the Access formula.
const roles = [
  REALM_OWNER_ROLE,
  'community.realm.administrator',
  'community.realm.moderator',
  'community.realm.member',
  'community.realm.standing',
] as const;

type Input = { resource: Resource; accountId: string; at: AuthoritativeTime };
type RoleReadInput = Input & {
  /** Trusted service composition. Without it only built-in definitions apply.
   * A role name in a grant row never installs a role or supplies its actions. */
  access?: Access;
};
function parameters(input: Input) {
  if (
    !input.resource ||
    routeOf(input.resource.id) === null ||
    routeOf(input.resource.id) !== input.resource.route ||
    routeOf(input.accountId) === null
  )
    throw new ResourceAccessWriteDeniedError();
  return {
    route: input.resource.route,
    resource_id: input.resource.id,
    account_id: input.accountId,
    at: authoritativeTimeValue(input.at),
  };
}

/** Private direct-role data for a read already authorized by the caller. Five exact
 * temporal key probes, at most five rows; no account, group or membership expansion.
 * Account lifecycle is deliberately not authorization in this data port.
 */
export async function readRealmOwnershipRoles(
  client: AccessClient,
  input: RoleReadInput,
): Promise<readonly { role: string; rank: number; valid: string }[]> {
  const installed = input.access === undefined ? undefined : resourceRoleCatalogue(input.access);
  const rows = await read.run(client, {
    ...parameters(input),
    roles: roles.filter((role) =>
      input.access === undefined ? Object.hasOwn(catalogue.roles, role) : installed?.roles.has(role) === true,
    ),
  });
  return rows.map((row) => {
    if (row.role === null) throw new TypeError('Realm ownership role is missing');
    return { role: row.role, rank: row.rank, valid: row.valid };
  });
}

/** Lock the native creation anchor, never a parallel owner registry. The caller
 * must already have authorized this exact resource in the live command at T.
 */
export async function lockRealmOwnership(client: AccessClient, input: Input): Promise<void> {
  const key = parameters(input);
  requireResourceCommand(client, input.resource, input.at);
  const row = await lock.run(client, key);
  if (!row) throw new ResourceAccessWriteDeniedError();
}

/** Native explicit-holder invariant. The lock and the bounded holder predicate
 * stay in the same SERIALIZABLE command as the removal. Never call this as a
 * preflight on a pool: that would release the invariant before publication.
 * Both probes use the same authoritative T. The remaining holder must have an
 * open-ended interval; a scheduled expiry cannot guarantee owner continuity.
 * SERIALIZABLE retries recheck the predicates after concurrent grant changes.
 */
export async function assertRealmOwnerMayLeave(client: AccessClient, input: Input): Promise<void> {
  await lockRealmOwnership(client, input);
  const row = await holders.run(client, parameters(input));
  if (!row.target || !row.remaining) throw new ResourceAccessWriteDeniedError();
}
