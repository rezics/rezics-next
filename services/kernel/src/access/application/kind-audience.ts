import {
  EMPTY_ACCESS_WORK_DIMENSIONS,
  type AccessActor,
  type AccessApplicationPorts,
  type AccessWorkDimensions,
  type KindAudienceLocator,
  type KindAudiencePlan,
} from '../contract/index.ts';
import { kindAudienceActorShape, kindAudienceOverhead } from '../core/index.ts';

export type { KindAudiencePlan };

export function createKindAudienceApplication(
  ports: Pick<AccessApplicationPorts, 'kindAudience'>,
  membershipLimit: number,
) {
  return {
    plan(actor: AccessActor, statementBytes: number): KindAudiencePlan {
      const shape = kindAudienceActorShape(actor, membershipLimit);
      return {
        shape,
        overhead: kindAudienceOverhead(statementBytes),
        source: ports.kindAudience.collectionKindPreparationNativeWork?.({ actor, shape }),
      };
    },
    async resolveRawInput(
      locator: KindAudienceLocator,
      remaining: AccessWorkDimensions = EMPTY_ACCESS_WORK_DIMENSIONS,
    ): Promise<{ status: 'resolved' | 'unavailable'; work: AccessWorkDimensions }> {
      if (!ports.kindAudience.resolveCollectionKindRawInput) {
        return { status: 'unavailable', work: EMPTY_ACCESS_WORK_DIMENSIONS };
      }
      return ports.kindAudience.resolveCollectionKindRawInput({
        locator,
        allowance: { remaining },
      });
    },
  };
}
