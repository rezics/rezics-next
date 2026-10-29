import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventData } from './events.ts';
import upsert from './author-item-upsert.sql';
import remove from './author-item-delete.sql';
import readAuthor from './author-item-read-author.sql';
import readRestored from './author-item-read-restored.sql';

const threadCreated = 'com.rezics.content.thread.created.v1';
const postCreated = 'com.rezics.content.post.created.v1';
const postErased = 'com.rezics.content.post.erased.v1';
const postRestored = 'com.rezics.content.post.restored.v1';
const sourceTypes = [threadCreated, postCreated, postErased, postRestored] as const;
const projectorId = '00000000-0000-4000-8000-000000000001';
const maxPosition = 9_223_372_036_854_775_807n;
class UnchangedAuthorItem extends Error {}

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new TypeError('Invalid routed author item identity');
  return value;
}

function parse(event: CloudEvent) {
  if (!sourceTypes.includes(event.type as (typeof sourceTypes)[number]))
    throw new TypeError('Unsupported author item source event');
  const type = event.type as (typeof sourceTypes)[number];
  if (!Value.Check(CONTENT_EVENTS[type], event.data)) throw new TypeError('Invalid author item source payload');
  const data = event.data as ContentEventData<typeof type>;
  const creation = 'threadId' in data ? data : null;
  const id = creation ? creation.itemId : (data as ContentEventData<typeof postErased>).postId;
  const sourceRoute = route(id);
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(source?.[2]);
  const position = /^\d{19}$/.test(event.sequence) ? BigInt(event.sequence) : 0n;
  if (
    !source ||
    Number(source[1]) !== partitionOf(sourceRoute) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    epoch > 2_147_483_647 ||
    position <= 0n ||
    position > maxPosition ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id) ||
    (creation ? event.subject !== id && event.subject !== creation.threadId : event.subject !== id) ||
    (creation &&
      (route(creation.threadId) !== sourceRoute ||
        route(creation.revisionId) !== sourceRoute ||
        !Number.isFinite(Date.parse(creation.activityAt))))
  )
    throw new TypeError('Invalid author item source envelope');
  if (creation) {
    route(creation.actorId);
    route(creation.placeId);
    for (const subject of creation.subjectIds) route(subject);
  }
  return { creation, id, sourceRoute, epoch, position };
}

/** One author-partition command per creation, erasure or restoration; source checkouts are released first. */
export function createAuthorItemEffect(pool: Pool): Effect {
  return {
    name: 'content_author_item',
    types: [...sourceTypes],
    async run(event) {
      const change = parse(event);
      const { creation, epoch, position } = change;
      const restored =
        event.type === postRestored
          ? await withConnection(pool, async (client) => {
              const anchor = await readPartition(client, partitionOf(change.sourceRoute));
              if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
              return readRestored.run(client, { route: change.sourceRoute, post_id: change.id });
            })
          : null;
      if (event.type === postRestored && !restored) return;
      const authorId = restored
        ? restored.author_account_id
        : creation
          ? creation.actorId
          : await withConnection(pool, async (client) => {
              const anchor = await readPartition(client, partitionOf(change.sourceRoute));
              if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
              return (await readAuthor.run(client, { route: change.sourceRoute, post_id: change.id }))
                ?.author_account_id;
            });
      if (!authorId) return;
      const authorRoute = route(authorId);
      const itemKind = event.type === threadCreated ? 'thread' : 'post';
      const itemId = event.type === threadCreated ? creation!.threadId : change.id;
      const parameters = {
        route: authorRoute,
        author_account_id: authorId,
        item_kind: itemKind,
        item_id: itemId,
        thread_id: restored?.thread_id ?? creation?.threadId,
        thread_kind: restored?.kind ?? creation?.kind,
        created_at: restored?.created_at ?? creation?.activityAt,
        source_epoch: epoch,
        source_position: position.toString(),
      };
      const digest = createHash('sha256')
        .update(JSON.stringify([event.source, event.sequence, event.id, event.type, event.data]))
        .digest();
      try {
        await runCommand(
          pool,
          {
            partition: partitionOf(authorRoute),
            receipt: { actorAccountId: projectorId, kind: 'content.author-item.project', key: event.id, digest },
          },
          async (tx) => {
            const statement = creation || restored ? upsert : remove;
            const result = await tx.query(
              statement.sql,
              statement.params.map((name) => parameters[name as keyof typeof parameters]),
            );
            if (result.rowCount === 0) throw new UnchangedAuthorItem();
            return {
              value: null,
              events: [
                {
                  type: 'com.rezics.content.author-item.projected.v1',
                  subject: authorId,
                  data: {
                    authorAccountId: authorId,
                    itemKind,
                    itemId,
                    sourceEpoch: epoch,
                    sourcePosition: position.toString(),
                  },
                },
              ],
            };
          },
        );
      } catch (error) {
        if (!(error instanceof UnchangedAuthorItem)) throw error;
      }
    },
  };
}
