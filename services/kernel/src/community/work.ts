import { registerDiscoveryWork } from './discovery-register.ts';
import { createSpaceDiscoveryEffect } from './space-discovery.ts';
import {
  initializeSpaceDiscoveryDependencies,
  nextSpaceDiscoveryDependencyInstall,
} from './space-discovery-dependencies.ts';
import {
  nextSpaceDiscoveryTupleWitnessWork,
  repairSpaceDiscoveryTupleWitness,
} from './space-discovery-source-fences.ts';
import {
  drainSpaceDiscoveryFrontier,
  openSpaceDiscoveryFrontier,
  pendingSpaceDiscoveryFrontiers,
  type SpaceDiscoveryFrontier,
} from './space-discovery-frontier.ts';
import { SPACE_DISCOVERY_INVALIDATED } from './space-discovery-events.ts';
import { maintainRealmMemberCounts } from './member-count.ts';
import { PARTITIONS, partitionOf } from '../route/route.ts';
import { createPartyLocatorEffect } from './party-locator.ts';
import { createRevisionLocatorEffect } from './revision-locator.ts';
import { createCommunityAccountErasureEffect, registerCommunityAccountErasureWork } from './account-erasure.ts';
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { MembershipWorkInput, MembershipWorkResult } from '@rezics/auth-contract';
import { enqueueMembership } from '../access/membership-work.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { createMemberLocatorEffect } from './member-locator.ts';
import { createFollowCommands } from '../library/follows.ts';
import { REALM_JOIN_WORKFLOW, REALM_LEAVE_WORKFLOW, type RealmMembershipWorkInput } from './join.ts';

/** Accounts accepts `^[A-Za-z0-9][A-Za-z0-9:_/-]{0,199}$`; hash the parent and step into a valid child id. */
export function realmMembershipWorkflowId(
  parentWorkflowId: string,
  step: 'join.membership' | 'leave.membership',
): string {
  const digest = createHash('sha256').update(`${parentWorkflowId}\0${step}`).digest('hex');
  return `realm:membership:${digest}`;
}

function membershipInput(input: RealmMembershipWorkInput): MembershipWorkInput {
  return {
    kind: 'membership',
    principal: { kind: 'realm', id: input.realmId },
    memberAccountId: input.memberAccountId,
    role: input.role,
    ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }),
    authorization: input.authorization,
  };
}

const followAccess: Access = {
  async authenticate() {
    throw new AuthenticationError(401, 'Bearer');
  },
  async authorize() {
    return false;
  },
};

/** Registers the Realm join and leave workflows. Accounts must already be registered. */
export function registerCommunityWork({ pool, client, clock, addEffects }: WorkContext): void {
  addEffects([createMemberLocatorEffect(pool)]);
  const follows = createFollowCommands({ pool, access: followAccess, clock });
  const enqueueJoin = DBOS.registerStep(
    async (input: RealmMembershipWorkInput, childId: string) => {
      await enqueueMembership(client, childId, membershipInput(input));
    },
    { name: 'community.join.membership', retriesAllowed: false },
  );
  const follow = DBOS.registerStep(
    async (accountId: string, spaceId: string, stepKey: string) => {
      await follows.followForMembership({ accountId, spaceId, stepKey });
    },
    { name: 'community.join.follow', ...COMMAND_STEP_RETRIES },
  );
  const enqueueLeave = DBOS.registerStep(
    async (input: RealmMembershipWorkInput, childId: string) => {
      await enqueueMembership(client, childId, membershipInput(input));
    },
    { name: 'community.leave.membership', retriesAllowed: false },
  );
  DBOS.registerWorkflow(
    async (input: RealmMembershipWorkInput) => {
      const childId = realmMembershipWorkflowId(DBOS.workflowID!, 'join.membership');
      await enqueueJoin(input, childId);
      const result = await DBOS.retrieveWorkflow<MembershipWorkResult>(childId).getResult();
      if (result?.status !== 'completed') throw new Error('Realm membership did not complete');
      await follow(input.memberAccountId, input.spaceId, `${DBOS.workflowID!}:follow`);
    },
    { name: REALM_JOIN_WORKFLOW },
  );
  DBOS.registerWorkflow(
    async (input: RealmMembershipWorkInput) => {
      const childId = realmMembershipWorkflowId(DBOS.workflowID!, 'leave.membership');
      await enqueueLeave(input, childId);
      const result = await DBOS.retrieveWorkflow<MembershipWorkResult>(childId).getResult();
      if (result?.status !== 'completed') throw new Error('Realm membership did not complete');
    },
    { name: REALM_LEAVE_WORKFLOW },
  );
}

