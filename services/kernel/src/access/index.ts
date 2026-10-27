import { throwEvidenceFailure } from './evidence.ts';
export { AccessUnavailableError } from './unavailable.ts';
import { requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import { credentialFloorIdentityClaims, installCredentialFloorBridge } from './auth-credential-capability.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import {
  accessCommandAttempt,
  commandAccessContext,
  createCommandAdmission,
  installCommandAdmission,
} from './command-admission.ts';
import { resourcePage, type ResourcePage } from '../request/access.ts';
import type {
  Access,
  AccessConfig as KernelAccessConfig,
  AccountActor,
  AccessClient,
  AccessDecision,
  AccessContext,
  Actor,
  Resource,
} from '../request/access.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from './resource-roles.ts';
import { createAccess as permissionAccess } from './permission.ts';
import timeRead from './permission-time.sql';
import { createAuthenticator, deadlineClient, within, type AuthenticationConfig } from './authenticate.ts';
import { installDurableIdentityBridge } from './durable-identity.ts';
import { installApprovalIdentityBridge } from './approved-identity.ts';
import { accessRoot } from './derived-access.ts';

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
  pageBinding?: string;
  deadline: number;
  requestDeadline: number;
  expires: number;
  durableTime?: import('../command/command.ts').AuthoritativeTime;
};

type PlatformGateCheck = (
  actor: Actor,
  actions: readonly string[],
  clientAction: string,
  resource: Resource,
  context: AccessContext,
  at: string,
) => Promise<boolean>;
const clocks = new WeakMap<Access, KernelClock>();
/** Internal Access composition only; derived adapters share their root's clock. */
export function accessClock(access: Access): KernelClock {
  return clocks.get(accessRoot(access)) ?? systemClock;
}

const platformGateChecks = new WeakMap<Access, PlatformGateCheck>();
const gateActionPattern = /^gate:([a-z][a-z_]{0,62})$/;
const reservedGateNames = new Set(['any', 'open', 'close']);

function permissionTimeStatement(statement: string): boolean {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
  return statement.length > 0 && normalize(statement) === normalize(timeRead.sql);
}
function atTimeClient(client: AccessClient, at: string): AccessClient {
  const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
  const bounded = Object.create(client) as AccessClient;
  bounded.query = ((...args: unknown[]) => {
    const first = args[0];
    const statement =
      typeof first === 'string'
        ? first
        : typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string'
          ? first.text
          : '';
    if (permissionTimeStatement(statement)) {
      return Promise.resolve({ rows: [{ at }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] });
    }
    return query(...args);
  }) as AccessClient['query'];
  return bounded;
}

/**
 * App-local Access factory; the kernel supplies the mounted route catalogue.
 * Optional auth overrides the deployment's AUTH_ISSUER (HTTPS origin),
 * AUTH_AUDIENCE (HTTPS API URL), and AUTH_JWKS_URL (HTTPS public JWKS on the
 * issuer origin). All three are required only when authentication is used.
 * Only ES256 public keys are accepted; Auth credentials/private keys are never needed.
 */
