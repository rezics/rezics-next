import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import type { Access, Resource } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { shareAccount } from './account-share.ts';
import { PLATFORM_RESOURCE } from './bootstrap-governance.ts';
import { GrantDeniedError } from './grant-commands.ts';
import { REALM_OWNER_ROLE } from './realm-ownership.ts';
import { resourceRoleCatalogue } from './resource-roles.ts';
import { AccessUnavailableError } from '../request/unavailable.ts';
import lock from './realm-ownership-lock.sql';
import frontier from './realm-claim-frontier.sql';
import holders from './realm-claim-holders.sql';
import grant from './role-grant-mutate.sql';

/** Internal Access writer, not a public command or a creation grant. Its
 * owning caller first locks Content's exact current orphan/request source,
 * obtains its native claimant, then applies Content's matching owned decision before
 * committing this transaction. No ordinary grant command receives an exemption.
 */
export async function grantRealmClaimOwner(
  tx: CommandTransaction,
  access: Access,
  resource: Resource,
  claimantAccountId: string,
  transactionId: string,
): Promise<void> {
  const command = currentCommand(tx);
  const authorization = command.authorization;
  const roles = resourceRoleCatalogue(access);
  if (
    !authorization ||
    authorization.mode !== 'execute' ||
    authorization.action !== 'realm:approve_claim' ||
    authorization.resource.id !== PLATFORM_RESOURCE.id ||
    authorization.resource.route !== PLATFORM_RESOURCE.route ||
    !command.basis ||
    command.basis.actorAccountId === null ||
    routeOf(resource.id) !== resource.route ||
    routeOf(resource.id) === null ||
    command.partition !== partitionOf(resource.route) ||
    routeOf(claimantAccountId) === null ||
    !roles?.roles.has(REALM_OWNER_ROLE) ||
    roles.types.get('community.realm')?.owner !== REALM_OWNER_ROLE
  )
    throw new GrantDeniedError();
  const key = { route: resource.route, resource_id: resource.id };
  // The ordinary native owner writer and last-holder guard lock this same anchor.
  if (!(await lock.run(tx, key))) throw new GrantDeniedError();
  const at = authoritativeTimeValue(command.time);
  // Missing installation/frontier or a due transition is unknown, never no owners.
  // The exclusive frontier lock serializes every native role writer through commit.
  const [coverage] = await frontier.run(tx, { ...key, at });
  if (!coverage?.ready) throw new AccessUnavailableError('overloaded');
  await shareAccount(tx, claimantAccountId);
  // Finite current owner intervals also block takeover. Group subjects are not
  // explicit owners; temporal history is excluded by the native indexed predicate.
  if ((await holders.run(tx, { ...key, at })).held) throw new GrantDeniedError();
  const valid = `[${at},)`;
  const rows = await grant.run(tx, {
    ...key,
    subject_kind: 'identity',
    subject_id: claimantAccountId,
    subject_role: '',
    grant_role: REALM_OWNER_ROLE,
    valid,
    operation: 'create',
    previous_role: REALM_OWNER_ROLE,
    previous_valid: valid,
    transaction_id: transactionId,
  });
  if (rows.length !== 1) throw new GrantDeniedError();
}
