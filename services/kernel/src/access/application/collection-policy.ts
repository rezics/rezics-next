/** Collection list specialization and funded authorization-preparation use cases. */

import type { AccessApplicationPorts, AccessWorkDimensions, CollectionListPolicyOutcome } from '../contract/index.ts';
import { EMPTY_ACCESS_WORK_DIMENSIONS } from '../contract/index.ts';

export function createCollectionPolicyApplication(ports: Pick<AccessApplicationPorts, 'collectionPolicy'>) {
  const policy = ports.collectionPolicy;
  return {
    specializeCollectionList(access: unknown, fullView: boolean): CollectionListPolicyOutcome {
      if (!policy) return { status: 'unavailable' };
      return policy.specializeFromCatalogue(policy.catalogueFor(access), fullView);
    },
    authorizationPreparation(): AccessWorkDimensions {
      return policy?.authorizationPreparation() ?? EMPTY_ACCESS_WORK_DIMENSIONS;
    },
  };
}