export function createAccess(config: AccessConfig): Access {
  const actions = new Map([...config.actions].map(([action, metadata]) => [action, { ...metadata }]));
  // gate:any is an internal Access action used by the Global Context and by the
  // built-in platform role; it is intentionally absent from the mounted route catalogue.
  actions.set('gate:any', { anonymous: false });
  const authentication = createAuthenticator(config.auth);
  const admission = createCommandAdmission(authentication.identity);
  const prepared = new WeakMap<object, Prepared>();
  const permissions = permissionAccess({
    actions,
    resourceRoles: config.resourceRoles,
    accountEvidence: (actor) => authentication.identity(actor)?.account,
    ...(config.realmRoleReader ? { realmRoleReader: config.realmRoleReader } : {}),
    ...(config.clock ? { clock: config.clock } : {}),
  });
  async function preparePermission(
    actor: Actor,
    action: string,
    resource: Resource,
    context: AccessContext,
    page?: ResourcePage,
  ) {
    const gate = gateActionPattern.exec(action)?.[1];
    if (gate !== undefined && (gate === 'any' || !reservedGateNames.has(gate)))
      actions.set(action, { anonymous: false });
    if (!actions.has(action)) return null;
    try {
      requireAccessDeadline(context.deadline);
      const identity = actor.kind === 'account' ? authentication.identity(actor) : undefined;
      if (actor.kind === 'account' && (!identity || identity.pool !== context.pool)) return null;
      const requestDeadline = Math.min(context.deadline, identity?.deadline ?? Infinity);
      requireAccessDeadline(requestDeadline);
      const expires = identity?.expires ?? Infinity;
      if (Date.now() >= expires) return null;
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
        page
          ? permissions.preparePage!(
              actor,
              action,
              page,
              attempt ? commandAccessContext(permissionContext, attempt) : permissionContext,
            )
          : permissions.prepare!(
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
        ...(page ? { pageBinding: JSON.stringify(page) } : {}),
        deadline,
        requestDeadline,
        expires,
        ...(identity?.durableTime ? { durableTime: identity.durableTime } : {}),
      });
      return evidence;
    } catch (error) {
      throwAccessUnavailable(error, context.deadline);
      throwEvidenceFailure(error);
      return null;
    }
  }
  async function authorizePermission(
    client: AccessClient,
    actor: Actor,
    action: string,
    resource: Resource,
    evidence?: unknown,
    time?: import('../command/command.ts').AuthoritativeTime,
    page?: ResourcePage,
    explicit = false,
  ): Promise<AccessDecision> {
    if (!actions.has(action)) return { allowed: false, explicit: false };
    const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
    if (
      !facts ||
      facts.actor !== actor ||
      facts.action !== action ||
      facts.route !== resource.route ||
      facts.id !== resource.id ||
      facts.pageBinding !== (page ? JSON.stringify(page) : undefined) ||
      (facts.durableTime !== undefined && facts.durableTime !== time)
    )
      return { allowed: false, explicit: false };
    try {
      requireAccessDeadline(facts.requestDeadline);
      if (Date.now() >= facts.expires) return { allowed: false, explicit: false };
      return await within(facts.deadline, async () => {
        const bounded = deadlineClient(client, facts.deadline);
        if (explicit) return permissions.authorizeExplicit!(bounded, actor, action, page ?? resource, evidence, time);
        const allowed = await (page
          ? permissions.authorizePage!(bounded, actor, action, page, evidence, time)
          : permissions.authorize(bounded, actor, action, resource, evidence, time));
        return { allowed, explicit: false };
      });
    } catch (error) {
      throwAccessUnavailable(error, facts.deadline);
      throwEvidenceFailure(error);
      return { allowed: false, explicit: false };
    }
  }
  const access: Access = {
    authenticate: authentication.authenticate,
    replayAuthorization: (action) => actions.get(action)?.replay,
    prepare: preparePermission,
    async authorize(...args) {
      return (await authorizePermission(...args)).allowed;
    },
    authorizeExplicit(client, actor, action, target, evidence, time) {
      const page = 'ids' in target ? resourcePage(target) : undefined;
      const resource = page ? { route: page.route, id: page.ids[0]! } : (target as Resource);
      return authorizePermission(client, actor, action, resource, evidence, time, page, true);
    },
    preparePage(actor, action, input, context) {
      const page = resourcePage(input);
      return preparePermission(actor, action, { route: page.route, id: page.ids[0]! }, context, page);
    },
    async authorizePage(client, actor, action, input, evidence, time) {
      const page = resourcePage(input);
      return (
        await authorizePermission(client, actor, action, { route: page.route, id: page.ids[0]! }, evidence, time, page)
      ).allowed;
    },
  };
  clocks.set(access, config.clock ?? systemClock);

  platformGateChecks.set(access, async (actor, requested, clientAction, resource, context, at) => {
    requireAccessDeadline(context.deadline);
    if (
      actor.kind !== 'account' ||
      !actor.scopes.includes(clientAction) ||
      !Number.isFinite(Date.parse(at)) ||
      !Number.isFinite(context.deadline) ||
      requested.length === 0 ||
      requested.some((action) => !/^gate:(?:any|[a-z][a-z_]{0,62})$/.test(action))
    )
      return false;

    const originals = new WeakMap<AccountActor, AccountActor>();
    const gateActorFor = (action: string): AccountActor => {
      const gateActor = Object.freeze({ ...actor, scopes: Object.freeze([action]) });
      originals.set(gateActor, actor);
      return gateActor;
    };
    const gateActions = new Map(actions);
    for (const action of requested) gateActions.set(action, { anonymous: false });
    const gatePermissions = permissionAccess({
      actions: gateActions,
      resourceRoles: config.resourceRoles,
      accountEvidence(candidate) {
        const original = originals.get(candidate) ?? candidate;
        return authentication.identity(original)?.account;
      },
      ...(config.clock ? { clock: config.clock } : {}),
    });
    const gateContext = {
      pool: deadlineClient(context.pool, context.deadline) as typeof context.pool,
      deadline: context.deadline,
    };

    const checks: { action: string; actor: AccountActor; evidence: unknown }[] = [];
    for (const action of [...new Set(requested)]) {
      const gateActor = gateActorFor(action);
      const evidence = await gatePermissions.prepare!(gateActor, action, resource, gateContext);
      checks.push({ action, actor: gateActor, evidence });
    }
    requireAccessDeadline(context.deadline);
    return withConnection(context.pool, async (client) => {
      const bounded = deadlineClient(client, context.deadline);
      await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        await bounded.query('SET LOCAL enable_seqscan = off');
        const pinned = atTimeClient(bounded, at);
        for (const check of checks) {
          requireAccessDeadline(context.deadline);
          if (await gatePermissions.authorize(pinned, check.actor, check.action, resource, check.evidence)) {
            await bounded.query('COMMIT');
            return true;
          }
        }
        await bounded.query('COMMIT');
        return false;
      } catch (error) {
        try {
          await bounded.query('ROLLBACK');
        } catch {
          // Preserve the original authorization failure.
        }
        throw error;
      }
    });
  });
  installCommandAdmission(access, admission);
  installDurableIdentityBridge(access, {
    scope: authentication.durableScope,
    restore: authentication.restoreDurable,
    discard: authentication.discardDurable,
  });
  installApprovalIdentityBridge(access, {
    clock: accessClock(access),
    scope: authentication.approvalScope,
    expiry(actor, context) {
      const identity = authentication.identity(actor);
      return identity?.pool === context.pool && identity.durableTime === undefined ? identity.expires : undefined;
    },
    restore: authentication.restoreApproval,
  });
  installCredentialFloorBridge(access, async (proof, resource, context) => {
    const claims = credentialFloorIdentityClaims(proof, context.pool);
    if (!claims || !actions.has('account:manage')) return false;
    const native = permissionAccess({
      actions,
      resourceRoles: config.resourceRoles,
      accountEvidence: (actor) => (actor === claims.actor ? claims.account : undefined),
      ...(config.clock ? { clock: config.clock } : {}),
    });
    const evidence = await native.prepare!(claims.actor, 'account:manage', resource, context);
    return withConnection(context.pool, (client) =>
      native.authorize(client, claims.actor, 'account:manage', resource, evidence, accessCommandAttempt(context)?.time),
    );
  });
  installResourceRoleCatalogue(access, resourceRoleCatalogue(permissions)!);
  return access;
}

/** Evaluate exact gate actions on the Global Context, borrowing the mounted operation's scope operand. */
export function authorizePlatformGate(
  access: Access,
  actor: Actor,
  actions: readonly string[],
  clientAction: string,
  resource: Resource,
  context: AccessContext,
  at: string,
): Promise<boolean> {
  return (
    platformGateChecks.get(accessRoot(access))?.(actor, actions, clientAction, resource, context, at) ??
    Promise.resolve(false)
  );
}

/** Standalone instance denies authorization until an app supplies its own catalogue. */
export const access: Access = createAccess({ actions: new Map() });

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
  parentCreationAuthorization,
  type ParentAnchor,
  type ParentCreationContext,
  type ResourceCreationPort,
} from './parent-creation.ts';
export { initializeResourceGrants } from './resource-initialization.ts';
export { endResourceDenial, recordResourceDenial } from './resource-denials.ts';
export { grantGroupRole } from './resource-group-grant.ts';
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
