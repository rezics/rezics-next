import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import type {
  CommunityAccess,
  CommunityAccessPort,
  CommunityAmbient,
  CommunityApplicationPorts,
  CommunityClock,
  CommunityEffectPort,
  CommunityMembershipDependencies,
  CommunityPool,
} from '../contract/index.ts';
import { createRealmMembership, type RealmMembershipDependencies } from '../membership.ts';
import { createRealmParticipationCheck } from '../participation.ts';
import { readPublicationPreparation } from '../publication-preparation.ts';
import type { PublicationDependencies, PublicationReadContext } from '../publication.ts';
import { communityDeclaredEffects } from './effects.ts';
import { createNativeCommunityAmbient } from './ambient.ts';

function asPool(pool: CommunityPool): Pool {
  return pool as Pool;
}

function asAccess(access: CommunityAccess): Access {
  return access as Access;
}

function asClock(clock: CommunityClock): () => Date {
  return clock;
}

function nativeAccess(ambient: CommunityAmbient): CommunityAccessPort {
  return {
    createMembership(dependencies: CommunityMembershipDependencies) {
      return createRealmMembership({
        ...dependencies,
        pool: asPool(dependencies.pool),
        access: asAccess(dependencies.access),
        clock: asClock(dependencies.clock),
        deadlineNow: ambient.deadlineNow,
      } as RealmMembershipDependencies);
    },
    createParticipation(input) {
      return createRealmParticipationCheck({
        ...input,
        pool: asPool(input.pool),
        access: asAccess(input.access),
        clock: asClock((input.clock as CommunityClock | undefined) ?? (() => new Date())),
        deadlineNow: ambient.deadlineNow,
      });
    },
  };
}

function nativePublicationPreparation(): CommunityApplicationPorts['publicationPreparation'] {
  return {
    read(input) {
      return readPublicationPreparation(
        input.dependencies as unknown as PublicationDependencies,
        input.realmId,
        input.subjectId,
        input.context as unknown as PublicationReadContext,
      );
    },
  };
}

function nativeEffects(): CommunityEffectPort {
  return {
    effects: communityDeclaredEffects,
  };
}

/** Native Community ports. Composition roots bind these; applications never import this module. */
export function createNativeCommunityPorts(
  ambient: CommunityAmbient = createNativeCommunityAmbient(),
): CommunityApplicationPorts {
  return {
    access: nativeAccess(ambient),
    effects: nativeEffects(),
    publicationPreparation: nativePublicationPreparation(),
    ambient,
  };
}

export { createNativeCommunityAmbient, communityDeclaredEffects };
