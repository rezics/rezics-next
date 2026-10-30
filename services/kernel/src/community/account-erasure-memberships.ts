import type { Pool } from 'pg';
import { createRealmOwnershipCommands, type RealmErasureSuccessionResult } from '../access/realm-ownership.ts';
import { noEffect, runCommand, type CommandOutcome } from '../command/command.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';

/** One Realm segment for the membership producer's retained owner locator.
 * The locator selects work only: Accounts prepares the genuine committed root
 * before Realm checkout, authorizes it and applies grants plus Content state in
 * that same writer. Pending results retain the locator and its page position.
 */
export async function eraseAccountRealmOwnership(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  input: Readonly<{ realmId: string; accountId: string }>,
  context: Readonly<{ deadline: number }>,
): Promise<CommandOutcome<RealmErasureSuccessionResult>> {
  const route = routeOf(input.realmId);
  if (route === null || routeOf(input.accountId) === null) throw new TypeError('Invalid Realm erasure locator');
  const commands = createRealmOwnershipCommands(deps);
  return runCommand(
    deps.pool,
    {
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization: commands.erasureSuccessionAuthorization({
        resource: { route, id: input.realmId },
        accountId: input.accountId,
      }),
    },
    async (tx) => noEffect(await commands.applyErasureSuccession(tx)),
  );
}

/** Provisional consumer contract; the membership producer owns the cursor and page implementation. */
export type MembershipErasureCursor = string;

export async function eraseAccountMembershipsPage(
  _deps: { pool: Pool },
  _accountId: string,
  _after: MembershipErasureCursor | null,
): Promise<{ next: MembershipErasureCursor | null; found: number; pending: number }> {
  const error = new Error('Community erasure phase unavailable: membership producer has not landed');
  error.name = 'CommunityErasureProducerUnavailableError';
  throw error;
}
