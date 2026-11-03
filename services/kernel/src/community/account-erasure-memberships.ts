import type { Pool } from 'pg';
import { createRealmOwnershipCommands, type RealmErasureSuccessionResult } from '../access/realm-ownership.ts';
import { authoritativeTimeValue, noEffect, runCommand, type CommandOutcome } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Access } from '../request/access.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { memberLocatorQuery } from './member-locator-query.ts';
import obligation from './account-erasure-memberships-obligation.sql';
import page from './member-locator-page.sql';
import close from './account-erasure-memberships-close.sql';
import purge from './account-erasure-memberships-purge.sql';
import unlink from './account-erasure-memberships-unlink.sql';
import status from './account-erasure-memberships-status.sql';

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

/** Internal platform phase, authorized by the permanent terminal erasure obligation.
 * Every checkout ends before entering another partition. Source intents prevent
 * completion before delayed interval events have published their locators.
 * Pending counts up to 50 outstanding source events per call.
 */
export type MembershipErasureCursor = string;

const beginning = '00000000-0000-0000-0000-000000000000';

/** Accounts must distinguish ordinary membership from an owner at the immutable
 * root (or durable replay). Neither a locator nor a generic authorization denial
 * supplies that distinction. Keep the locator if this native port is unavailable.
 */
async function qualifiesForSuccession(
  deps: { pool: Pool; access: Access; clock?: () => Date },
  input: Readonly<{ realmId: string; accountId: string }>,
  context: Readonly<{ deadline: number }>,
): Promise<boolean> {
  const commands: ReturnType<typeof createRealmOwnershipCommands> & {
    qualifyErasureSuccession?(
      input: Readonly<{ resource: { route: number; id: string }; accountId: string }>,
      context: Readonly<{ deadline: number }>,
    ): Promise<'owner-or-replay' | 'not-owner'>;
  } = createRealmOwnershipCommands(deps);
  if (!commands.qualifyErasureSuccession)
    throw new Error('Accounts Realm erasure owner qualification is unavailable');
  const qualification = await commands.qualifyErasureSuccession(
    { resource: { route: routeOf(input.realmId)!, id: input.realmId }, accountId: input.accountId },
    context,
  );
  if (qualification === 'not-owner') return false;
  if (qualification === 'owner-or-replay') return true;
  throw new TypeError('Invalid Accounts Realm erasure owner qualification');
}

export async function eraseAccountMembershipsPage(
  deps: { pool: Pool; access?: Access; clock?: () => Date; deadline?: number },
  accountId: string,
  after: MembershipErasureCursor | null,
): Promise<{ next: MembershipErasureCursor | null; found: number; pending: number }> {
  const { pool, access, clock } = deps;
  const route = routeOf(accountId);
  if (route === null || (after !== null && after !== beginning && routeOf(after) === null))
    throw new TypeError('Invalid account membership erasure key');
  const args = { route, account_id: accountId };
  const keys = await withConnection(pool, async (client) => {
    const anchor = await readPartition(client, partitionOf(route));
    if (!anchor || anchor.writeState === 'moved') throw new Error('Account partition is unavailable');
    if (!(await memberLocatorQuery(client, obligation, args)).rowCount)
      throw new Error('Membership erasure requires a committed terminal account erasure');
    return (await memberLocatorQuery<{ realm_route: number; realm_id: string }>(client, page, { ...args, after })).rows;
  });
  const completedKeys: string[] = [];
  let pendingOwners = 0;
  // One fixed wall deadline bounds the whole raw page. Command timestamps use
  // the installed trusted clock; the durable root determines the orphan instant.
  const deadline = deps.deadline ?? Date.now() + 60_000;
  if (!Number.isFinite(deadline)) throw new TypeError('Invalid membership erasure deadline');
  for (const key of keys) {
    if (!access) throw new Error('Membership erasure requires installed worker Access');
    const native = { pool, access, ...(clock === undefined ? {} : { clock }) };
    const input = { realmId: key.realm_id, accountId };
    if (await qualifiesForSuccession(native, input, { deadline })) {
      const result = await eraseAccountRealmOwnership(native, input, { deadline });
      if (result.value.status === 'pending') {
        pendingOwners++;
        continue;
      }
    }
    await runCommand(pool, { partition: partitionOf(key.realm_route), clock, deadline }, async (tx, command) => {
      const realmArgs = {
        route: key.realm_route,
        realm_id: key.realm_id,
        account_id: accountId,
        at: authoritativeTimeValue(command.time),
        transaction_id: command.transactionId,
      };
      await memberLocatorQuery(tx, close, realmArgs);
      await memberLocatorQuery(tx, purge, realmArgs);
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.community.realm.memberships-erased.v1',
            subject: key.realm_id,
            data: { accountId, realmId: key.realm_id, at: realmArgs.at, transactionId: command.transactionId },
          },
        ],
      };
    });
    completedKeys.push(key.realm_id);
  }
  if (completedKeys.length) {
    await runCommand(pool, { partition: partitionOf(route), clock, deadline }, async (tx) => {
      await memberLocatorQuery(tx, unlink, { ...args, realm_ids: completedKeys });
      return {
        value: null,
        events: [
          {
            type: 'com.rezics.community.member-locators.erased.v1',
            subject: accountId,
            data: { accountId, realmIds: completedKeys },
          },
        ],
      };
    });
  }
  const state = await withConnection(
    pool,
    async (client) =>
      (await memberLocatorQuery<{ pending: number; first: string | null }>(client, status, args)).rows[0]!,
  );
  const last = keys.at(-1)?.realm_id ?? after ?? beginning;
  // A delayed effect can insert behind the cursor. Wrap before signalling EOF.
  return {
    next: state.first === null ? null : state.first <= last ? beginning : last,
    found: keys.length,
    pending: state.pending + pendingOwners,
  };
}
