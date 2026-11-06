import type { AccessClient } from '../request/access.ts';
import { readAccount } from '../access/account-data.ts';
import { routeOf } from '../route/route.ts';
import head from './resource-head.sql';
import keys from './resource-owner-keys.sql';
import owner from './resource-owner-evidence.sql';
import { zoneHeadFromRow, type ZoneHead } from './resource-head.ts';

export { compareAndSetZone, insertZone, lockZoneHead, zoneHeadFromRow, type ZoneHead } from './resource-head.ts';

export async function readZoneHead(client: AccessClient, route: number, id: string): Promise<ZoneHead | null> {
  const row = await head.run(client, { route, id });
  return row ? zoneHeadFromRow(row) : null;
}

/** Public Zone payload remains eligible only while its native owner account is live. */
export async function zoneOwnerIsActive(client: AccessClient, row: ZoneHead): Promise<boolean> {
  if (!row.ownerId) return false;
  const owner = await readAccount(client, routeOf(row.ownerId)!, row.ownerId);
  return owner?.state === 'active' && !owner.fenced;
}

export function ownerZoneKeys(
  client: AccessClient,
  input: {
    route: number;
    owner_id: string;
    state: string;
    after: string;
    limit: number;
  },
) {
  return keys.run(client, input);
}

/** Current ordinary role evidence only; native Access still decides every action and actor admission. */
export async function hasZoneOwnerRole(client: AccessClient, route: number, id: string, accountId: string, at: string) {
  return (await owner.run(client, { route, id, account_id: accountId, at })) !== null;
}
