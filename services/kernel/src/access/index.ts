export { createAccountPublicEligibility } from './account-authority.ts';
export { accountDiscoverySource, readAccountDiscoverySummaries } from './account-discovery-source.ts';
export type { AccessCheck, PreparedAccessCheckInvocation, PreparedAccessCheckWork } from '../request/access.ts';
export type * from './kind-audience.ts';
import type { PermissionAccount } from './account-authority.ts';
import { accessCheckout, accessTransaction, AccessWorkAccounting, AccessWorkUnavailableError } from './work.ts';
export {
  AccessWorkAccounting,
  AccessWorkUnavailableError,
  EMPTY_ACCESS_WORK,
  type AccessWork,
  type AccessWorkSink,
  type AccessWorkProducer,
  type AccessWorkResult,
} from './work.ts';
export { accountStandingCheck, type AccountStandingInput, type AccountStandingDecisions } from './account-standing.ts';
import { accountStandingCheck, installAccountStandingCheck } from './account-standing.ts';
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
export { applyAccountAgentEffect, createAccountAgentEffect } from './account-agent-effect.ts';
import { identityExpired, type IdentityExpiry } from './identity-expiry.ts';
import { throwEvidenceFailure } from './evidence.ts';
export { AccessUnavailableError } from './unavailable.ts';
export {
  createContentEditionBuyerFact,
  type ContentEditionBenefit,
  type ContentEditionBuyerFact,
  type ContentEditionBuyerFactInput,
  type ContentEditionBuyerFactReader,
} from './authenticated-benefit.ts';
export { createRatingCounter, type RatingCounter } from './rating-counter.ts';
import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
import { credentialFloorIdentityClaims, installCredentialFloorBridge } from './auth-credential-capability.ts';
import { installAccessClock } from './access-clock.ts';
export { accessClock } from './access-clock.ts';
import { withConnection, discardConnection } from '../database/pool.ts';
import {
  accessCommandAttempt,
  commandAccessContext,
  createCommandAdmission,
  installCommandAdmission,
} from './command-admission.ts';
import {
  AuthenticationError,
  validReadDecisionActions,
  resourcePage,
  type ResourcePage,
  installPreparedAccessCheckWork,
  nativePreparedAccessCheckWork,
} from '../request/access.ts';
import type {
  Access,
  AccessConfig as KernelAccessConfig,
  AccountActor,
  AccessClient,
  AccessDecision,
  AccessContext,
  Actor,
  Resource,
  ReadDecisions,
  ActionCatalogue,
} from '../request/access.ts';
import type {
  CaptureKindAudienceOriginInput,
  KindAudienceFreshRequest,
  PrepareKindAudienceInput,
  ResolveKindAudienceInput,
  VerifyKindAudienceSourceInput,
} from './kind-audience.ts';
import { accessRoot } from './derived-access.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from './resource-roles.ts';
import { createAccess as permissionAccess, readDecisionTime, authorizePreparedReadGate } from './permission.ts';
import { authoritativeTimeValue, releaseOperationalTime, type AuthoritativeTime } from '../command/command.ts';
import { currentOperationalResources, hasLiveOperationalTransaction } from '../command/operational.ts';
import timeRead from './permission-time.sql';
import {
  createAuthenticator,
  readNativeAccessTime,
  deadlineClient,
  within,
  type AuthenticationConfig,
} from './authenticate.ts';
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

/** Fixed native checks without mounted routes; call sites are listed in the Access README. */
export const INTERNAL_ACTIONS: ActionCatalogue = new Map([
  ['gate:any', { anonymous: false }],
  ['account:manage', { anonymous: false }],
  ['account:delete', { anonymous: false, replay: 'self-account-read' }],
  ['account:assign_reserved_handle', { anonymous: false }],
  ['organization:create', { anonymous: false }],
  ['organization:membership', { anonymous: false }],
  ['client:manage', { anonymous: false }],
  ['access:delegate', { anonymous: false }],
  ['account:renew_cleanup', { anonymous: false }],
]);

