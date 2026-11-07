import { bindCommunityDomainPorts } from '../community/domain-ports.ts';
import * as nativeAccessRealmOwnership from '../access/realm-ownership.ts';
import * as nativeAccessErasure from '../access/erasure.ts';
import * as nativeContentNotices from '../content/notices.ts';
import * as nativeAccessAccountData from '../access/account-data.ts';
import * as nativeAccessAccountAuthority from '../access/account-authority.ts';
import * as nativeAccessAuthenticate from '../access/authenticate.ts';
import * as nativeRequestAccess from '../request/access.ts';
import * as nativeAccessResourceDenials from '../access/resource-denials.ts';
import * as nativeAccessIndex from '../access/index.ts';
import * as nativeAccessCommandAdmission from '../access/command-admission.ts';
import * as nativeAccessPermission from '../access/permission.ts';
import * as nativeSemanticEligibility from '../semantic/eligibility.ts';
import * as nativeSemanticMerges from '../semantic/merges.ts';
import * as nativeSemanticRead from '../semantic/read.ts';
import * as nativeSemanticSubject from '../semantic/subject.ts';
import * as nativeContentDiscoveryMutation from '../content/discovery-mutation.ts';
import * as nativeContentDiscovery from '../content/discovery.ts';
import * as nativeContentRealmMedia from '../content/realm-media.ts';
import * as nativeAccessViewerActions from '../access/viewer-actions.ts';
import * as nativeAccessDurableInitiatorCapture from '../access/durable-initiator-capture.ts';
import * as nativeAccessMembershipWork from '../access/membership-work.ts';
import * as nativeAccessMembershipInverse from '../access/membership-inverse.ts';
import * as nativeAccessRealmMembershipTransition from '../access/realm-membership-transition.ts';
import * as nativeAccessDurableInitiator from '../access/durable-initiator.ts';
import * as nativeContentCommunityPresentation from '../content/community-presentation.ts';
import * as nativeAccessResourceGroupGrant from '../access/resource-group-grant.ts';
import * as nativeSemanticReferences from '../semantic/references.ts';
import * as nativeSemanticSummaries from '../semantic/summaries.ts';
import * as nativeAccessBootstrapGovernance from '../access/bootstrap-governance.ts';
import * as nativeAccessResourceAuthorization from '../access/resource-authorization.ts';
import * as nativeContentRealmBoardHome from '../content/realm-board-home.ts';
import * as nativeCommerceCatalogue from '../commerce/catalogue.ts';
import * as nativeContentCommunityPresentationRules from '../content/community-presentation-rules.ts';
import * as nativeContentReads from '../content/reads.ts';
import * as nativeAccessLifecycle from '../access/lifecycle.ts';
import * as nativeHttpProblem from '../http/problem.ts';
import * as nativeHttpRequest from '../http/request.ts';
import * as nativeContentMedia from '../content/media.ts';
import * as nativeContentSchemas from '../content/schemas.ts';
import * as nativeContentBoards from '../content/boards.ts';
import * as nativeAccessHandleHolder from '../access/handle-holder.ts';
import * as nativeLibraryFollows from '../library/follows.ts';

