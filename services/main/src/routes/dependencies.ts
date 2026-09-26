import type { ContentCore } from '../../../content/src/core.ts';
import type { ContentComments } from '../../../content/src/comments.ts';
import type { ContentProjectionCursor } from '../../../content/src/projection-cursor.ts';
import type { AccessAdmissionRegistry } from '../modules/access/admission.ts';
import type { AccessOrganizationModeration } from '../modules/access/organization-moderation.ts';
import type { AccessGroups } from '../modules/access/groups.ts';
import type { AccessGrants } from '../modules/access/grants.ts';
import type { AccessMemberships } from '../modules/access/memberships.ts';
import type { AccessMembershipConsents } from '../modules/access/membership-consents.ts';
import type { AccessOrgRealmParticipation } from '../modules/access/org-realm-participation.ts';
import type { AccessManagedOrganizations } from '../modules/access/managed-organizations.ts';
import type { AccessPrivateMemberships } from '../modules/access/private-memberships.ts';
import type { AccessPrivateRecipients } from '../modules/access/private-recipients.ts';
import type { AccessRepresentations } from '../modules/access/representations.ts';
import type { AccessRepresentedMembershipAuthority }
  from '../modules/access/represented-membership-authority.ts';
import type { AccessEligibleOrgMemberSet } from '../modules/access/eligible-org-member-set.ts';
import type { AccessRoles } from '../modules/access/roles.ts';
import type { SourceIntakeStore } from '../modules/source/intake.ts';
import type { SourceAcquisitionServices } from '../modules/source/acquisition.ts';
import type { OpenLibraryConversionStore } from '../modules/source/open-library-conversion.ts';
import type { SourceChildCorrespondenceStore }
  from '../modules/source/record-child-correspondence.ts';
import type { GoMvsResolutionStore } from '../modules/package/go-mvs.ts';
import type { CargoResolutionStore } from '../modules/package/cargo-resolution.ts';
import type { NpmResolutionStore } from '../modules/package/npm-resolution.ts';
import type { GoProxyCaptureStore } from '../modules/package/go-proxy-capture.ts';
import type { GoSumdbTrustStore } from '../modules/package/go-sumdb-trust.ts';
import type { OpenLibrarySourceGraph } from '../modules/source/graph-projection.ts';
import type { SourceNativeWorkProposalStore } from '../modules/source/native-work-proposal.ts';
import type { SourceNativeWorkAdoptionStore } from '../modules/source/native-work-adoption.ts';
import type { SourceNativeWorkAttachmentStore } from '../modules/source/native-work-attachment.ts';
import type { SourceAuthorCreditStore } from '../modules/source/author-credit.ts';
import type { AccessActingContexts } from '../modules/access/contexts.ts';
import type { AccountAssertionVerifier } from '../modules/account/verify-assertion.ts';
import type { RelayHandoffPositions } from '../modules/outbox/relay-position.ts';
import type { BackpressureProfile } from '../operations/backpressure.ts';
import type { WorkActivationEnvironment } from '../modules/work/activate.ts';
import type { ReaderVariantPreferenceStore } from '../modules/work/native-variants.ts';
import type { RealmVariantRecommendationStore }
  from '../modules/work/realm-variant-recommendation.ts';
import type { MediaAccessBatchReader } from '../modules/media/access-batch.ts';

export interface MainWorkDependencies {
  environment: WorkActivationEnvironment;
  account: Pick<AccountAssertionVerifier, 'verify'>;
  content?: Pick<ContentCore, 'owningResourceForRevision' | 'readExactBatch'>;
  contentAuthoring?: ContentCore;
  comments?: ContentComments;
  contentProjection?: { content: ContentCore; cursor: ContentProjectionCursor; consumer: string };
  /** Read-only Main outbox relay checkpoint for the OPS06 broker lane. */
  relayPosition?: Pick<RelayHandoffPositions, 'read'>;
  /** Deployment-selected lane budgets; defaults to `operations-backpressure-v1`. */
  backpressureProfile?: BackpressureProfile;
  access: Pick<AccessAdmissionRegistry,
    'register' | 'claim' | 'recordGraphOutcome' | 'canReadWork' | 'canReadContributionDraft'
    | 'canReadStandingRating' | 'canLinkTranslation' | 'activePrincipalId'>
    & Partial<Pick<AccessAdmissionRegistry, 'verifyContentDraftProof'
      | 'readRatingAggregateInventory' | 'checkRatingAggregateFence'
      | 'readRatingContextPolicyWitness' | 'issueTitleAdmission'>>;
  actingContexts?: AccessActingContexts;
  groups?: AccessGroups;
  grants?: AccessGrants;
  memberships?: AccessMemberships;
  membershipConsents?: AccessMembershipConsents;
  orgRealmParticipation?: AccessOrgRealmParticipation;
  organizationModeration?: AccessOrganizationModeration;
  managedOrganizations?: AccessManagedOrganizations;
  privateMemberships?: AccessPrivateMemberships;
  privateRecipients?: AccessPrivateRecipients;
  representations?: AccessRepresentations;
  representedMembershipAuthority?: AccessRepresentedMembershipAuthority;
  eligibleOrgMemberSet?: AccessEligibleOrgMemberSet;
  roles?: AccessRoles;
  sourceIntake?: SourceIntakeStore;
  sourceAcquisitions?: SourceAcquisitionServices;
  sourceConversions?: OpenLibraryConversionStore;
  sourceCorrespondences?: SourceChildCorrespondenceStore;
  packageResolutions?: GoMvsResolutionStore;
  packageCargoResolutions?: CargoResolutionStore;
  packageNpmResolutions?: NpmResolutionStore;
  packageCaptures?: GoProxyCaptureStore;
  packageVerifications?: GoSumdbTrustStore;
  sourceGraph?: OpenLibrarySourceGraph;
  sourceProposals?: SourceNativeWorkProposalStore;
  sourceAdoptions?: SourceNativeWorkAdoptionStore;
  sourceAttachments?: SourceNativeWorkAttachmentStore;
  sourceAuthorCredits?: SourceAuthorCreditStore;
  openLibraryFetch?: typeof fetch;
  readerPreferences?: ReaderVariantPreferenceStore;
  realmRecommendations?: RealmVariantRecommendationStore;
  /** Current Access authority for bounded resource-summary batches. */
  mediaAccess?: Pick<MediaAccessBatchReader, 'canReadWorks'>;
}
