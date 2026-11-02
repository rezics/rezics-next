import { authoritativeTimeValue, type AuthoritativeTime, type CommandTransaction } from '../command/command.ts';
import type { Resource } from '../request/access.ts';
import readRole from './ban-role.sql';

export class RealmBanRoleError extends Error {
  constructor() {
    super('Remove the Realm owner or moderator role first');
    this.name = 'RealmBanRoleError';
  }
}

/** Private invariant data, after admission on this Realm. Recheck at each writer's T:
 * acceptance cannot protect a role granted while removal is queued.
 * Two exact role keys keep this independent of Realm size and membership history.
 */
export async function assertRealmBanTarget(
  tx: CommandTransaction,
  input: { resource: Resource; accountId: string; at: AuthoritativeTime },
): Promise<void> {
  if (
    (
      await readRole.run(tx, {
        route: input.resource.route,
        realm_id: input.resource.id,
        account_id: input.accountId,
        at: authoritativeTimeValue(input.at),
      })
    )?.protected
  )
    throw new RealmBanRoleError();
}
