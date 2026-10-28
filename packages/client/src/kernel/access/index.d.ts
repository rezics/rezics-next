export { ERASURE_PARTICIPANTS, ERASURE_PARTICIPANT_VERSION, acknowledgeErasure, readErasureStatus, type ErasureOutcome, type ErasureStatus, } from './erasure.ts';
export { readPublicViews, type PublicViews } from './public-views.ts';
export { applyAccountAgentEffect, createAccountAgentEffect } from './account-agent-effect.ts';
export { AccessUnavailableError } from './unavailable.ts';
export { createRatingCounter, type RatingCounter } from './rating-counter.ts';
export { accessClock } from './access-clock.ts';
import type { Access, AccessConfig as KernelAccessConfig, AccessContext, Actor, Resource } from '../request/access.ts';
import { type AuthenticationConfig } from './authenticate.ts';
export { createResourcePublicEligibility, createResourceAnonymousEligibility, type ResourceEligibility, type ResourceIdentity, type ResourceEligibilityOptions, type ResourceEligibilityPrepareContext, type ResourceEligibilityVerifyContext, } from './eligibility.ts';
export type AccessConfig = KernelAccessConfig & {
    auth?: AuthenticationConfig;
};
/**
 * App-local Access factory; the kernel supplies the mounted route catalogue.
 * Optional auth overrides the deployment's AUTH_ISSUER (HTTPS origin),
 * AUTH_AUDIENCE (HTTPS API URL), and AUTH_JWKS_URL (HTTPS public JWKS on the
 * issuer origin). All three are required only when authentication is used.
 * Only ES256 public keys are accepted; Auth credentials/private keys are never needed.
 */
export declare function createAccess(config: AccessConfig): Access;
/** Evaluate exact gate actions on the Global Context, borrowing the mounted operation's scope operand. */
export declare function authorizePlatformGate(access: Access, actor: Actor, actions: readonly string[], clientAction: string, resource: Resource, context: AccessContext, at: string): Promise<boolean>;
/** Standalone instance denies authorization until an app supplies its own catalogue. */
export declare const access: Access;
export { visibleOperations, type VisibleOperation } from './gates/visibility.ts';
export { ACTIVE_ACCOUNTS, type GrantSubject } from './grant-subject.ts';
export { captureDurableInitiator, durableInitiatorCommitment, DurableInitiatorCaptureUnavailableError, } from './durable-initiator-capture.ts';
export { MAX_CREATION_RESOURCES, createResourceCreationManifest, CreationManifestUnavailableError, type ResourceCreationEntry, type ResourceCreationManifest, } from './creation-manifest.ts';
export { resourceAuthorization, resourceAuthorizationPage, type AuthorizationAnchorPage, type ResourceAuthorizationPageInput, ResourceAuthorizationUnavailableError, type AnonymousResourceAuthorizationInput, type AuthorizationAnchor, type ResourceAuthorizationContext, type ResourceAuthorizationInput, } from './resource-authorization.ts';
export { creationDeclares, parentCreationAuthorization, type ParentAnchor, type ParentCreationContext, type ResourceCreationPort, } from './parent-creation.ts';
export { initializeResourceGrants } from './resource-initialization.ts';
export { resourceRoleHeld } from './resource-role-held.ts';
export { endResourceDenial, recordResourceDenial } from './resource-denials.ts';
export { grantGroupRole } from './resource-group-grant.ts';
export { installStandingParentGrant } from './standing-parent.ts';
export type { ResourceRoleCatalogue } from './resource-roles.ts';
export { createWorkflowApprovals, sweepWorkflowApprovals, workflowApprovalBinding, MAX_WORKFLOW_APPROVAL_LIFETIME_MS, WorkflowApprovalUnavailableError, type WorkflowApproval, type WorkflowApprovalConfig, type WorkflowApprovalRequest, type WorkflowApprovalBinding, } from './workflow-approvals.ts';
export { createCredentialCapability, type CredentialCapability, type CredentialCapabilityConfig, type CredentialOpeningLocator, } from './auth-credential-capability.ts';
export { createCommittedContinuations, deletionAllowlist, COMMITTED_CONTINUATION_ACTIONS, COMMITTED_CONTINUATION_PURPOSE, COMMITTED_CONTINUATION_TTL_MS, ContinuationDeniedError, type CommittedContinuations, type ContinuationBinding, type ContinuationEntry, type ContinuationView, } from './committed-continuations.ts';
export { createPreferenceCommands, readAccountPreferences, notificationAllowed, DEFAULT_ACCOUNT_PREFERENCES, type AccountPreferences, type PreferenceChange, } from './preferences.ts';
