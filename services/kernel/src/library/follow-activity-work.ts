import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { readAccount } from '../access/account-data.ts';
import { createFeedActivityStore, feedRoute, type FeedActivityTarget } from '../content/feed-activity.ts';
import { feedEventSource } from '../content/feed-work.ts';
import { feedSnapshot } from '../content/feed-snapshot.ts';
import { lookupEventType } from '../events/catalogue.ts';
import {
  deliverFollowCount,
  resolveCountDestination,
  FollowCountTargetAbsentError,
  FollowCountUnavailableError,
} from './follow-count-target.ts';
import { readFollow } from './follow-store.ts';
import { workStepDeadline } from './command-support.ts';

const workflowName = 'library.followActivityBackfill';
type Input = { accountId: string; target: FeedActivityTarget; cursor?: string; examined: number; root: string };

/** One follow event schedules only its current edge; no follow/partition census or all-history job. */
export function registerFollowActivityWork(context: WorkContext): void {
  const tokens = readMembershipWorkConfig(context.env).referenceKeys;
  const activityStore = createFeedActivityStore({ ...context, tokens });
  const enqueue = async (input: Input) => {
    const suffix = input.cursor ? createHash('sha256').update(input.cursor).digest('hex') : 'start';
    await context.client.enqueue(
      {
        workflowName,
        workflowID: `follow-feed:${input.root}:${suffix}`,
        workflowIDReusePolicy: 'return-existing',
        queueName: 'workflows',
      },
      input,
    );
  };
  const nativeFollow = async (accountId: string, targetId: string) => {
    const route = feedRoute(accountId);
    return feedSnapshot(context.pool, route, workStepDeadline(), async (client) => {
      const account = await readAccount(client, route, accountId);
      if (!account || account.kind !== 'actor' || account.state !== 'active' || account.fenced) return null;
      const follow = await readFollow(client, route, accountId, targetId);
      return follow?.state === 'following' ? follow : null;
    });
  };
  const page = DBOS.registerStep(
    async (input: Input): Promise<Input | null> => {
      if (input.examined >= 2000) return null;
      const follow = await nativeFollow(input.accountId, input.target.id);
      if (!follow || follow.targetType !== input.target.type) return null;
      let target: FeedActivityTarget;
      try {
        const destination = await resolveCountDestination(
          { pool: context.pool },
          { targetId: input.target.id, targetType: input.target.type },
        );
        target = { type: input.target.type, id: destination.targetId };
      } catch (error) {
        if (error instanceof FollowCountTargetAbsentError) return null;
        throw error;
      }
      // Close the fanout/backfill race: establish this existing native candidate inverse before
      // reading inventory. An event indexed before this barrier is in backfill; one indexed later
      // sees the inverse in fanout. This is scheduling coverage, never disclosure authority.
      await deliverFollowCount(
        { pool: context.pool, client: context.client },
        {
          accountId: input.accountId,
          targetId: input.target.id,
          targetType: input.target.type,
        },
      );
      const covered = await feedSnapshot(
        context.pool,
        feedRoute(target.id),
        workStepDeadline(),
        async (client) =>
          (
            await client.query(
              `SELECT eligible FROM library.follow_count_pair WHERE route=$1 AND target_type=$2 AND
        target_id=$3 AND account_id=$4 AND original_id=$5`,
              [feedRoute(target.id), target.type, target.id, input.accountId, input.target.id],
            )
          ).rows[0]?.eligible === true,
      );
      if (!covered) throw new FollowCountUnavailableError();
      // Inventory is indexed by the immutable native reason, not a substituted terminal. The
      // destination above is only the current candidate inverse used to close the fanout race.
      const inventory = await activityStore.pageTargetActivity(
        input.target,
        { limit: 128, ...(input.cursor ? { cursor: input.cursor } : {}) },
        workStepDeadline(),
      );
      for (const activity of inventory.activities.slice(0, 2000 - input.examined)) {
        // Terminal accounts are fenced again by the viewer-home delivery command. Current follow and
        // identity are independently checked at disclosure; a delayed/retried positive is only a candidate.
        await activityStore.applyFollowingActivity(
          { accountId: input.accountId, reasonTarget: activity.target, activity },
          workStepDeadline(),
        );
      }
      const examined = input.examined + inventory.activities.length;
      return inventory.next && examined < 2000 ? { ...input, cursor: inventory.next, examined } : null;
    },
    { name: 'library.followActivityBackfillPage', ...COMMAND_STEP_RETRIES },
  );
  const continuation = DBOS.registerStep(enqueue, {
    name: 'library.followActivityBackfillContinue',
    ...COMMAND_STEP_RETRIES,
  });
  DBOS.registerWorkflow(
    async (input: Input) => {
      const next = await page(input);
      if (next) await continuation(next);
    },
    { name: workflowName },
  );
  context.addEffects([
    {
      name: 'library_follow_activity',
      types: ['com.rezics.library.follow.updated.v1'],
      async run(event) {
        if (!lookupEventType(event.type)?.Check(event.data) || !event.subject)
          throw new TypeError('Invalid follow activity event');
        const accountId = event.subject;
        const { targetId } = event.data as { targetId: string };
        const source = await feedEventSource(context.pool, event, accountId, workStepDeadline());
        const follow = await nativeFollow(accountId, targetId);
        if (!follow) return;
        await enqueue({
          accountId,
          target: { type: follow.targetType, id: targetId },
          examined: 0,
          root: `${source.partition}.${source.epoch}.${source.position}.${source.eventIndex}`,
        });
      },
    },
  ]);
}
