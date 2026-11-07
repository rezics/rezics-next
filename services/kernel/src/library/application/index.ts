/** Library applications. They load without foreign implementations and run with fake capabilities. */

import type { LibraryCapabilities } from '../contract/index.ts';
import type { LibraryDomain } from '../contract/index.ts';
import { createOwnerQueryApplication } from './owner-query.ts';
import { createSourceCaptureApplication } from './source-capture.ts';
import { createMemberPreparationApplication } from './member-preparation.ts';
import { createPublicationAdmissionApplication } from './publication.ts';
import { createEntryProgressApplication } from './entry-progress.ts';
import { createProgressOperationApplication } from './progress-operations.ts';

export { createOwnerQueryApplication } from './owner-query.ts';
export { createSourceCaptureApplication } from './source-capture.ts';
export { createMemberPreparationApplication } from './member-preparation.ts';
export { createPublicationAdmissionApplication } from './publication.ts';
export { createIdentityNativeApplication } from './identity-native.ts';
export { createEntryProgressApplication } from './entry-progress.ts';
export { createProgressOperationApplication } from './progress-operations.ts';

export function createLibraryApplications(
  capabilities: LibraryCapabilities & { search?: unknown; access?: unknown; routeKey?: Uint8Array },
): LibraryDomain {
  const capture = createSourceCaptureApplication(capabilities);
  return {
    ...capabilities,
    ownerQuery: createOwnerQueryApplication(capabilities),
    sourceCapture: { prepare: capabilities.sourceCapture.prepare.bind(capabilities.sourceCapture), ...capture },
    memberPreparation: createMemberPreparationApplication(capabilities),
    publicationAdmission: createPublicationAdmissionApplication(capabilities),
    entryProgress: createEntryProgressApplication(capabilities),
    progressOperations: createProgressOperationApplication(capabilities),
  };
}

export {
  createFollowCountReadApplication,
  deliverFollowCountApplication,
  runFollowCountPartition,
} from './follow-counts.ts';

export { createCollectionMutationApplication } from './collection-mutation.ts';
