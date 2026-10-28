import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { validResource } from './grant-command.ts';
import { ResourceAccessWriteDeniedError } from './resource-denials.ts';
import roles from './resource-roles.json';
import statement from './account-role-grant.sql';

/** Grants a catalogue role to an account on its own anchor from the caller's command T.
 * Touches one identity resource_role_grant key through the temporal GiST primary key;
 * a grant current at T is unchanged, otherwise inserts one [T, infinity) row.
 * R O(1), S 1; B O(log(2+N)) for selective temporal key probes, plus at most one
 * GiST insertion/overlap check, whose worst-case blocks have no B-tree logarithmic guarantee.
 * Requires a live command in the anchor's partition; system commands need no resource authorization.
 */
export async function grantAccountRole(
  tx: CommandTransaction,
  input: { account: Resource; role: string },
): Promise<void> {
  let command;
  try {
    command = currentCommand(tx);
  } catch {
    throw new ResourceAccessWriteDeniedError();
  }
  if (
    !validResource(input.account) ||
    partitionOf(input.account.route) !== command.partition ||
    typeof input.role !== 'string' ||
    !Object.hasOwn(roles.roles, input.role)
  )
    throw new ResourceAccessWriteDeniedError();
  const row = await statement.run(tx, {
    route: input.account.route,
    account_id: input.account.id,
    grant_role: input.role,
    at: authoritativeTimeValue(command.time),
    transaction_id: Bun.randomUUIDv7(),
  });
  if (row.outcome !== 'current' && row.outcome !== 'inserted') throw new ResourceAccessWriteDeniedError();
}
