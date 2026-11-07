import { jsonParameter } from '../database/json.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { lookupEventType } from '../events/catalogue.ts';
import type { CloudEvent } from '../events/log.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf } from '../route/route.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { deadlineFor } from '../request/deadline.ts';
import { createFollowActivitySource } from '../library/follow-activity.ts';
import { librarySemanticObservations } from '../library/semantic-observation.ts';
import { feedSnapshot } from './feed-snapshot.ts';
import {
  createFeedActivityStore,
  FEED_RETENTION_MS,
  feedRoute,
  type ActivityRef,
  type FeedActivityObject,
  type FeedActivityTarget,
} from './feed-activity.ts';
import readOutboxEvent from './read-outbox-event-index.sql';

export const FEED_FANOUT_WORKFLOW = 'content.feedFanout';
const cleanupWorkflow = 'content.feedRetention';
const activityTypes = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.community.publication.adopted.v1',
  'com.rezics.library.collection.updated.v1',
  'com.rezics.library.collection.member.changed.v1',
  'com.rezics.library.collection.listing.changed.v1',
];

/** Verify the original native envelope and recover its real event index. Sequence is not eventIndex. */
export async function feedEventSource(
  pool: Pool,
  event: CloudEvent,
  anchorId: string,
  deadline: number,
): Promise<ActivityRef['source']> {
  const match = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const route = feedRoute(anchorId);
  const partition = Number(match?.[1]);
  const epoch = Number(match?.[2]);
  if (
    !match ||
    partition !== partitionOf(route) ||
    !Number.isSafeInteger(epoch) ||
    epoch > 2147483647 ||
    event.specversion !== '1.0' ||
    event.datacontenttype !== 'application/json' ||
    !/^[0-9]{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > 9223372036854775807n ||
    !lookupEventType(event.type)?.Check(event.data)
  )
    throw new TypeError('Invalid native feed event');
  const position = BigInt(event.sequence);
  const eventIndex = await feedSnapshot(pool, route, deadline, async (client) => {
    const home = await readPartition(client, partition);
    if (!home || home.epoch < epoch || (home.epoch === epoch && home.position < position))
      throw new Error('Feed event source is unavailable');
    const rows = await readOutboxEvent.run(client, {
      partition_no: partition,
      position,
      epoch,
      id: event.id,
      type: event.type,
      subject: event.subject ?? null,
      data: jsonParameter(event.data),
    });
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isInteger(row.event_seq) ||
      row.event_seq < 0 ||
      row.event_seq >= row.event_count ||
      row.event_count > 1000
    )
      throw new TypeError('Feed event is not its native committed fact');
    return row.event_seq;
  });
  return { partition, epoch, position: position.toString(), eventIndex };
}