export const communityWorkModule: WorkModule = {
  name: 'community',
  async register(context) {
    context.addEffects([createRevisionLocatorEffect(context.pool), createSpaceDiscoveryEffect(context.pool)]);
    await registerSpaceDiscoveryDependencies(context);
    registerCommunityWork(context);
    // Use the existing maintenance queue and native command segments. DBOS
    // retains partition locators/continuation only; source progress stays native.
    const countSegment = DBOS.registerStep((partition: number) => maintainRealmMemberCounts(context.pool, partition), {
      name: 'community.member-count.segment',
      ...COMMAND_STEP_RETRIES,
    });
    const continueCount = DBOS.registerStep(
      async (partition: number) => {
        await context.client.enqueue(
          {
            workflowName: 'community.member-count.continue',
            queueName: 'maintenance',
            workflowID: `community:member-count:${createHash('sha256').update(`${DBOS.workflowID}:${partition}`).digest('hex')}`,
            workflowIDReusePolicy: 'return-existing',
          },
          partition,
        );
      },
      { name: 'community.member-count.enqueue', ...COMMAND_STEP_RETRIES },
    );
    const countBatch = async (start: number) => {
      let partition = start;
      // Bound workflow history as well as each native segment. Only the home
      // locator crosses the continuation; the source frontier stays native.
      for (let segment = 0; segment < 50 && partition < PARTITIONS; segment++) {
        if (!(await countSegment(partition))) partition++;
      }
      if (partition < PARTITIONS) await continueCount(partition);
    };
    DBOS.registerWorkflow(countBatch, { name: 'community.member-count.continue' });
    DBOS.registerWorkflow(
      async () => {
        await countBatch(0);
      },
      { name: 'community.member-count.upkeep' },
    );
    await context.client.applySchedules([
      {
        scheduleName: 'community.member-count.every-10-minutes',
        workflowName: 'community.member-count.upkeep',
        schedule: '*/10 * * * *',
        queueName: 'maintenance',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
    ]);
    registerCommunityAccountErasureWork(context);
    await registerDiscoveryWork(context);
    context.addEffects([createPartyLocatorEffect(context.pool), createCommunityAccountErasureEffect(context)]);
  },
};

/** A workflow performs at most twenty native pages. Continuations and periodic
 * recovery carry locators only; the durable owner frontier decides completion.
 */
async function registerSpaceDiscoveryDependencies(context: WorkContext): Promise<void> {
  const drain = DBOS.registerStep((key: SpaceDiscoveryFrontier) => drainSpaceDiscoveryFrontier(context.pool, key), {
    name: 'community.space-dependencies.drain',
    ...COMMAND_STEP_RETRIES,
  });
  const enqueueFrontier = async (key: SpaceDiscoveryFrontier) => {
    await context.client.enqueue(
      {
        workflowName: 'community.space-dependencies.continue',
        queueName: 'maintenance',
        workflowID: `space-dependencies:${createHash('sha256').update(`${DBOS.workflowID}:${key.obligation}`).digest('hex')}`,
        workflowIDReusePolicy: 'return-existing',
      },
      key,
    );
  };
  const enqueue = DBOS.registerStep(enqueueFrontier, {
    name: 'community.space-dependencies.enqueue',
    ...COMMAND_STEP_RETRIES,
  });
  DBOS.registerWorkflow(
    async (key: SpaceDiscoveryFrontier) => {
      for (let page = 0; page < 20; page++) {
        if ((await drain(key)) !== 'draining') return;
      }
      await enqueue(key);
    },
    { name: 'community.space-dependencies.continue' },
  );
  context.addEffects([
    {
      name: 'community_space_dependency_frontiers',
      types: [SPACE_DISCOVERY_INVALIDATED],
      async run(event) {
        const key = await openSpaceDiscoveryFrontier(context.pool, event);
        if (key) await enqueueFrontier(key);
      },
    },
  ]);
  const initialize = DBOS.registerStep(
    async () => {
      const partition = await nextSpaceDiscoveryDependencyInstall(context.pool);
      if (partition === null) return false;
      await initializeSpaceDiscoveryDependencies(context.pool, partition);
      return true;
    },
    { name: 'community.space-dependencies.initialize', ...COMMAND_STEP_RETRIES },
  );
  const repairTupleWitness = DBOS.registerStep(
    async () => {
      const locator = await nextSpaceDiscoveryTupleWitnessWork(context.pool);
      if (!locator) return false;
      await repairSpaceDiscoveryTupleWitness(context.pool, partitionOf(locator.route), locator.spaceId);
      return true;
    },
    { name: 'community.space-dependencies.tuple-witness', ...COMMAND_STEP_RETRIES },
  );
  const recover = DBOS.registerStep(() => pendingSpaceDiscoveryFrontiers(context.pool), {
    name: 'community.space-dependencies.recover',
    ...COMMAND_STEP_RETRIES,
  });
  const continueInitialization = DBOS.registerStep(
    async () => {
      await context.client.enqueue({
        workflowName: 'community.space-dependencies.upkeep',
        queueName: 'maintenance',
        workflowID: `space-dependencies:init:${createHash('sha256').update(DBOS.workflowID!).digest('hex')}`,
        workflowIDReusePolicy: 'return-existing',
      });
    },
    { name: 'community.space-dependencies.initialize-next', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async () => {
      for (let page = 0; page < 20; page++) {
        if (await repairTupleWitness()) continue;
        if (!(await initialize())) {
          for (const key of await recover()) await enqueue(key);
          return;
        }
      }
      await continueInitialization();
    },
    { name: 'community.space-dependencies.upkeep' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'community.space-dependencies.every-minute',
      workflowName: 'community.space-dependencies.upkeep',
      schedule: '* * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}
