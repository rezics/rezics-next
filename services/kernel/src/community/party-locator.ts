import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { COMMUNITY_EVENTS } from './events.ts';
import source from './party-locator-source.sql';
import upsert from './party-locator-upsert.sql';

export const COMMUNITY_PLATFORM_BASIS = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community-erasure',
  requestedBy: null,
};
export const PARTY_LOCATOR_TYPES = [
  'com.rezics.community.realm.ban.v1',
  'com.rezics.community.realm.membership.requested.v1',
  'com.rezics.community.publication.adopted.v1',
  'com.rezics.community.publication.withdrawn.v1',
  'com.rezics.community.publication.rejected.v1',
] as const;

/** Read the authoritative source first, releasing it before any account-partition command.
 * Replays read current attribution, so a late event cannot recreate an erased identity.
 */
export function createPartyLocatorEffect(pool: Pool): Effect {
  return {
    name: 'community_party_locator',
    types: [...PARTY_LOCATOR_TYPES],
    async run(event) {
      const type = event.type as (typeof PARTY_LOCATOR_TYPES)[number];
      if (!PARTY_LOCATOR_TYPES.includes(type) || !Value.Check(COMMUNITY_EVENTS[type], event.data))
        throw new TypeError('Invalid community party locator source');
      const data = event.data as {
        realmId: string;
        accountId?: string;
        operationId?: string;
        publicationId?: string;
        at?: string;
      };
      const id = data.operationId ?? data.publicationId ?? data.realmId;
      const route = routeOf(id);
      if (
        route === null ||
        routeOf(data.realmId) !== route ||
        event.subject !== data.realmId ||
        !event.source.startsWith(`urn:rezics:log:${partitionOf(route)}.`)
      )
        throw new TypeError('Invalid community party locator envelope');
      const kind = data.operationId ? 'membership_operation' : data.publicationId ? 'verdict' : 'ban';
      const keys = await withConnection(pool, async (client) => {
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved') throw new Error('Community partition is unavailable');
        return source.run(client, { route, id, kind, target: data.accountId ?? null, at: data.at ?? null });
      });
      for (const row of keys) {
        const accountRoute = routeOf(row.account_id);
        if (accountRoute === null) throw new TypeError('Invalid community party identity');
        await runCommand(
          pool,
          { partition: partitionOf(accountRoute), basis: COMMUNITY_PLATFORM_BASIS },
          async (tx) => {
            const parameters = { ...row, route: accountRoute };
            const inserted = await tx.query(
              upsert.sql,
              upsert.params.map((name) => parameters[name]),
            );
            if (inserted.rowCount === 0) return noEffect(null);
            return {
              value: null,
              events: [
                {
                  type: 'com.rezics.community.party-locator.projected.v1',
                  subject: row.account_id,
                  data: { accountId: row.account_id },
                },
              ],
            };
          },
        );
      }
    },
  };
}
