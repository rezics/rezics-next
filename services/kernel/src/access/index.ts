import {
  accessCommandAttempt,
  commandAccessContext,
  createCommandAdmission,
  installCommandAdmission,
} from './command-admission.ts';
import type { Access, AccessConfig as KernelAccessConfig, Actor, Resource } from '../request/access.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from './resource-roles.ts';
import { createAccess as permissionAccess } from './permission.ts';
import { createAuthenticator, deadlineClient, within, type AuthenticationConfig } from './authenticate.ts';
import { installDurableIdentityBridge } from './durable-identity.ts';
import { installApprovalIdentityBridge } from './approved-identity.ts';

export {
  createResourcePublicEligibility,
  createResourceAnonymousEligibility,
  type ResourceEligibility,
  type ResourceIdentity,
  type ResourceEligibilityOptions,
  type ResourceEligibilityPrepareContext,
  type ResourceEligibilityVerifyContext,
} from './eligibility.ts';

export type AccessConfig = KernelAccessConfig & { auth?: AuthenticationConfig };

type Prepared = {
  actor: Actor;
  action: string;
  route: number;
  id: string;
  deadline: number;
  durableTime?: import('../command/command.ts').AuthoritativeTime;
};

/**
 * App-local Access factory; the kernel supplies the mounted route catalogue.
 * Optional auth overrides the deployment's AUTH_ISSUER (HTTPS origin),
 * AUTH_AUDIENCE (HTTPS API URL), and AUTH_JWKS_URL (HTTPS public JWKS on the
 * issuer origin). All three are required only when authentication is used.
 * Only ES256 public keys are accepted; Auth credentials/private keys are never needed.
 */
export function createAccess(config: AccessConfig): Access {
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  const authentication = createAuthenticator(config.auth);
  const admission = createCommandAdmission(authentication.identity);
  const prepared = new WeakMap<object, Prepared>();
  const permissions = permissionAccess({
    actions,
    resourceRoles: config.resourceRoles,
    accountEvidence: (actor) => authentication.identity(actor)?.account,
  });
  const access: Access = {
    authenticate: authentication.authenticate,
    replayAuthorization: (action) => actions.get(action)?.replay,
    async prepare(actor, action, resource, context) {
      if (!actions.has(action)) return null;
      try {
        const identity = actor.kind === 'account' ? authentication.identity(actor) : undefined;
        if (actor.kind === 'account' && (!identity || identity.pool !== context.pool)) return null;
        const attempt = accessCommandAttempt(context);
        if (identity?.durableTime && (identity.durableTime !== attempt?.time || identity.durableAction !== action))
          return null;
        if (attempt && actor.kind === 'account' && !(await admission(actor, context))) return null;
        const deadline = Math.min(
          context.deadline,
          identity?.deadline ?? Infinity,
          identity?.expires ?? Infinity,
          !attempt && identity ? identity.observedAt + 180_000 : Infinity,
        );
        const permissionContext = {
          pool: deadlineClient(context.pool, deadline) as typeof context.pool,
          deadline,
        };
        const evidence = await within(deadline, () =>
          permissions.prepare!(
            actor,
            action,
            resource,
            attempt ? commandAccessContext(permissionContext, attempt) : permissionContext,
          ),
        );
        if (typeof evidence !== 'object' || evidence === null) return null;
        prepared.set(evidence, {
          actor,
          action,
          route: resource.route,
          id: resource.id,
          deadline,
          ...(identity?.durableTime ? { durableTime: identity.durableTime } : {}),
        });
        return evidence;
      } catch {
        return null;
      }
    },
    async authorize(client, actor, action, resource: Resource, evidence, time) {
      if (!actions.has(action)) return false;
      const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
      if (
        !facts ||
        facts.actor !== actor ||
        facts.action !== action ||
        facts.route !== resource.route ||
        facts.id !== resource.id ||
        (facts.durableTime !== undefined && facts.durableTime !== time)
      )
        return false;
      try {
        return await within(facts.deadline, () =>
          permissions.authorize(deadlineClient(client, facts.deadline), actor, action, resource, evidence, time),
        );
      } catch {
        return false;
      }
    },
  };
  installCommandAdmission(access, admission);
  installDurableIdentityBridge(access, {
    scope: authentication.durableScope,
    restore: authentication.restoreDurable,
    discard: authentication.discardDurable,
  });
  installApprovalIdentityBridge(access, {
    scope: authentication.approvalScope,
    expiry(actor, context) {
      const identity = authentication.identity(actor);
      return identity?.pool === context.pool && identity.durableTime === undefined ? identity.expires : undefined;
    },
    restore: authentication.restoreApproval,
  });
  installResourceRoleCatalogue(access, resourceRoleCatalogue(permissions)!);
  return access;
}

/** Standalone instance denies authorization until an app supplies its own catalogue. */
export const access: Access = createAccess({ actions: new Map() });

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
  ResourceAuthorizationUnavailableError,
  type AnonymousResourceAuthorizationInput,
  type AuthorizationAnchor,
  type ResourceAuthorizationContext,
  type ResourceAuthorizationInput,
} from './resource-authorization.ts';
export {
  parentCreationAuthorization,
  type ParentAnchor,
  type ParentCreationContext,
  type ResourceCreationPort,
} from './parent-creation.ts';
export { initializeResourceGrants } from './resource-initialization.ts';
export { installStandingParentGrant } from './standing-parent.ts';
export type { ResourceRoleCatalogue } from './resource-roles.ts';

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