async function eventActivities(context: WorkContext, event: CloudEvent): Promise<ActivityRef[]> {
  // The catalogue check precedes interpreting any event-specific locator.
  if (!activityTypes.includes(event.type) || !lookupEventType(event.type)?.Check(event.data))
    throw new TypeError('Invalid feed event type');
  const data = event.data as Record<string, unknown>;
  const isContent = event.type.startsWith('com.rezics.content.');
  const isPublication = event.type === 'com.rezics.community.publication.adopted.v1';
  const anchor = (isContent ? data.threadId : isPublication ? data.realmId : data.collectionId) as string;
  const deadline = deadlineFor(30_000);
  const source = await feedEventSource(context.pool, event, anchor, deadline);
  const targets: FeedActivityTarget[] = [];
  let object: FeedActivityObject;
  let occurredAt: string;
  if (isContent) {
    const threadId = data.threadId as string;
    const post = event.type === 'com.rezics.content.post.created.v1';
    const id = post ? (data.itemId as string) : threadId;
    if (feedRoute(id) !== feedRoute(threadId) || feedRoute(data.revisionId as string) !== feedRoute(threadId))
      throw new TypeError('Invalid native feed content anchor');
    targets.push(...(data.subjectIds as string[]).map((id) => ({ type: 'subject' as const, id })));
    const realmId = data.placeId as string;
    const realm = await feedSnapshot(
      context.pool,
      feedRoute(realmId),
      deadline,
      async (client) =>
        (
          await client.query<{ space_id: string }>(
            "SELECT space_id FROM community.realm WHERE route=$1 AND realm_id=$2 AND state='active'",
            [feedRoute(realmId), realmId],
          )
        ).rows[0],
    );
    if (realm) targets.push({ type: 'space', id: realm.space_id });
    object = { owner: 'content', kind: post ? 'post' : 'thread', route: feedRoute(id), id, threadId };
    occurredAt = data.activityAt as string;
  } else if (isPublication) {
    const realmId = data.realmId as string;
    const realm = await feedSnapshot(
      context.pool,
      feedRoute(realmId),
      deadline,
      async (client) =>
        (
          await client.query<{ space_id: string }>(
            "SELECT space_id FROM community.realm WHERE route=$1 AND realm_id=$2 AND state='active'",
            [feedRoute(realmId), realmId],
          )
        ).rows[0],
    );
    if (!realm) return [];
    targets.push({ type: 'space', id: realm.space_id });
    const id = data.subjectId as string;
    object = {
      owner: 'semantic',
      kind: 'subject',
      route: feedRoute(id),
      id,
      realmId,
      publicationId: data.publicationId as string,
    };
    occurredAt = event.time;
  } else {
    const id = data.collectionId as string;
    const eligible = await feedSnapshot(
      context.pool,
      feedRoute(id),
      deadline,
      async (client) =>
        (
          await client.query(
            "SELECT collection_id FROM library.collection WHERE route=$1 AND collection_id=$2 AND state='active' AND visibility='public'",
            [feedRoute(id), id],
          )
        ).rows.length > 0,
    );
    if (!eligible) return [];
    targets.push({ type: 'collection', id });
    object = { owner: 'library', kind: 'collection', route: feedRoute(id), id };
    occurredAt = event.time;
  }
  return targets.map((target) => ({
    id: `${source.partition}.${source.epoch}.${source.position}.${source.eventIndex}:${target.type}:${target.id}`,
    source,
    target,
    object,
    occurredAt: isContent ? occurredAt : new Date(occurredAt).toISOString(),
  }));
}

