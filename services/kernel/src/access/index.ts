export { createAccountPublicEligibility } from './account-authority.ts';
export type {
  Access,
  AccessCheck,
  AccessContext,
  Actor,
  Resource,
  PreparedAccessCheckInvocation,
  PreparedAccessCheckWork,
} from '../request/access.ts';
/** Compatibility exports; implementation consumers import the defining public leaf. */
export { authorizePlatformGate, viewerActionReadTime } from './read-bindings.ts';
export type * from './kind-audience.ts';
export {
  AccessWorkAccounting,
  AccessWorkUnavailableError,
  EMPTY_ACCESS_WORK,
  isAccessWorkDispatch,
  type AccessWork,
  type AccessWorkSink,
  type AccessWorkProducer,
  type AccessWorkResult,
} from './work.ts';
export { accountStandingCheck, type AccountStandingInput, type AccountStandingDecisions } from './account-standing.ts';
export {
  ERASURE_PARTICIPANTS,
  ERASURE_PARTICIPANT_VERSION,
  acknowledgeErasure,
  readErasureStatus,
  resolveRetention,
  recordLateErasureItem,
  resolveLateErasureItem,
  ERASURE_LOCATOR_EFFECTS,
  type RetentionException,
  type ErasureOutcome,
  type ErasureStatus,
} from './erasure.ts';
export { readPublicViews, type PublicViews } from './public-views.ts';
export {
  contributionAttribution,
  contributionDeleted,
  contributionFromPublicIdentity,
  ContributionAttributionSchema,
  type ContributionAttribution,
  type DeletedContributionAttribution,
  type LiveContributionAttribution,
} from './contribution-attribution.ts';
export { applyAccountAgentEffect, createAccountAgentEffect } from './account-agent-effect.ts';
export { AccessUnavailableError } from './unavailable.ts';
export {
  createContentEditionBuyerFact,
  type ContentEditionBenefit,
  type ContentEditionBuyerFact,
  type ContentEditionBuyerFactInput,
  type ContentEditionBuyerFactReader,
} from './authenticated-benefit.ts';
export { createRatingCounter, type RatingCounter } from './rating-counter.ts';
export { accessClock } from './access-clock.ts';
export {
  createResourcePublicEligibility,
  createResourceAnonymousEligibility,
  type ResourceEligibility,
  type ResourceIdentity,
  type ResourceEligibilityOptions,
  type ResourceEligibilityPrepareContext,
  type ResourceEligibilityVerifyContext,
} from './eligibility.ts';
export { visibleOperations, type VisibleOperation } from './gates/visibility.ts';
export { ACTIVE_ACCOUNTS, type GrantSubject } from './grant-subject.ts';
export {
  captureDurableInitiator,
  durableInitiatorCommitment,
  DurableInitiatorCaptureUnavailableError,
} from './durable-initiator-capture.ts';
export {
  MAX_CREATION_RESOURCES,
  createResourceCreationManifest,
  CreationManifestUnavailableError,
  type ResourceCreationEntry,
  type ResourceCreationManifest,
} from './creation-manifest.ts';
export {
  resourceAuthorization,
  resourceAuthorizationPage,
  type AuthorizationAnchorPage,
  type ResourceAuthorizationPageInput,
  ResourceAuthorizationUnavailableError,
  type AnonymousResourceAuthorizationInput,
  type AuthorizationAnchor,
  type ResourceAuthorizationContext,
  type ResourceAuthorizationInput,
} from './resource-authorization.ts';
export {
  creationDeclares,
  parentCreationAuthorization,
  type ParentAnchor,
  type ParentCreationContext,
  type ResourceCreationPort,
} from './parent-creation.ts';
export { initializeResourceGrants } from './resource-initialization.ts';
export { resourceRoleHeld } from './resource-role-held.ts';
export {
  readRealmOwnershipRoles,
  readRealmOwnerLeaveObservation,
  assertRealmOwnerMayLeave,
  RealmLastOwnerError,
  createRealmOwnershipCommands,
  readAppliedRealmErasureSuccession,
  type AppliedRealmErasureSuccession,
  type RealmOwnerLeaveObservation,
  type RealmErasureSuccessionInput,
  type RealmErasureSuccessionSource,
  type PreparedRealmErasureSuccession,
  type RealmErasureSuccessionResult,
  type RealmErasureSuccessionAuthorization,
} from './realm-ownership.ts';
export {
  approveRealmClaim,
  type ApproveRealmClaimInput,
  type ApproveRealmClaimContext,
  type RealmClaimApproval,
} from './realm-claim.ts';
export { endResourceDenial, recordResourceDenial } from './resource-denials.ts';
export { grantGroupRole } from './resource-group-grant.ts';
export { installStandingParentGrant } from './standing-parent.ts';
export type { ResourceRoleCatalogue } from './resource-roles.ts';
export {
  compileViewerActionBindings,
  readViewerActions,
  viewerActionBindingActions,
  type ViewerActionBinding,
  type ViewerActionBindings,
  type ViewerActionResource,
  type ViewerActionResources,
} from './viewer-actions.ts';
export {
  createWorkflowApprovals,
  sweepWorkflowApprovals,
  workflowApprovalBinding,
  MAX_WORKFLOW_APPROVAL_LIFETIME_MS,
  WorkflowApprovalUnavailableError,
  type WorkflowApproval,
  type WorkflowApprovalConfig,
  type WorkflowApprovalRequest,
  type WorkflowApprovalBinding,
} from './workflow-approvals.ts';
export {
  createCredentialCapability,
  type CredentialCapability,
  type CredentialCapabilityConfig,
  type CredentialOpeningLocator,
} from './auth-credential-capability.ts';
export {
  createCommittedContinuations,
  deletionAllowlist,
  COMMITTED_CONTINUATION_ACTIONS,
  COMMITTED_CONTINUATION_PURPOSE,
  COMMITTED_CONTINUATION_TTL_MS,
  ContinuationDeniedError,
  type CommittedContinuations,
  type ContinuationBinding,
  type ContinuationEntry,
  type ContinuationView,
} from './committed-continuations.ts';
export {
  createPreferenceCommands,
  readAccountPreferences,
  notificationAllowed,
  projectPreferencePage,
  projectReadingAdvice,
  projectShelfAdvice,
  withPreferencePage,
  withReadingPreferencePage,
  DEFAULT_ACCOUNT_PREFERENCES,
  type AccountPreferences,
  type PreferenceChange,
  type PreferencePage,
  type PreferencePageAction,
  type PreferencePageKind,
  type PreferenceActionAdvice,
  type PreferenceReadingAdvice,
  type PreferenceShelfAdvice,
  type PreferencePageObservation,
} from './preferences.ts';
export {
  access,
  createAccess,
  accessActionCatalogue,
  assertInternalActionDeclarations,
  INTERNAL_ACTIONS,
  type AccessConfig,
} from './factory.ts';
