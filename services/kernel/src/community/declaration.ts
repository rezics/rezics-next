import { createCommunityWorkModule } from './work.ts';
import { COMMUNITY_EVENTS } from './events.ts';
import { createRealmMembership, type RealmMembershipDependencies } from './membership.ts';
import { createRealmParticipationCheck } from './participation.ts';
import type { CommunityAmbient } from './ambient.ts';

export { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';

/**
 * Community's worker-side and shared declaration: one value composition consumes.
 * Constructing it runs nothing. The work module registers only when the work runtime composes it,
 * and the event catalogue reads `events`. Membership and participation readers take their request
 * deadline clock from `ambient`, so every reader Community hands out shares the same supplied operand.
 */
export function createCommunityDeclaration(ambient: CommunityAmbient) {
  return Object.freeze({
    name: 'community' as const,
    work: createCommunityWorkModule(ambient),
    events: COMMUNITY_EVENTS,
    createMembership(dependencies: Omit<RealmMembershipDependencies, 'deadlineNow'>) {
      return createRealmMembership({ ...dependencies, deadlineNow: ambient.deadlineNow });
    },
    createParticipation(input: Omit<Parameters<typeof createRealmParticipationCheck>[0], 'deadlineNow'>) {
      return createRealmParticipationCheck({ ...input, deadlineNow: ambient.deadlineNow });
    },
  });
}

export type CommunityDeclaration = ReturnType<typeof createCommunityDeclaration>;