/** Shared runtime registration only: no relay, server, SDK launch or second scheduler. */
export async function registerFeedWork(context: WorkContext): Promise<void> {
  const tokens = readMembershipWorkConfig(context.env).referenceKeys;
  const activityStore = createFeedActivityStore({ ...context, tokens });
  const followSource = createFollowActivitySource({
    ...context,
    tokens,
    workClient: context.client,
    activityStore,
    semanticObservations: librarySemanticObservations(),
  });
  const enqueue = async (activity: ActivityRef, cursor?: string) => {
    const suffix = cursor ? createHash('sha256').update(cursor).digest('hex') : 'start';
    await context.client.enqueue(
      {
        workflowName: FEED_FANOUT_WORKFLOW,
        workflowID: `feed:${activity.id}:${suffix}`,
        workflowIDReusePolicy: 'return-existing',
        queueName: 'workflows',
      },
      activity,
      cursor,
    );
  };
  const page = DBOS.registerStep(
    async (activity: ActivityRef, cursor?: string) => {
      const deadline = deadlineFor(60_000);
      const recipients = await followSource.pageRecipients(
        activity.target,
        { limit: 128, ...(cursor ? { cursor } : {}) },
        deadline,
      );
      // All foreign source reads have returned before the first viewer-home delivery transaction.
      for (const { accountId } of recipients.recipients)
        await activityStore.applyFollowingActivity({ accountId, reasonTarget: activity.target, activity }, deadline);
      return recipients.next;
    },
    { name: 'content.feedFanoutPage', ...COMMAND_STEP_RETRIES },
  );
  const continueFanout = DBOS.registerStep(enqueue, { name: 'content.feedFanoutContinue', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow(
    async (activity: ActivityRef, cursor?: string) => {
      const next = await page(activity, cursor);
      if (next) await continueFanout(activity, next);
    },
    { name: FEED_FANOUT_WORKFLOW },
  );
  context.addEffects([
    {
      name: 'content_feed_activity',
      types: activityTypes,
      async run(event) {
        for (const activity of await eventActivities(context, event)) {
          await activityStore.recordTargetActivity(activity, deadlineFor(30_000));
          // Effect completion promises both inventory and durable recipient continuation.
          await enqueue(activity);
        }
      },
    },
  ]);

  const clean = DBOS.registerStep(
    async (after: number, current?: number): Promise<{ after: number; current?: number } | null> => {
      const partition =
        current ??
        (
          await context.pool.query<{ partition_no: number }>(
            'SELECT partition_no FROM core.partition WHERE partition_no>$1 ORDER BY partition_no LIMIT 1',
            [after],
          )
        ).rows[0]?.partition_no;
      if (partition === undefined) return null;
      const removed = (
        await runCommand(context.pool, { partition, deadline: deadlineFor(30_000) }, async (tx, attempt) => {
          const cutoff = new Date(Date.parse(authoritativeTimeValue(attempt.time)) - FEED_RETENTION_MS).toISOString();
          const inventory = await tx.query(
            `DELETE FROM content.feed_activity WHERE (route,target_type,target_id,activity_id) IN
        (SELECT route,target_type,target_id,activity_id FROM content.feed_activity WHERE partition_no=$1 AND occurred_at<=$2
         ORDER BY occurred_at,route,target_type,target_id,activity_id LIMIT 128) RETURNING activity_id`,
            [partition, cutoff],
          );
          const inbox = await tx.query(
            `DELETE FROM content.feed_inbox WHERE (route,account_id,activity_id) IN
        (SELECT route,account_id,activity_id FROM content.feed_inbox WHERE partition_no=$1 AND occurred_at<=$2
         ORDER BY occurred_at,route,account_id,activity_id LIMIT 128) RETURNING activity_id`,
            [partition, cutoff],
          );
          const count = (inventory.rowCount ?? 0) + (inbox.rowCount ?? 0);
          return count
            ? {
                value: { inventory: inventory.rowCount, inbox: inbox.rowCount },
                events: [{ type: 'com.rezics.content.feed.expired.v1', data: {} }],
              }
            : noEffect({ inventory: 0, inbox: 0 });
        })
      ).value;
      return removed.inventory === 128 || removed.inbox === 128 ? { after, current: partition } : { after: partition };
    },
    { name: 'content.feedRetentionPage', ...COMMAND_STEP_RETRIES },
  );
  const nextCleanup = DBOS.registerStep(
    async (position: { after: number; current?: number }, root: string, segment: number) => {
      await context.client.enqueue(
        {
          workflowName: cleanupWorkflow,
          workflowID: `${root}:${segment}`,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'workflows',
        },
        position,
        root,
        segment,
      );
    },
    { name: 'content.feedRetentionContinue', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (
      position: { after: number; current?: number } = { after: -1 },
      root: string = DBOS.workflowID!,
      segment: number = 0,
    ) => {
      const next = await clean(position.after, position.current);
      if (next) await nextCleanup(next, root, segment + 1);
    },
    { name: cleanupWorkflow },
  );
  // The existing client schedule provisioner owns execution and restart recovery.
  DBOS.registerWorkflow(
    async () => {
      await nextCleanup({ after: -1 }, DBOS.workflowID!, 0);
    },
    { name: 'content.feedRetentionSweep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'content.feedRetention',
      workflowName: 'content.feedRetentionSweep',
      schedule: '0 * * * *',
      queueName: 'workflows',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