/** Bind native owners at the process boundary, without a Community-to-provider value edge. */
export function composeCommunityDomainPorts(): void {
  bindCommunityDomainPorts({
    createRealmOwnershipCommands: nativeAccessRealmOwnership.createRealmOwnershipCommands,
    assertRealmOwnerMayLeave: nativeAccessRealmOwnership.assertRealmOwnerMayLeave,
    lockRealmOwnership: nativeAccessRealmOwnership.lockRealmOwnership,
    REALM_OWNER_ROLE: nativeAccessRealmOwnership.REALM_OWNER_ROLE,
    readRealmOwnerLeaveObservation: nativeAccessRealmOwnership.readRealmOwnerLeaveObservation,
    readRealmOwnershipRoles: nativeAccessRealmOwnership.readRealmOwnershipRoles,
    readAppliedRealmErasureSuccession: nativeAccessRealmOwnership.readAppliedRealmErasureSuccession,
    readErasureStatus: nativeAccessErasure.readErasureStatus,
    acknowledgeErasure: nativeAccessErasure.acknowledgeErasure,
    resolveRetention: nativeAccessErasure.resolveRetention,
    recordLateErasureItem: nativeAccessErasure.recordLateErasureItem,
    resolveLateErasureItem: nativeAccessErasure.resolveLateErasureItem,
    eraseAccountNoticesPage: nativeContentNotices.eraseAccountNoticesPage,
    readPublicIdentities: nativeAccessAccountData.readPublicIdentities,
    readAccount: nativeAccessAccountData.readAccount,
    readOrganizationRole: nativeAccessAccountData.readOrganizationRole,
    readNativeAccountStates: nativeAccessAccountAuthority.readNativeAccountStates,
    deadlineClient: nativeAccessAuthenticate.deadlineClient,
    within: nativeAccessAuthenticate.within,
    accessCheck: nativeRequestAccess.accessCheck,
    accessCommandAuthorization: nativeRequestAccess.accessCommandAuthorization,
    AuthenticationError: nativeRequestAccess.AuthenticationError,
    prepareReadDecisions: nativeRequestAccess.prepareReadDecisions,
    endResourceDenial: nativeAccessResourceDenials.endResourceDenial,
    recordResourceDenial: nativeAccessResourceDenials.recordResourceDenial,
    requireResourceCommand: nativeAccessResourceDenials.requireResourceCommand,
    ResourceAccessWriteDeniedError: nativeAccessResourceDenials.ResourceAccessWriteDeniedError,
    resourceAuthorization: nativeAccessIndex.resourceAuthorization,
    createResourcePublicEligibility: nativeAccessIndex.createResourcePublicEligibility,
    initializeResourceGrants: nativeAccessIndex.initializeResourceGrants,
    parentCreationAuthorization: nativeAccessIndex.parentCreationAuthorization,
    approveRealmClaim: nativeAccessIndex.approveRealmClaim,
    accessCommandAttempt: nativeAccessCommandAdmission.accessCommandAttempt,
    commandAccessContext: nativeAccessCommandAdmission.commandAccessContext,
    permissionEvidenceDeadline: nativeAccessPermission.permissionEvidenceDeadline,
    subjectReadEligibility: nativeSemanticEligibility.subjectReadEligibility,
    SubjectRedirectError: nativeSemanticMerges.SubjectRedirectError,
    withReadTransaction: nativeSemanticRead.withReadTransaction,
    readItemTypes: nativeSemanticSubject.readItemTypes,
    readDiscoveryOperation: nativeContentDiscoveryMutation.readDiscoveryOperation,
    readDiscoveryOutcome: nativeContentDiscoveryMutation.readDiscoveryOutcome,
    readDiscoverySource: nativeContentDiscovery.readDiscoverySource,
    prepareDiscoverySourceApply: nativeContentDiscovery.prepareDiscoverySourceApply,
    exactRealmPresentationImage: nativeContentRealmMedia.exactRealmPresentationImage,
    readRealmPresentationImages: nativeContentRealmMedia.readRealmPresentationImages,
    claimRealmPresentationMedia: nativeContentRealmMedia.claimRealmPresentationMedia,
    RealmMediaImageSchema: nativeContentRealmMedia.RealmPresentationImageSchema,
    readViewerActions: nativeAccessViewerActions.readViewerActions,
    captureDurableInitiator: nativeAccessDurableInitiatorCapture.captureDurableInitiator,
    durableInitiatorCommitment: nativeAccessDurableInitiatorCapture.durableInitiatorCommitment,
    enqueueMembership: nativeAccessMembershipWork.enqueueMembership,
    MEMBERSHIP_LIMIT: nativeAccessMembershipInverse.MEMBERSHIP_LIMIT,
    MembershipInverseIncompleteError: nativeAccessMembershipInverse.MembershipInverseIncompleteError,
    requireMembershipInverseReady: nativeAccessMembershipInverse.requireMembershipInverseReady,
    first: nativeAccessRealmMembershipTransition.first,
    isRealmTransitionOpen: nativeAccessRealmMembershipTransition.isRealmTransitionOpen,
    transitionParameters: nativeAccessRealmMembershipTransition.transitionParameters,
    DurableInitiatorUnavailableError: nativeAccessDurableInitiator.DurableInitiatorUnavailableError,
    readCommunityPresentations: nativeContentCommunityPresentation.readCommunityPresentations,
    grantGroupRole: nativeAccessResourceGroupGrant.grantGroupRole,
    readSubjectReference: nativeSemanticReferences.readSubjectReference,
    readSubjectSummaryObservation: nativeSemanticSummaries.readSubjectSummaryObservation,
    PLATFORM_RESOURCE: nativeAccessBootstrapGovernance.PLATFORM_RESOURCE,
    authorizeResource: nativeAccessResourceAuthorization.resourceAuthorization,
    createRealmHomeBoardObservationReader: nativeContentRealmBoardHome.createRealmHomeBoardObservationReader,
    RealmHomeBoardPageSchema: nativeContentRealmBoardHome.RealmHomeBoardPageSchema,
    realmHomeBoardResponse: nativeContentRealmBoardHome.realmHomeBoardResponse,
    RealmHomeBoardQuerySchema: nativeContentRealmBoardHome.RealmHomeBoardQuerySchema,
    platformRootAnchor: nativeCommerceCatalogue.platformRootAnchor,
    prepareRealmRulesSelection: nativeContentCommunityPresentationRules.prepareRealmRulesSelection,
    rulesKey: nativeContentCommunityPresentationRules.rulesKey,
    ContentNotFoundError: nativeContentReads.ContentNotFoundError,
    readExactPublishedRulesForAuthoring: nativeContentReads.readExactPublishedRulesForAuthoring,
    readBoardPageActionEvidence: nativeContentReads.readBoardPageActionEvidence,
    readExactPublishedRules: nativeContentReads.readExactPublishedRules,
    normalizeHandle: nativeAccessLifecycle.normalizeHandle,
    problemSchema: nativeHttpProblem.problemSchema,
    IDEMPOTENCY_HEADER: nativeHttpRequest.IDEMPOTENCY_HEADER,
    idempotencyKeyOf: nativeHttpRequest.idempotencyKeyOf,
    SESSION_HEADER: nativeHttpRequest.SESSION_HEADER,
    MediaUnavailableError: nativeContentMedia.MediaUnavailableError,
    SitemapQuerySchema: nativeContentSchemas.SitemapQuerySchema,
    ContentIdSchema: nativeContentSchemas.ContentIdSchema,
    ContentRealmImageSchema: nativeContentSchemas.RealmPresentationImageSchema,
    sitemapPageSchema: nativeContentSchemas.sitemapPageSchema,
    listRealmBoards: nativeContentBoards.listRealmBoards,
    handleHolder: nativeAccessHandleHolder.handleHolder,
    createFollowCommands: nativeLibraryFollows.createFollowCommands,
  });
}
