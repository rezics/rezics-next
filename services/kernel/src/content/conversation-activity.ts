import { Value } from 'typebox/value';
import type { Pool } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { CommandUnavailableError, runCommand } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, type ContentEventType } from './events.ts';
import type { AnchoredPosition } from './model.ts';
import page from './conversation-activity-page.sql';
import upsert from './conversation-activity-upsert.sql';
import sourceActivity from './read-source-activity.sql';
import sourceEvent from './read-outbox-event-index.sql';

const publication = 'com.rezics.content.post.published.v1';
const sourceTypes = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.revision.created.v1',
  publication,
  'com.rezics.content.post.erased.v1',
  'com.rezics.content.post.restored.v1',
  'com.rezics.content.moderation.takedown.v1',
  'com.rezics.content.moderation.restored.v1',
  'com.rezics.content.moderation.erasure.v1',
] as const satisfies readonly ContentEventType[];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CONVERSATION_ACTIVITY_SOURCE_LIMIT = 32;
export const CONVERSATION_ACTIVITY_BATCH_LIMIT = 100;

/** Internal candidates only. Neither a timestamp nor a length is a disclosed figure. */
export type ConversationContributionSource = Readonly<{
  postId: string;
  authorId: string;
  opening: boolean;
  contributedAt: string;
}>;
export type ConversationActivitySource = Readonly<{
  threadId: string;
  coverage: 'unproven';
  contributions: readonly ConversationContributionSource[];
  /** A full prefix may have more rows; this is not an exact count. */
  more: boolean;
  anchor: AnchoredPosition;
}>;

function route(id: string): number {
  const value = routeOf(id);
  if (!uuid.test(id) || value === null) throw new TypeError('Invalid conversation activity identity');
  return value;
}

function source(event: CloudEvent, id: string) {
  const match = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const epoch = Number(match?.[2]);
  const partition = partitionOf(route(id));
  if (
    !match || Number(match[1]) !== partition || !Number.isSafeInteger(epoch) || epoch > 2147483647 ||
    !uuid.test(event.id) || event.specversion !== '1.0' || event.datacontenttype !== 'application/json' ||
    !/^\d{19}$/.test(event.sequence) || BigInt(event.sequence) < 1n || BigInt(event.sequence) > 9223372036854775807n
  ) throw new TypeError('Invalid conversation activity source envelope');
  return { partition, epoch, position: BigInt(event.sequence) };
}

type Targets = Readonly<{ postIds: readonly string[]; threadId?: string; contributedAt: string | null }>;
function targets(event: CloudEvent): Targets {
  if (!sourceTypes.includes(event.type as (typeof sourceTypes)[number]))
    throw new TypeError('Unsupported conversation activity event');
  const type = event.type as (typeof sourceTypes)[number];
  if (!Value.Check(CONTENT_EVENTS[type], event.data)) throw new TypeError('Invalid conversation activity payload');
  const data = event.data as Record<string, unknown>;
  if (type === 'com.rezics.content.moderation.erasure.v1')
    return { postIds: data.postIds as string[], threadId: data.threadId as string, contributedAt: null };
  if (type === 'com.rezics.content.moderation.takedown.v1' || type === 'com.rezics.content.moderation.restored.v1')
    return { postIds: data.targetKind === 'post' ? [data.targetId as string] : [], contributedAt: null };
  if ('postId' in data) return { postIds: [data.postId as string], contributedAt: null };
  return {
    postIds: [data.itemId as string], threadId: data.threadId as string,
    contributedAt: type === publication ? data.activityAt as string : null,
  };
}

class UnchangedActivity extends Error {}

/** Registered alongside board ranking, using its native source snapshot and
 * lifecycle. This is source maintenance, never an Access or disclosure engine. */
