import { createCommunityWorkModule } from './work.ts';
import { COMMUNITY_EVENTS } from './events.ts';
import { createRealmMembership, type RealmMembershipDependencies } from './membership.ts';
import { createRealmParticipationCheck } from './participation.ts';
import { communityDeclaredEffects } from './adapters/effects.ts';
import type { CommunityAmbient } from './contract/index.ts';

export { systemCommunityAmbient, type CommunityAmbient } from './ambient.ts';

/**
 * Community's worker-side and shared declaration: one value composition consumes.
 * Constructing it runs nothing. The work module registers only when the work runtime composes it,
 * and the event catalogue reads `events`. Membership and participation are the access capability;
 * `effects` is the declared effect list. Every reader Community hands out shares `ambient.deadlineNow`.
 */
export function createCommunityDeclaration(ambient: CommunityAmbient) {
  return Object.freeze({
    name: 'community' as const,
    ambient,
    work: createCommunityWorkModule(ambient),
    events: COMMUNITY_EVENTS,
    effects: communityDeclaredEffects,
    createMembership(dependencies: Omit<RealmMembershipDependencies, 'deadlineNow'>) {
      return createRealmMembership({ ...dependencies, deadlineNow: ambient.deadlineNow });
    },
    createParticipation(input: Omit<Parameters<typeof createRealmParticipationCheck>[0], 'deadlineNow'>) {
      return createRealmParticipationCheck({ ...input, deadlineNow: ambient.deadlineNow });
    },
  });
}

export type CommunityDeclaration = ReturnType<typeof createCommunityDeclaration>;
