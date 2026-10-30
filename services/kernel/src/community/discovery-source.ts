import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { authoritativeTimeValue, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { realmReadEligibility } from './realm.ts';
import { spaceReadEligibility } from './space.ts';
import read from './discovery-source-read.sql';

/** Original qualification evidence only. This is not a current disclosure/fence decision. */
export type RealmDiscoveryBinding = Readonly<{
  realmId: string;
  spaceId: string;
  realmEpoch: string;
}>;

/** Released exact Realm and host reads at the originating command's T. Anonymous
 * Access checks are independent of the initiating account's grants/membership.
 * Never call while holding a source command transaction or another home.
 */
export async function prepareRealmDiscoverySource(
  deps: Readonly<{ pool: Pool; access: Access }>,
  realmId: string,
  time: AuthoritativeTime,
  deadline: number,
): Promise<RealmDiscoveryBinding | null> {
  const route = routeOf(realmId);
  if (route === null) return null;
  const realm = { route, id: realmId };
  const context = { pool: deps.pool, deadline };
  const realmCheck = await accessCheck(
    deps.access,
    { kind: 'anonymous' },
    'realm:read',
    { ...realm, eligibility: realmReadEligibility(realm) },
    context,
  );
  const current = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const partition = await readPartition(client, partitionOf(route));
      if (!partition || partition.writeState === 'moved') return null;
      const row = await read.run(client, { route, realm_id: realmId, at: authoritativeTimeValue(time) });
      return row && (await realmCheck(client, time)) ? row : null;
    }),
  );
  if (!current) return null;
  const spaceRoute = routeOf(current.space_id);
  if (spaceRoute === null) return null;
  const space = { route: spaceRoute, id: current.space_id };
  const spaceCheck = await accessCheck(
    deps.access,
    { kind: 'anonymous' },
    'space:read',
    { ...space, eligibility: spaceReadEligibility(space) },
    context,
  );
  const readable = await within(deadline, () =>
    withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      const partition = await readPartition(client, partitionOf(spaceRoute));
      return !!partition && partition.writeState !== 'moved' && (await spaceCheck(client, time));
    }),
  );
  return readable ? Object.freeze({ realmId, spaceId: current.space_id, realmEpoch: current.realm_epoch }) : null;
}