export function createConversationActivityEffect(pool: Pool): Effect {
  return {
    name: 'content_conversation_activity',
    types: [...sourceTypes],
    async run(event) {
      const input = targets(event);
      if (!input.postIds.length) return;
      const identity = source(event, input.postIds[0]!);
      for (const id of input.postIds)
        if (partitionOf(route(id)) !== identity.partition) throw new TypeError('Foreign conversation activity target');
      if (input.threadId && partitionOf(route(input.threadId)) !== identity.partition)
        throw new TypeError('Foreign conversation activity thread');
      if (input.contributedAt !== null && !Number.isFinite(Date.parse(input.contributedAt)))
        throw new TypeError('Invalid contribution time');
      try {
        await runCommand(pool, { partition: identity.partition }, async (tx) => {
          // Proof is the exact bounded outbox envelope, not a caller-supplied
          // timestamp or the current wording's revision time.
          const proof = await sourceEvent.run(tx, {
            partition_no: identity.partition, epoch: identity.epoch, position: identity.position,
            id: event.id, type: event.type, subject: event.subject ?? null, data: event.data,
          });
          if (proof.length !== 1 || proof[0]!.event_count > 1000)
            throw new TypeError('Conversation activity event has no native source');
          const changed: string[] = [];
          for (const postId of input.postIds) {
            const postRoute = route(postId);
            const found = await tx.query<{ thread_id: string }>(
              'SELECT thread_id FROM content.post WHERE route = $1 AND post_id = $2', [postRoute, postId],
            );
            const threadId = found.rows[0]?.thread_id;
            if (!threadId) {
              // Physical purge can race a delayed lifecycle effect. Retire any
              // retained episode without reconstructing an erased contribution.
              const retired = await tx.query(
                'UPDATE content.conversation_activity_episode SET native_eligible = false WHERE route = $1 AND post_id = $2 AND native_eligible RETURNING post_id',
                [postRoute, postId],
              );
              if (retired.rowCount) changed.push(postId);
              continue;
            }
            if (input.threadId && input.threadId !== threadId) throw new TypeError('Conversation activity thread mismatch');
            const current = await sourceActivity.run(tx, { route: postRoute, thread_id: threadId, post_id: postId });
            if (!current?.post_id || !current.author_account_id || !current.security_revision)
              throw new Error('Conversation activity source post is unavailable');
            const eligible = current.post_availability === 'available' && current.head_availability === 'available' &&
              !current.author_erased && ['published', 'protected'].includes(current.post_visibility!);
            const parameters = {
              route: postRoute, post_id: postId, thread_id: threadId, author_id: current.author_account_id,
              opening: current.first_post_id === postId, contributed_at: input.contributedAt,
              eligible, security_revision: BigInt(current.security_revision),
              source_epoch: identity.epoch, source_position: identity.position,
            };
            const rows = await tx.query(upsert.sql, upsert.params.map((name) => parameters[name as keyof typeof parameters]));
            if (rows.rowCount) changed.push(postId);
          }
          if (!changed.length) throw new UnchangedActivity();
          return {
            value: null,
            events: [{
              type: 'com.rezics.content.conversation-activity.projected.v1',
              data: { postIds: changed, sourceEpoch: identity.epoch, sourcePosition: identity.position.toString() },
            }],
          };
        });
      } catch (error) {
        if (!(error instanceof UnchangedActivity)) throw error;
      }
    },
  };
}

/** Trusted native producer seam. Group by represented home and release each
 * snapshot before any caller starts independent current-disclosure hydration. */
export async function readConversationActivitySources(
  pool: Pool,
  threadIds: readonly string[],
  deadline: number,
): Promise<readonly ConversationActivitySource[]> {
  // Bound raw input before deduplication, JSON encoding or pool work.
  if (threadIds.length > CONVERSATION_ACTIVITY_BATCH_LIMIT) throw new RangeError('Conversation activity accepts at most 100 raw keys');
  const groups = new Map<number, { route: number; thread_id: string }[]>();
  const unique = [...new Set(threadIds)];
  for (const id of unique) {
    const home = route(id);
    const partition = partitionOf(home);
    const keys = groups.get(partition) ?? [];
    keys.push({ route: home, thread_id: id });
    groups.set(partition, keys);
  }
  const result = new Map<string, ConversationActivitySource>();
  for (const [partitionNo, keys] of groups) {
    const selected = await within(deadline, () => withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const partition = await readPartition(client, partitionNo);
        if (!partition) throw new CommandUnavailableError('deadline', partitionNo);
        if (partition.writeState === 'moved') throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
        const rows = await page.run(client, { keys: JSON.stringify(keys), limit: CONVERSATION_ACTIVITY_SOURCE_LIMIT });
        await client.query('COMMIT');
        return { rows, anchor: { partition, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try { await connection.query('ROLLBACK'); } catch (rollbackError) { discardConnection(connection, rollbackError as Error); }
        throw error;
      }
    }));
    const contributions = new Map<string, ConversationContributionSource[]>();
    for (const row of selected.rows) {
      const entries = contributions.get(row.thread_id) ?? [];
      entries.push({
        postId: row.post_id, authorId: row.author_account_id, opening: row.opening,
        contributedAt: row.contributed_at!.replace(/(\.\d{3})000Z$/, '$1Z'),
      });
      contributions.set(row.thread_id, entries);
    }
    for (const key of keys) {
      const entries = contributions.get(key.thread_id) ?? [];
      result.set(key.thread_id, {
        threadId: key.thread_id, coverage: 'unproven', contributions: entries,
        more: entries.length === CONVERSATION_ACTIVITY_SOURCE_LIMIT, anchor: selected.anchor,
      });
    }
  }
  return unique.map((id) => result.get(id)!);
}
