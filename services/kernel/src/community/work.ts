import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { MembershipWorkInput, MembershipWorkResult } from '@rezics/auth-contract';
import { enqueueMembership } from '../access/membership-work.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import type { WorkContext, WorkModule } from '../work/registry.ts';
import { createFollowCommands } from '../library/follows.ts';
import { REALM_JOIN_WORKFLOW, REALM_LEAVE_WORKFLOW, type RealmMembershipWorkInput } from './join.ts';

/** Accounts accepts `^[A-Za-z0-9][A-Za-z0-9:_/-]{0,199}$`. Kind, Realm id and member account id fit; no dot. */
export function realmMembershipWorkflowId(
  operation: 'join' | 'leave',
  input: Pick<RealmMembershipWorkInput, 'realmId' | 'memberAccountId'>,
): string {
  const id = `realm:${operation}:${input.realmId}:${input.memberAccountId}`;
  if (id.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9:_/-]{0,199}$/.test(id)) return id;
  const digest = createHash('sha256').update(`${operation}\0${input.realmId}\0${input.memberAccountId}`).digest('hex');
  return `realm:${operation}:${digest}`;
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
export function registerCommunityWork({ pool, client, clock }: WorkContext): void {
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
      const childId = realmMembershipWorkflowId('join', input);
      await enqueueJoin(input, childId);
      const result = await DBOS.retrieveWorkflow<MembershipWorkResult>(childId).getResult();
      if (result?.status !== 'completed') throw new Error('Realm membership did not complete');
      await follow(input.memberAccountId, input.spaceId, `${DBOS.workflowID!}:follow`);
    },
    { name: REALM_JOIN_WORKFLOW },
  );
  DBOS.registerWorkflow(
    async (input: RealmMembershipWorkInput) => {
      const childId = realmMembershipWorkflowId('leave', input);
      await enqueueLeave(input, childId);
      const result = await DBOS.retrieveWorkflow<MembershipWorkResult>(childId).getResult();
      if (result?.status !== 'completed') throw new Error('Realm membership did not complete');
    },
    { name: REALM_LEAVE_WORKFLOW },
  );
}

export const communityWorkModule: WorkModule = {
  name: 'community',
  register(context) {
    registerCommunityWork(context);
  },
};
