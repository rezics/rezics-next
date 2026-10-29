import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { COMMUNITY_EVENTS } from './events.ts';
import realmAuthor from './revision-locator-read-realm.sql';
import spaceAuthor from './revision-locator-read-space.sql';
import insert from './revision-locator-insert.sql';

const types = [
  'com.rezics.community.realm.created.v1',
  'com.rezics.community.realm.updated.v1',
  'com.rezics.community.space.created.v1',
  'com.rezics.community.space.updated.v1',
  'com.rezics.community.space.address-changed.v1',
] as const;

/** Resolve one immutable revision on its owner route, release it, then index in its author's partition. */
export function createRevisionLocatorEffect(pool: Pool): Effect {
  return {
    name: 'community_revision_locator',
    types: [...types],
    async run(event) {
      const type = event.type as (typeof types)[number];
      if (!types.includes(type) || !Value.Check(COMMUNITY_EVENTS[type], event.data))
        throw new TypeError('Invalid revision locator source payload');
      const data = event.data as { realmId?: string; spaceId?: string; revisionId: string };
      const ownerId = data.realmId ?? data.spaceId!;
      const ownerRoute = routeOf(ownerId);
      const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
      if (
        ownerRoute === null ||
        routeOf(data.revisionId) !== ownerRoute ||
        !source ||
        Number(source[1]) !== partitionOf(ownerRoute) ||
        !Number.isSafeInteger(Number(source[2])) ||
        Number(source[2]) > 2147483647 ||
        !/^\d{19}$/.test(event.sequence) ||
        BigInt(event.sequence) < 1n ||
        BigInt(event.sequence) > 9223372036854775807n ||
        event.subject !== ownerId
      )
        throw new TypeError('Invalid revision locator source envelope');
      const kind = data.realmId ? 'realm' : 'space';
      const author = await withConnection(pool, async (client) => {
        const anchor = await readPartition(client, partitionOf(ownerRoute));
        if (!anchor || anchor.writeState === 'moved') throw new Error('Revision partition is unavailable');
        const statement = kind === 'realm' ? realmAuthor : spaceAuthor;
        return statement.run(client, { route: ownerRoute, owner_id: ownerId, revision_id: data.revisionId });
      });
      if (!author) throw new Error('Committed community revision is missing');
      const route = routeOf(author.author);
      if (route === null) throw new TypeError('Invalid revision author identity');
      await runCommand(
        pool,
        {
          partition: partitionOf(route),
          receipt: {
            actorAccountId: '00000000-0000-4000-8000-000000000001',
            kind: 'community.revision-locator.project',
            key: event.id,
            digest: createHash('sha256')
              .update(
                JSON.stringify([event.source, event.sequence, event.id, kind, ownerId, data.revisionId, author.author]),
              )
              .digest(),
          },
        },
        async (tx) => {
          const parameters = {
            route,
            account_id: author.author,
            kind,
            owner_route: ownerRoute,
            owner_id: ownerId,
            revision_id: data.revisionId,
          };
          const result = await tx.query(
            insert.sql,
            insert.params.map((name) => parameters[name as keyof typeof parameters]),
          );
          if (result.rowCount === 0) return noEffect(null);
          return {
            value: null,
            events: [
              {
                type: 'com.rezics.community.revision-locator.indexed.v1',
                subject: author.author,
                data: { accountId: author.author, found: 1 },
              },
            ],
          };
        },
      );
    },
  };
}
