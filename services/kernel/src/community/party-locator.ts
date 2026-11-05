import type { Pool } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import type { CommandBasis } from '../command/command.ts';
import { noEffect, runCommand } from '../command/command.ts';
import { recordLateErasureItem, resolveLateErasureItem, readErasureStatus } from '../access/erasure.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { COMMUNITY_EVENTS } from './events.ts';
import source from './party-locator-source.sql';
import upsert from './party-locator-upsert.sql';
import { lockErasureFence } from './erasure-fence.ts';
import { eraseAccountCommunityRecordItem } from './account-erasure-records.ts';

export const COMMUNITY_PLATFORM_BASIS: CommandBasis = {
  actorAccountId: '00000000-0000-8000-8000-000000000001',
  clientId: 'internal-community-erasure',
  requestedBy: null,
};
export const PARTY_LOCATOR_TYPES = [
  'com.rezics.community.space.removed.v1',
  'com.rezics.community.realm.removed.v1',
  'com.rezics.community.realm.ban.v1',
  'com.rezics.community.realm.membership.requested.v1',
  'com.rezics.community.realm.claim-requested.v1',
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
      if (!PARTY_LOCATOR_TYPES.includes(type) || !Value.Check(COMMUNITY_EVENTS()[type], event.data))
        throw new TypeError('Invalid community party locator source');
      const data = event.data as {
        realmId?: string;
        id?: string;
        kind?: 'space' | 'realm';
        accountId?: string;
        operationId?: string;
        publicationId?: string;
        requestId?: string;
        at?: string;
      };
      const ownerId = data.id ?? data.realmId;
      if (!ownerId) throw new TypeError('Community party locator has no owner');
      const id = data.operationId ?? data.publicationId ?? data.requestId ?? ownerId;
      const route = routeOf(id);
      if (
        route === null ||
        routeOf(ownerId) !== route ||
        event.subject !== ownerId ||
        !event.source.startsWith(`urn:rezics:log:${partitionOf(route)}.`)
      )
        throw new TypeError('Invalid community party locator envelope');
      const kind = data.id
        ? `${data.kind}_remover`
        : data.operationId
          ? 'membership_operation'
          : data.publicationId
            ? 'verdict'
            : data.requestId
              ? 'claim_request'
              : 'ban';
      const keys = await withConnection(pool, async (client) => {
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved') throw new Error('Community partition is unavailable');
        return source.run(client, {
          route,
          id,
          realm: ownerId,
          kind,
          target: data.accountId ?? null,
          at: data.at ?? null,
        });
      });
      for (const row of keys) {
        const accountRoute = routeOf(row.account_id);
        if (accountRoute === null) throw new TypeError('Invalid community party identity');
        if (row.due_at === null) throw new TypeError('Community party locator is missing its due time');
        const locator = `${row.kind}:${row.owner_route}:${row.owner_id}:${row.key}`;
        const result = await runCommand<{ late: boolean }>(
          pool,
          { partition: partitionOf(accountRoute), basis: COMMUNITY_PLATFORM_BASIS },
          async (tx) => {
            if (await lockErasureFence(tx, row.account_id)) {
              await recordLateErasureItem(tx, { accountId: row.account_id, participant: 'community', locator });
              return {
                value: { late: true as const },
                events: [
                  {
                    type: 'com.rezics.access.account-updated.v1',
                    subject: row.account_id,
                    data: { accountId: row.account_id },
                  },
                ],
              };
            }
            const parameters = { ...row, route: accountRoute };
            const inserted = await tx.query(
              upsert.sql,
              upsert.params.map((name) => parameters[name as keyof typeof parameters]),
            );
            if (inserted.rowCount === 0) return noEffect({ late: false as const });
            return {
              value: { late: false as const },
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
        if (result.value.late) {
          const status = await readErasureStatus(pool, row.account_id);
          if (!status) throw new Error('Community late locator has no committed account erasure');
          const key = {
            kind: row.kind,
            due_at: row.due_at,
            owner_route: row.owner_route,
            owner_id: row.owner_id,
            key: row.key,
          };
          for (;;) {
            const disposition = await eraseAccountCommunityRecordItem({ pool }, row.account_id, key, status.at, true);
            if (!disposition.pending) break;
            await DBOS.sleep(600_000);
          }
          await resolveLateErasureItem({ pool }, { accountId: row.account_id, participant: 'community', locator });
        }
      }
    },
  };
}
