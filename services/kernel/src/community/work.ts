import { registerDiscoveryWork } from './discovery-register.ts';
import { createSpaceDiscoveryEffect } from './space-discovery.ts';
import { maintainRealmMemberCounts } from './member-count.ts';
import { PARTITIONS } from '../route/route.ts';
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
