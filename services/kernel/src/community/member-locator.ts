import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { COMMUNITY_EVENTS } from '../events/contracts/community.ts';
import { memberLocatorQuery } from './member-locator-query.ts';
import pending from './member-locator-pending.sql';
import upsert from './member-locator-upsert.sql';
import settle from './member-locator-settle.sql';

const sourceType = 'com.rezics.community.realm.membership.v1';
const terminalType = 'com.rezics.community.realm.membership.terminalized.v1';
const projectorId = '00000000-0000-4000-8000-000000000001';

/** Source checkouts end before the account command; source acknowledgement is a third checkout. */
export function createMemberLocatorEffect(pool: Pool): Effect {
  return {
    name: 'community_member_locator',
    types: [sourceType, terminalType],
    async run(event) {
      if (
        (event.type !== sourceType && event.type !== terminalType) ||
        !Value.Check(COMMUNITY_EVENTS[event.type], event.data)
      )
        throw new TypeError('Invalid member locator source event');
      const data = event.data as {
        realmId: string;
        accountId: string;
        transactionId: string;
      };
      const realmRoute = routeOf(data.realmId)!;
      const accountRoute = routeOf(data.accountId)!;
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (!source || Number(source[1]) !== partitionOf(realmRoute) || event.subject !== data.realmId)
        throw new TypeError('Invalid member locator source envelope');
      const args = {
        route: realmRoute,
        account_id: data.accountId,
        realm_id: data.realmId,
        transaction_id: data.transactionId,
      };
      const outstanding = await withConnection(pool, async (client) => {
        const anchor = await readPartition(client, partitionOf(realmRoute));
        if (!anchor || anchor.writeState === 'moved') throw new Error('Membership partition is unavailable');
        return (await memberLocatorQuery(client, pending, args)).rowCount;
      });
      // Backfilled and already acknowledged intervals need no replayed locator.
      if (!outstanding) return;
      await runCommand(
        pool,
        {
          partition: partitionOf(accountRoute),
          receipt: {
            actorAccountId: projectorId,
            kind: 'community.member-locator.project',
            key: event.id,
            digest: createHash('sha256')
              .update(JSON.stringify([event.source, event.sequence, event.id, event.data]))
              .digest(),
          },
        },
        async (tx) => {
          const written = await memberLocatorQuery(tx, upsert, {
            route: accountRoute,
            account_id: data.accountId,
            realm_route: realmRoute,
            realm_id: data.realmId,
          });
          if (!written.rowCount) return noEffect(null);
          return {
            value: null,
            events: [
              {
                type: 'com.rezics.community.member-locator.projected.v1',
                subject: data.accountId,
                data: { accountId: data.accountId, realmId: data.realmId },
              },
            ],
          };
        },
      );
      await runCommand(pool, { partition: partitionOf(realmRoute) }, async (tx) => {
        const removed = await memberLocatorQuery(tx, settle, args);
        if (!removed.rowCount) return noEffect(null);
        return {
          value: null,
          events: [
            {
              type: 'com.rezics.community.member-locator.settled.v1',
              subject: data.realmId,
              data: { accountId: data.accountId, realmId: data.realmId, transactionId: data.transactionId },
            },
          ],
        };
      });
    },
  };
}
