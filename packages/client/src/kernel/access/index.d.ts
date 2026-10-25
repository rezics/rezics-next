import type { Access, AccessConfig as KernelAccessConfig } from '../request/access.ts';
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
/** Standalone instance denies authorization until an app supplies its own catalogue. */
export declare const access: Access;
export { ACTIVE_ACCOUNTS, type GrantSubject } from './grant-subject.ts';
export { captureDurableInitiator, durableInitiatorCommitment, DurableInitiatorCaptureUnavailableError, } from './durable-initiator-capture.ts';
export { MAX_CREATION_RESOURCES, createResourceCreationManifest, CreationManifestUnavailableError, type ResourceCreationEntry, type ResourceCreationManifest, } from './creation-manifest.ts';
export { resourceAuthorization, ResourceAuthorizationUnavailableError, type AnonymousResourceAuthorizationInput, type AuthorizationAnchor, type ResourceAuthorizationContext, type ResourceAuthorizationInput, } from './resource-authorization.ts';
export { parentCreationAuthorization, type ParentAnchor, type ParentCreationContext, type ResourceCreationPort, } from './parent-creation.ts';
export { initializeResourceGrants } from './resource-initialization.ts';
export { endResourceDenial, recordResourceDenial } from './resource-denials.ts';
export { grantGroupRole } from './resource-group-grant.ts';
export { installStandingParentGrant } from './standing-parent.ts';
export type { ResourceRoleCatalogue } from './resource-roles.ts';
export { createWorkflowApprovals, sweepWorkflowApprovals, workflowApprovalBinding, MAX_WORKFLOW_APPROVAL_LIFETIME_MS, WorkflowApprovalUnavailableError, type WorkflowApproval, type WorkflowApprovalConfig, type WorkflowApprovalRequest, type WorkflowApprovalBinding, } from './workflow-approvals.ts';
export { createCredentialCapability, type CredentialCapability, type CredentialCapabilityConfig, type CredentialOpeningLocator, } from './auth-credential-capability.ts';
