import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError, GrantDeniedError } from '../access/contract/errors.ts';
import accountShare from '../access/account-share.sql';
import { readAccountCommandState } from './access-port.ts';
import { withFollowCountReadConnection } from './adapters/follow-count-observation.ts';
import { readPartition } from '../partition/partition.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { followAccountShareWork, followAccountWork, consumeFollowWork } from './follow-operation-bounds.ts';

type QueryClient = Pick<PoolClient, 'query'>;

/** Current owner identity and home captured before a private Follow selection. */
export type FollowReadAdmission = Readonly<{
  accountId: string;
  authnEpoch: number;
  route: number;
  partition: number;
  epoch: number;
}>;

function requireOwner(actor: Actor): AccountActor {
  if (
    actor.kind !== 'account' ||
    routeOf(actor.accountId) === null ||
    !Number.isSafeInteger(actor.authnEpoch) ||
    actor.authnEpoch < 1
  )
    throw new GrantDeniedError();
  return actor;
}

async function readCurrentOwnerHome(client: QueryClient, owner: AccountActor): Promise<FollowReadAdmission> {
  const route = routeOf(owner.accountId)!;
  const partition = partitionOf(route);

  await followReadAdmissionLock(client, owner);
  const current = await consumeFollowWork('read-owner', followAccountWork(owner.accountId), () =>
    readAccountCommandState(client, route, owner.accountId),
  );
  if (
    !current ||
    current.kind !== 'actor' ||
    current.state !== 'active' ||
    current.fenced ||
    current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
  )
    throw new GrantDeniedError();

  const home = await readPartition(client, partition);
  if (!home || home.writeState !== 'active' || home.movedTo !== null)
    throw new CommandUnavailableError('fenced', partition);
  return Object.freeze({
    accountId: owner.accountId,
    authnEpoch: owner.authnEpoch,
    route,
    partition,
    epoch: home.epoch,
  });
}

/** Recheck Access and the native owner home without holding either checkout for foreign work. */
export async function admitPrivateFollowRead(
  pool: Pool,
  actor: Actor,
  deadline: number,
  expected?: FollowReadAdmission,
): Promise<FollowReadAdmission> {
  const owner = requireOwner(actor);
  if (
    expected &&
    (expected.accountId !== owner.accountId ||
      expected.authnEpoch !== owner.authnEpoch ||
      expected.route !== routeOf(owner.accountId))
  )
    throw new GrantDeniedError();

  return withFollowCountReadConnection(pool, deadline, async (client) => {
    await client.query('BEGIN');
    const admitted = await readCurrentOwnerHome(client, owner);
    if (expected && admitted.epoch !== expected.epoch) throw new CommandUnavailableError('fenced', admitted.partition);
    await client.query('COMMIT');
    return admitted;
  });
}

/** Account share lock footprint for the current owner witness used by each read fence. */
function followReadAdmissionLock(client: QueryClient, owner: AccountActor): Promise<unknown> {
  const route = routeOf(owner.accountId)!;
  return consumeFollowWork('read-owner-lock', followAccountShareWork(owner.accountId), () =>
    accountShare.run(client, { route, account_id: owner.accountId }),
  );
}