/** Also called at kernel startup, before its lazy Access is first used. */
export function assertInternalActionDeclarations(actions: ActionCatalogue): void {
  for (const [action, internal] of INTERNAL_ACTIONS) {
    const mounted = actions.get(action);
    if (
      mounted &&
      (mounted.anonymous !== internal.anonymous ||
        mounted.replay !== internal.replay ||
        mounted['x-resource-types'] !== internal['x-resource-types'])
    )
      throw new Error(`${action}: declaration conflicts with internal Access action`);
  }
}

export function accessActionCatalogue(declared: ActionCatalogue) {
  assertInternalActionDeclarations(declared);
  const actions = new Map([...declared].map(([action, metadata]) => [action, { ...metadata }]));
  for (const [action, metadata] of INTERNAL_ACTIONS) {
    if (!actions.has(action)) actions.set(action, { ...metadata });
  }
  return actions;
}

type Prepared = IdentityExpiry & {
  actor: Actor;
  action: string;
  route: number;
  id: string;
  pageBinding?: string;
  deadline: number;
  requestDeadline: number;
  durableTime?: import('../command/command.ts').AuthoritativeTime;
  work?: import('./work.ts').AccessWorkAccounting;
};

type PlatformGateCheck = (
  actor: Actor,
  actions: readonly string[],
  clientAction: string,
  resource: Resource,
  context: AccessContext,
  at: string,
  client?: AccessClient,
) => Promise<boolean>;
const platformGateChecks = new WeakMap<Access, PlatformGateCheck>();
const preparedReadTimes = new WeakMap<Access, WeakMap<AccessContext, AuthoritativeTime>>();
/** The native batch's already-observed kernel instant; no second clock query. */
export function viewerActionReadTime(access: Access, context: AccessContext): AuthoritativeTime {
  const time = preparedReadTimes.get(accessRoot(access))?.get(context);
  if (!time) throw new AccessUnavailableError('overloaded');
  return time;
}
const gateActionPattern = /^gate:([a-z][a-z_-]{0,62})$/;
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
  const actions = accessActionCatalogue(config.actions);
  const clock = config.clock ?? (() => new Date(Date.now()));
  const authentication = createAuthenticator(config.auth, clock);
  const admission = createCommandAdmission(authentication.identity, clock);
  const prepared = new WeakMap<object, Prepared>();
  const standingAccounts = new WeakMap<AccountActor, PermissionAccount>();
  const permissions = permissionAccess({
    actions,
    resourceRoles: config.resourceRoles,
    standingAccounts,
    accountEvidence: (actor) => standingAccounts.get(actor) ?? authentication.identity(actor)?.account,
    kindOriginal(actor, context) {
      if (actor.kind === 'anonymous') {
        if (
          !context.time ||
          !(context.work instanceof AccessWorkAccounting) ||
          context.work.deadline !== context.deadline
        )
          return undefined;
        authoritativeTimeValue(context.time);
        return { expires: context.deadline, account: null };
      }
      const identity = authentication.identity(actor);
      if (
        !identity ||
        identity.pool !== context.pool ||
        identity.requestContext !== context ||
        identity.requestWork !== context.work ||
        identity.requestTime !== context.time ||
        identity.deadline !== context.deadline ||
        identity.durableTime ||
        identity.expiryClock !== 'wall' ||
        identityExpired(identity, clock) ||
        Date.now() - identity.observedAt >= 180_000
      )
        return undefined;
      return {
        expires: identity.expires,
        account: [
          identity.account.accountId,
          identity.account.kind,
          identity.account.state,
          identity.account.fenced,
          identity.account.operatorAccountId,
          String(identity.account.minimumAuthnEpoch),
        ],
      };
    },
    ...(config.realmRoleReader ? { realmRoleReader: config.realmRoleReader } : {}),
    ...(config.contentEditionBuyerFactReader
      ? { contentEditionBuyerFactReader: config.contentEditionBuyerFactReader }
      : {}),
    ...(config.contentEditionBuyerFactWork ? { contentEditionBuyerFactWork: config.contentEditionBuyerFactWork } : {}),
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
      const standing = actor.kind === 'account' && standingAccounts.has(actor);
      if (actor.kind === 'account' && !standing && (!identity || identity.pool !== context.pool)) return null;
      const requestDeadline = Math.min(context.deadline, identity?.deadline ?? Infinity);
      requireAccessDeadline(requestDeadline);
      const expires = identity?.expires ?? Infinity;
      if (identity && identityExpired(identity, clock)) return null;
      const attempt = accessCommandAttempt(context);
      const nativeTime = attempt?.time ?? context.time;
      if (
        context.work &&
        actor.kind === 'account' &&
        !standing &&
        !(await authentication.refresh(actor, { ...context, ...(nativeTime ? { time: nativeTime } : {}) }))
      )
        return null;
      if (identity?.durableTime && (identity.durableTime !== attempt?.time || identity.durableAction !== action))
        return null;
      if (attempt && actor.kind === 'account' && !(await admission(actor, context))) return null;
      const deadline = Math.min(
        context.deadline,
        identity?.deadline ?? Infinity,
        !attempt && identity ? identity.observedAt + 180_000 : Infinity,
      );
      const permissionContext = {
        ...(context.work ? { work: context.work } : {}),
        ...(context.time ? { time: context.time } : {}),
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
        ...(context.work ? { work: context.work } : {}),
        expires,
        expiryClock: identity?.expiryClock ?? 'kernel',
        ...(identity?.durableTime ? { durableTime: identity.durableTime } : {}),
      });
      return evidence;
    } catch (error) {
      context.work?.fail(error);
      throwAccessUnavailable(error, context.deadline);
      throwEvidenceFailure(error);
      if (error instanceof AuthenticationError) throw error;
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
      if (identityExpired(facts, clock)) return { allowed: false, explicit: false };
      return await within(facts.deadline, async () => {
        const bounded = deadlineClient(client, facts.deadline);
        if (explicit) return permissions.authorizeExplicit!(bounded, actor, action, page ?? resource, evidence, time);
        const allowed = await (page
          ? permissions.authorizePage!(bounded, actor, action, page, evidence, time)
          : permissions.authorize(bounded, actor, action, resource, evidence, time));
        return { allowed, explicit: false };
      });
    } catch (error) {
      facts.work?.fail(error);
      throwAccessUnavailable(error, facts.deadline);
      throwEvidenceFailure(error);
      return { allowed: false, explicit: false };
    }
  }
  const readTimes = new WeakMap<AccessContext, AuthoritativeTime>();
  const gateReads = new WeakMap<
    AccessContext,
    { actor: Actor; handle: ReadDecisions; time: AuthoritativeTime; checks: Map<string, Promise<boolean>> }
  >();
  const kindEpisodes = new WeakMap<
    AccountActor,
    Readonly<{
      context: AccessContext;
      locator: CaptureKindAudienceOriginInput['locator'];
    }>
  >();
  function sameKindEpisode(
    actor: Actor,
    context: AccessContext,
    locator: CaptureKindAudienceOriginInput['locator'],
    bind = false,
  ): boolean {
    if (actor.kind === 'anonymous') return true;
    const episode = kindEpisodes.get(actor);
    if (episode && (episode.context !== context || !exactKindLocator(episode.locator, locator))) return false;
    if (!episode && bind) kindEpisodes.set(actor, Object.freeze({ context, locator: Object.freeze({ ...locator }) }));
    return true;
  }
  function sameKindRequestEpisode(
    request: KindAudienceFreshRequest | undefined,
    locator: CaptureKindAudienceOriginInput['locator'],
    bind = false,
  ): boolean {
    return (
      !!request && (request.kind === 'anonymous' || sameKindEpisode(request.actor, request.context, locator, bind))
    );
  }
  function hasKindRequestOrigin(input: CaptureKindAudienceOriginInput): boolean {
    try {
      authoritativeTimeValue(input.context.time);
    } catch {
      return false;
    }
    // Anonymous is a request for native floor production, never asserted proof.
    if (input.actor.kind === 'anonymous') return true;
    const identity = authentication.identity(input.actor);
    return (
      !!identity &&
      identity.pool === input.context.pool &&
      identity.requestContext === input.context &&
      identity.requestWork === input.context.work &&
      identity.requestTime === input.context.time &&
      sameKindEpisode(input.actor, input.context, input.locator) &&
      identity.deadline === input.context.deadline &&
      input.context.work instanceof AccessWorkAccounting &&
      input.context.work.deadline === input.context.deadline &&
      input.context.time !== undefined &&
      !identity.durableTime &&
      identity.expiryClock === 'wall' &&
      Date.now() - identity.observedAt < 180_000 &&
      !identityExpired(identity, clock) &&
      Date.now() < Math.min(identity.deadline, input.context.deadline)
    );
  }
  function hasFreshKindRequest(
    request: KindAudienceFreshRequest | undefined,
    pool: AccessContext['pool'],
    deadline: number,
  ): boolean {
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      !Number.isFinite(deadline) ||
      Date.now() >= deadline
    )
      return false;
    const requestKeys = Object.keys(request).sort().join(',');
    if (request.kind === 'anonymous') {
      if (requestKeys !== 'context,kind' || !request.context || typeof request.context !== 'object') return false;
    } else if (request.kind === 'authenticated') {
      if (requestKeys !== 'actor,context,kind' || !request.context || typeof request.context !== 'object') return false;
    } else return false;
    const context = request.context;
    if (context.pool !== pool || context.deadline !== deadline || Date.now() >= context.deadline) return false;
    if (request.kind === 'anonymous') return true;
    try {
      if (!context.time) return false;
      authoritativeTimeValue(context.time);
    } catch {
      return false;
    }
    const identity = authentication.identity(request.actor);
    return (
      !!identity &&
      identity.pool === context.pool &&
      identity.requestContext === context &&
      identity.requestWork === context.work &&
      identity.requestTime === context.time &&
      identity.deadline === context.deadline &&
      context.work instanceof AccessWorkAccounting &&
      context.work.deadline === context.deadline &&
      context.time !== undefined &&
      !identity.durableTime &&
      identity.expiryClock === 'wall' &&
      Date.now() - identity.observedAt < 180_000 &&
      !identityExpired(identity, clock) &&
      Date.now() < identity.deadline
    );
  }
  function liveKindRequest(request: KindAudienceFreshRequest | undefined): boolean {
    if (!request) return false;
    // This is an invocation-lifetime check only. No positive permission is issued
    // without the five native closures. In particular a Source-local verification
    // must never refresh by checking out a second connection while its T is held.
    return hasFreshKindRequest(request, request.context.pool, request.context.deadline);
  }
  /** Snapshot only invocation identity; this ephemeral guard conveys no permission. */
  function originalKindRequest(request: KindAudienceFreshRequest | undefined) {
    const context = request?.context;
    const actor = request?.kind === 'authenticated' ? request.actor : undefined;
    const kind = request?.kind;
    const pool = context?.pool;
    const deadline = context?.deadline;
    const work = context?.work;
    const time = context?.time;
    return (candidate: KindAudienceFreshRequest | undefined): boolean =>
      !!candidate &&
      candidate === request &&
      candidate.kind === kind &&
      candidate.context === context &&
      (candidate.kind === 'authenticated' ? candidate.actor === actor : actor === undefined) &&
      candidate.context.pool === pool &&
      candidate.context.deadline === deadline &&
      candidate.context.work === work &&
      candidate.context.time === time;
  }
  function exactKindLocator(
    left: CaptureKindAudienceOriginInput['locator'],
    right: CaptureKindAudienceOriginInput['locator'],
  ): boolean {
    return (
      !!left &&
      !!right &&
      left.route === right.route &&
      left.ownerAccountId === right.ownerAccountId &&
      left.collectionId === right.collectionId &&
      left.preparationId === right.preparationId
    );
  }
  function hasKindOperationRequest(
    request: KindAudienceFreshRequest | undefined,
    work: ResolveKindAudienceInput['work'] | VerifyKindAudienceSourceInput['work'],
    deadline: number,
  ): boolean {
    if (!request || request.context.deadline !== deadline || !hasLiveOperationalTransaction(work.tx)) return false;
    const resources = currentOperationalResources(work.tx);
    return (
      resources.pool === request.context.pool &&
      resources.deadline === deadline &&
      sameKindRequestEpisode(request, work.locator) &&
      hasFreshKindRequest(request, resources.pool, deadline)
    );
  }
  const access: Access = {
    kindAudience: Object.freeze({
      ...permissions.kindAudience!,
      capture: Object.freeze({
        bound(input: CaptureKindAudienceOriginInput) {
          if (!hasKindRequestOrigin(input)) return undefined;
          return permissions.kindAudience!.capture.bound(input);
        },
        async run(input: CaptureKindAudienceOriginInput) {
          const actor = input.actor;
          const context = input.context;
          const locator = Object.freeze({ ...input.locator });
          if (!hasKindRequestOrigin(input))
            throw new AccessWorkUnavailableError('Collection Kind audience actual native request origin');
          if (!sameKindEpisode(input.actor, input.context, input.locator, true))
            throw new AccessWorkUnavailableError('Collection Kind audience original episode changed');
          if (permissions.kindAudience!.capture.bound(input) === undefined)
            throw new AccessWorkUnavailableError('Accounts Kind audience origin capture producer');
          if (
            input.actor.kind === 'account' &&
            !liveKindRequest({ kind: 'authenticated', actor: input.actor, context: input.context })
          )
            throw new AccessWorkUnavailableError('Collection Kind audience current authenticated request');
          const result = await permissions.kindAudience!.capture.run(input);
          if (
            input.actor !== actor ||
            input.context !== context ||
            !exactKindLocator(input.locator, locator) ||
            !hasKindRequestOrigin(input) ||
            (input.actor.kind === 'account' &&
              !liveKindRequest({ kind: 'authenticated', actor: input.actor, context: input.context }))
          ) {
            input.context.work.fail(
              new AccessWorkUnavailableError('Collection Kind audience request expired during capture'),
            );
            throw new AccessWorkUnavailableError('Collection Kind audience request expired during capture');
          }
          return result;
        },
        actual: permissions.kindAudience!.capture.actual,
      }),
      prepare: Object.freeze({
        bound(input: PrepareKindAudienceInput) {
          if (
            !exactKindLocator(input.origin.locator, input.input.locator) ||
            !sameKindRequestEpisode(input.request, input.origin.locator) ||
            !hasFreshKindRequest(input.request, input.context.pool, input.context.deadline)
          )
            return undefined;
          return permissions.kindAudience!.prepare.bound(input);
        },
        async run(input: PrepareKindAudienceInput) {
          const sameRequest = originalKindRequest(input.request);
          if (
            !exactKindLocator(input.origin.locator, input.input.locator) ||
            !sameKindRequestEpisode(input.request, input.origin.locator) ||
            !hasFreshKindRequest(input.request, input.context.pool, input.context.deadline)
          )
            throw new AccessWorkUnavailableError('Collection Kind audience original fresh request');
          if (!sameKindRequestEpisode(input.request, input.origin.locator, true))
            throw new AccessWorkUnavailableError('Collection Kind audience original episode changed');
          if (permissions.kindAudience!.prepare.bound(input) === undefined)
            throw new AccessWorkUnavailableError('Accounts Kind audience evidence preparation producer');
          if (!liveKindRequest(input.request))
            throw new AccessWorkUnavailableError('Collection Kind audience original current formula');
          const result = await permissions.kindAudience!.prepare.run(input);
          if (
            !sameRequest(input.request) ||
            !exactKindLocator(input.origin.locator, input.input.locator) ||
            !sameKindRequestEpisode(input.request, input.origin.locator) ||
            !hasFreshKindRequest(input.request, input.context.pool, input.context.deadline) ||
            !liveKindRequest(input.request)
          ) {
            if (input.request?.kind === 'authenticated')
              input.request.context.work.fail(
                new AccessWorkUnavailableError('Collection Kind audience request expired during preparation'),
              );
            throw new AccessWorkUnavailableError('Collection Kind audience request expired during preparation');
          }
          return result;
        },
        actual: permissions.kindAudience!.prepare.actual,
      }),
      resolveInput: Object.freeze({
        bound(input: ResolveKindAudienceInput) {
          if (
            !exactKindLocator(input.origin.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline)
          )
            return undefined;
          return permissions.kindAudience!.resolveInput.bound(input);
        },
        async run(input: ResolveKindAudienceInput) {
          const sameRequest = originalKindRequest(input.request);
          const originalWork = input.work;
          if (
            !exactKindLocator(input.origin.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline)
          )
            throw new AccessWorkUnavailableError('Collection Kind audience current request for input resolution');
          if (!sameKindRequestEpisode(input.request, input.work.locator, true))
            throw new AccessWorkUnavailableError('Collection Kind audience original episode changed');
          if (permissions.kindAudience!.resolveInput.bound(input) === undefined)
            throw new AccessWorkUnavailableError('Accounts Kind committed input resolver');
          if (!liveKindRequest(input.request))
            throw new AccessWorkUnavailableError('Collection Kind audience original formula for input resolution');
          const result = await permissions.kindAudience!.resolveInput.run(input);
          if (
            !sameRequest(input.request) ||
            input.work !== originalWork ||
            !exactKindLocator(input.origin.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline) ||
            !liveKindRequest(input.request)
          ) {
            if (input.request?.kind === 'authenticated')
              input.request.context.work.fail(
                new AccessWorkUnavailableError('Collection Kind request expired during input resolution'),
              );
            throw new AccessWorkUnavailableError('Collection Kind request expired during input resolution');
          }
          return result;
        },
        actual: permissions.kindAudience!.resolveInput.actual,
      }),
      verifySource: Object.freeze({
        bound(input: VerifyKindAudienceSourceInput) {
          if (
            !exactKindLocator(input.evidence.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline)
          )
            return undefined;
          return permissions.kindAudience!.verifySource.bound(input);
        },
        async run(input: VerifyKindAudienceSourceInput) {
          const sameRequest = originalKindRequest(input.request);
          const originalWork = input.work;
          if (
            !exactKindLocator(input.evidence.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline)
          )
            throw new AccessWorkUnavailableError('Collection Kind audience current request for Source verification');
          if (!sameKindRequestEpisode(input.request, input.work.locator, true))
            throw new AccessWorkUnavailableError('Collection Kind audience original episode changed');
          if (permissions.kindAudience!.verifySource.bound(input) === undefined)
            throw new AccessWorkUnavailableError('Accounts Kind audience Source currentness producer');
          if (!liveKindRequest(input.request))
            throw new AccessWorkUnavailableError('Collection Kind audience original formula for Source verification');
          const result = await permissions.kindAudience!.verifySource.run(input);
          if (
            !sameRequest(input.request) ||
            input.work !== originalWork ||
            !exactKindLocator(input.evidence.locator, input.work.locator) ||
            !hasKindOperationRequest(input.request, input.work, input.deadline) ||
            !liveKindRequest(input.request)
          ) {
            if (input.request?.kind === 'authenticated')
              input.request.context.work.fail(
                new AccessWorkUnavailableError('Collection Kind request expired during Source verification'),
              );
            throw new AccessWorkUnavailableError('Collection Kind request expired during Source verification');
          }
          return result;
        },
        actual: permissions.kindAudience!.verifySource.actual,
      }),
    }),
    async prepareReadDecisions(input) {
      if (!validReadDecisionActions(input, actions)) throw new RangeError('Invalid read decision actions');
      const { actor, context } = input;
      const identity = actor.kind === 'account' ? authentication.identity(actor) : undefined;
      if (
        actor.kind === 'account' &&
        !standingAccounts.has(actor) &&
        (!identity || identity.pool !== context.pool || identity.durableTime || identityExpired(identity, clock))
      )
        throw new AccessUnavailableError('overloaded');
      if (
        context.work &&
        actor.kind === 'account' &&
        !(await authentication.refresh(actor, { ...context, ...(input.time ? { time: input.time } : {}) }))
      )
        throw new AccessUnavailableError('overloaded');
      const deadline = Math.min(
        context.deadline,
        identity?.deadline ?? Infinity,
        identity ? identity.observedAt + 180_000 : Infinity,
      );
      const handle = await permissions.prepareReadDecisions!({
        ...input,
        context: {
          ...(context.work ? { work: context.work } : {}),
          ...(context.time ? { time: context.time } : {}),
          pool: deadlineClient(context.pool, deadline) as typeof context.pool,
          deadline,
        },
      });
      const time = readDecisionTime(handle);
      if (time) {
        readTimes.set(context, time);
        gateReads.set(context, { actor, handle, time, checks: new Map() });
      }
      return Object.freeze({
        ...(handle.prepareAccountAuthority
          ? {
              async prepareAccountAuthority(ids: readonly string[]) {
                const authority = await handle.prepareAccountAuthority!(ids);
                return Object.freeze({
                  async decide(...args: Parameters<typeof authority.decide>) {
                    const answer = await authority.decide(deadlineClient(args[0], deadline), args[1], args[2]);
                    requireAccessDeadline(deadline);
                    if (identity && identityExpired(identity, clock)) throw new AccessUnavailableError('deadline');
                    return answer;
                  },
                });
              },
            }
          : {}),
        decide(client, batch, time) {
          // Validation in the inner port always precedes any dependency access.
          // Expiry is bounded again here, including the verified token lifetime.
          return handle.decide(deadlineClient(client, deadline), batch, time).then((decisions) => {
            requireAccessDeadline(deadline);
            if (identity && identityExpired(identity, clock)) throw new AccessUnavailableError('deadline');
            return decisions;
          });
        },
      } satisfies ReadDecisions);
    },
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
  installPreparedAccessCheckWork(access, (actor, action, resource, evidence, dispatch) =>
    nativePreparedAccessCheckWork(permissions, actor, action, resource, evidence, dispatch),
  );
  installAccountStandingCheck(access, (input) => accountStandingCheck(permissions, input));
  installAccessClock(access, clock);
  preparedReadTimes.set(access, readTimes);
  platformGateChecks.set(access, async (actor, requested, clientAction, resource, context, at, client) => {
    requireAccessDeadline(context.deadline);
    if (
      actor.kind !== 'account' ||
      !actor.scopes.includes(clientAction) ||
      !Number.isFinite(Date.parse(at)) ||
      !Number.isFinite(context.deadline) ||
      requested.length === 0 ||
      requested.some((action) => !/^gate:(?:any|[a-z][a-z_-]{0,62})$/.test(action))
    )
      return false;

    if (context.work && (resource.route !== 0 || resource.id !== '00000000-0000-8000-8000-000000000000'))
      context.work.unavailable('Access metered platform gates require the fixed Global Context');
    const shared = gateReads.get(context);
    if (shared && client) {
      const identity = authentication.identity(actor);
      if (
        shared.actor !== actor ||
        authoritativeTimeValue(shared.time) !== at ||
        !identity ||
        identityExpired(identity, clock)
      )
        return false;
      for (const action of [...new Set(requested)]) {
        const key = `${resource.route}/${resource.id}/${action}`;
        let check = context.work ? undefined : shared.checks.get(key);
        if (!check) {
          check = authorizePreparedReadGate(
            shared.handle,
            deadlineClient(client, context.deadline),
            action,
            clientAction,
            resource,
          );
          if (!context.work) shared.checks.set(key, check);
        }
        if (await check) {
          requireAccessDeadline(context.deadline);
          if (identityExpired(identity, clock)) throw new AccessUnavailableError('deadline');
          return true;
        }
      }
      return false;
    }

    if (context.work) {
      if (client)
        return context.work.unavailable(
          'Access metered platform gate requires a shared read window before resource checkout',
        );
      const identity = authentication.identity(actor);
      if (!identity || identity.pool !== context.pool || identityExpired(identity, clock)) return false;
      const deadline = Math.min(context.deadline, identity.deadline);
      let ownedTime: AuthoritativeTime | undefined;
      try {
        const time = context.time ?? (ownedTime = await readNativeAccessTime({ ...context, deadline }, undefined, at));
        if (context.time && authoritativeTimeValue(time) !== at) return false;
        if (!(await authentication.refresh(actor, { ...context, deadline, time }))) return false;
        const native = permissionAccess({
          actions: new Map([...actions, ...requested.map((action) => [action, { anonymous: false }] as const)]),
          resourceRoles: config.resourceRoles,
          accountEvidence: (candidate) => (candidate === actor ? identity.account : undefined),
          ...(config.realmRoleReader ? { realmRoleReader: config.realmRoleReader } : {}),
          ...(config.clock ? { clock: config.clock } : {}),
        });
        const handle = await native.prepareReadDecisions!({
          actor,
          actions: new Set(requested),
          time,
          context: { ...context, deadline, time },
        });
        const evaluate = async (connection: AccessClient) => {
          const bounded = deadlineClient(connection, deadline);
          for (const action of new Set(requested)) {
            if (await authorizePreparedReadGate(handle, bounded, action, clientAction, resource)) {
              if (identityExpired(identity, clock)) throw new AccessUnavailableError('deadline');
              return true;
            }
          }
          return false;
        };
        return await accessCheckout(context.work, () =>
          within(deadline, () =>
            withConnection(context.pool, async (connection) => {
              const bounded = deadlineClient(connection, deadline);
              try {
                await accessTransaction(context.work, bounded, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
                const allowed = await evaluate(bounded);
                await accessTransaction(context.work, bounded, 'COMMIT');
                authoritativeTimeValue(time);
                if (identityExpired(identity, clock)) throw new AccessUnavailableError('deadline');
                return allowed;
              } catch (error) {
                // A failed ledger forbids further dispatch. Release destroys an open
                // transaction's connection below rather than sending unadmitted IO.
                discardConnection(connection, error instanceof Error ? error : new Error('Gate read failed'));
                throw error;
              }
            }),
          ),
        );
      } catch (error) {
        context.work.fail(error);
        throw error;
      } finally {
        if (ownedTime) releaseOperationalTime(ownedTime);
      }
    }
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
    scope: authentication.approvalScope,
    expiry(actor, context) {
      const identity = authentication.identity(actor);
      return identity?.pool === context.pool && identity.durableTime === undefined
        ? { expires: identity.expires, expiryClock: identity.expiryClock }
        : undefined;
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
    return accessCheckout(context.work, () =>
      withConnection(context.pool, (client) =>
        native.authorize(
          client,
          claims.actor,
          'account:manage',
          resource,
          evidence,
          accessCommandAttempt(context)?.time,
        ),
      ),
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
  client?: AccessClient,
): Promise<boolean> {
  return (
    platformGateChecks.get(accessRoot(access))?.(actor, actions, clientAction, resource, context, at, client) ??
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
