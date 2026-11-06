/** Publication admission use case. Content publication and identity commitment stay behind ports. */

import type { ContentPublicationCapability, IdentityDisclosureCapability } from '../contract/index.ts';
import type { PublicationAdmissionResult } from '../contract/index.ts';
import type { CollectionSourceObservation } from '../contract/index.ts';
import { admitPublication } from '../core/index.ts';

export function createPublicationAdmissionApplication(capabilities: {
  contentPublication: ContentPublicationCapability;
  identityDisclosure: IdentityDisclosureCapability;
}) {
  return {
    admit(input: {
      locator: PublicationAdmissionResult['locator'];
      privateWorking: boolean;
      observation: CollectionSourceObservation | null;
      episodePresent: boolean;
      initiator?: unknown;
    }): PublicationAdmissionResult {
      const admitted = admitPublication(input);
      if (!admitted.admitted || !input.observation) return admitted;
      const output = capabilities.contentPublication.admitActivatedOutput({
        observation: input.observation,
        privateWorking: input.privateWorking,
      });
      if (input.initiator !== undefined) capabilities.identityDisclosure.initiatorCommitment(input.initiator);
      if (!output.admitted) return { ...admitted, admitted: false, phase: 'unavailable' };
      return admitted;
    },
  };
}

export type PublicationAdmissionApplication = ReturnType<typeof createPublicationAdmissionApplication>;
