import {
  accountDiscoverySource,
  readAccountDiscoveryBindings,
  readAccountDiscoveryRepairObservation,
  readAccountDiscoverySummaries,
  readAccountDiscoveryWitness,
} from '../access/account-discovery-source.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { readErasureStatus, recordLateErasureItem, resolveLateErasureItem } from '../access/erasure.ts';
import { SPACE_DISCOVERY_NATIVE_EVENTS, spaceDiscoveryInvalidation } from '../community/space-discovery.ts';
import { createRealmSubjectSource } from '../content/realm-subject-source.ts';
import {
  REVIEW_DISCOVERY_PAGE_LIMIT,
  REVIEW_DISCOVERY_READ_LIMIT,
  createReviewDiscoverySource,
} from '../content/review-discovery.ts';
import { readReviewDiscoveryChanges, refreshReviewDiscoveryChanges } from '../content/review-discovery-changes.ts';
import {
  admitCollectionKindPreparationStep,
  bindCollectionKindPreparationStep,
  readCollectionKindWorkDefinition,
} from '../library/collection-kind-work-admission.ts';
import {
  admitCollectionPublicationStep,
  readCollectionPublicationWorkDefinition,
} from '../library/collection-publication-work-admission.ts';
import { readPublicCollectionDiscoverySummaries } from '../library/collection-discovery-summaries.ts';
import { createNativeLibrarySourceCustody } from '../library/native-source-custody.ts';
import { withOwnerFilterNativeRead } from '../library/owner-filter-native-binding.ts';
import {
  bindOwnerFilterRead,
  readOwnerFilterCandidate,
  readOwnerFilterCandidateClosure,
} from '../library/owner-filter-plan.ts';
import { admitCollectionMemberQuery, leafProvider } from '../library/owner-filter.ts';
import {
  createIdentityScopedObservations,
  createIdentitySourceSupportReader,
  createPublicFilterSourceBinding,
  createPublicIdentitySourceCapture,
  createSubjectSourceKeyPages,
  publicFilterSource,
  readNativePublicFilterPublicationCompletion,
  readPublicFilterSourceDefinition,
} from '../semantic/index.ts';
import { readSubjectErasureSourceProof, verifySubjectErasureSourceProof } from '../semantic/account-erasure-source.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { identityEpochStore, recordIdentityEpochNativeCommit } from '../semantic/identity-adapters/index.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { identityScopeAddress } from '../semantic/identity-scoped-observations.ts';
import {
  PublicFilterSourceDefinitionError,
  advanceNativePublicFilterPreparation,
  joinNativePublicFilterRepair,
  readNativePublicFilterAccountRepair,
  readNativePublicFilterRepairStart,
} from '../semantic/public-filter-source-binding.ts';
import { publicFilterSourceOrigin } from '../semantic/public-filter-source.ts';
import { currentReadSnapshot, withReadTransaction } from '../semantic/read.ts';
import { relationSource } from '../semantic/search-relations.ts';
import { readIdentitySourceProjection, subjectSource } from '../semantic/search-source.ts';
import { readScopeLeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import { bindSearchNativePorts, bindSearchSemanticSourcePort, type SearchNativePorts } from '../search/composition.ts';

/** Bind existing native producers to Search's consumer-owned ports. */
export function composeSearchNativePorts(): SearchNativePorts {
  const port: SearchNativePorts = Object.freeze({
    PublicFilterSourceDefinitionError,
    REVIEW_DISCOVERY_PAGE_LIMIT,
    REVIEW_DISCOVERY_READ_LIMIT,
    SPACE_DISCOVERY_NATIVE_EVENTS,
    accountDiscoverySource,
    activeRelease,
    admitCollectionKindPreparationStep,
    admitCollectionMemberQuery,
    admitCollectionPublicationStep,
    advanceNativePublicFilterPreparation,
    bindCollectionKindPreparationStep,
    bindOwnerFilterRead,
    createIdentityScopedObservations,
    createIdentitySourceSupportReader,
    createNativeLibrarySourceCustody,
    createPublicFilterSourceBinding,
    createPublicIdentitySourceCapture,
    createRealmSubjectSource,
    createReviewDiscoverySource,
    createSubjectSourceKeyPages,
    currentReadSnapshot,
    deadlineClient,
    identityEpochStore,
    identityScopeAddress,
    joinNativePublicFilterRepair,
    leafProvider,
    publicFilterSource,
    publicFilterSourceOrigin,
    readAccountDiscoveryBindings,
    readAccountDiscoveryRepairObservation,
    readAccountDiscoverySummaries,
    readAccountDiscoveryWitness,
    readCollectionKindWorkDefinition,
    readCollectionPublicationWorkDefinition,
    readErasureStatus,
    readIdentityMappings,
    readIdentitySourceProjection,
    readNativePublicFilterAccountRepair,
    readNativePublicFilterPublicationCompletion,
    readNativePublicFilterRepairStart,
    readOwnerFilterCandidate,
    readOwnerFilterCandidateClosure,
    readPublicCollectionDiscoverySummaries,
    readPublicFilterSourceDefinition,
    readRelease,
    readReviewDiscoveryChanges,
    readScopeLeafEvidence,
    readSubjectErasureSourceProof,
    readSubjectSummaries,
    recordIdentityEpochNativeCommit,
    recordLateErasureItem,
    refreshReviewDiscoveryChanges,
    relationSource,
    resolveLateErasureItem,
    spaceDiscoveryInvalidation,
    subjectSource,
    verifySubjectErasureSourceProof,
    withOwnerFilterNativeRead,
    withReadTransaction,
  });
  bindSearchNativePorts(port);
  bindSearchSemanticSourcePort(port);
  return port;
}

/** Compatibility name used by ordinary Kernel composition. */
export function composeSearchSemanticSource(): SearchNativePorts {
  return composeSearchNativePorts();
}
