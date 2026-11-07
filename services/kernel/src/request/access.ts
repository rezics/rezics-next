import { AuthenticationError } from './authentication-error.ts';
export { AuthenticationError } from './authentication-error.ts';
import { accessCheck } from '../access/check.ts';
export {
  accessCheck,
  accessExplicitCheck,
  prepareReadDecisions,
  resourcePage,
  validReadDecisionActions,
  installPreparedAccessCheckWork,
  nativePreparedAccessCheckWork,
} from '../access/check.ts';
import type { AccessWorkAccounting, AccessWorkProducer } from '../access/work.ts';
import type { ContentEditionBenefit, ContentEditionBuyerFactReader } from '../access/authenticated-benefit.ts';
import { throwAccessUnavailable } from '../access/unavailable.ts';
import { hasOriginalAuthenticator } from '../access/authentication-work.ts';
import type { Pool, PoolClient } from 'pg';
import { commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import type { ResourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  commandTime,
  authoritativeTimeValue,
  type CommandAttempt,
  type AuthoritativeTime,
  type CommandAuthorization,
} from '../command/command.ts';
import type { ResourceEligibility } from '../access/eligibility.ts';
import { permissionHistoryAccounts } from '../access/permission.ts';
import type { KindAudienceAccess } from '../access/kind-audience.ts';
import { bindCommandHistoryEvidence } from '../history/application/index.ts';
import { type AccountReference } from '../history/contract/index.ts';
export type * from '../access/kind-audience.ts';

export type AccountActor = {
  kind: 'account';
  accountId: string;
  clientId: string;
  scopes: readonly string[];
  requestedBy: string | null;
  authnEpoch: number;
};

export type Actor = AccountActor | { kind: 'anonymous' };

/** Server-only eligibility cannot be recovered from request JSON. */
export type Resource = {
  route: number;
  id: string;
  /** Server-only exact selector, never entitlement evidence. */
  authenticatedBenefit?: ContentEditionBenefit;
  eligibility?: ResourceEligibility;
  /** Compatibility spelling; uses the same opaque capability and evaluator. */
  anonymousEligibility?: ResourceEligibility;
};

/** One trusted homogeneous resource page, copied before evidence preparation. */
export type ResourcePage = Readonly<{
  route: number;
  resourceType: string;
  ids: readonly string[];
}>;

export type ActionMetadata = {
  anonymous: boolean;
  replay?: 'self-account-read';
  /** Mounted personal actions use the verified acting account's native owner authority. */
  authority?: 'own-account';
  /** Resource types the command initializes. Absent means it initializes none. */
  'x-resource-types'?: readonly string[];
};
export type ActionCatalogue = ReadonlyMap<string, ActionMetadata>;

/** Server-owned Realm membership proofs. The permission formula calls this on the
 * released Realm anchor; a missing reader denies Realm group matches.
 */
export type AccessRealmRoleReader = ((
  client: AccessClient,
  input: { realmId: string; accountId: string; at: string },
) => Promise<readonly { role: 'owner' | 'member'; member: boolean; valid: string }[] | null>) & {
  work?: AccessWorkProducer<
    { realmId: string; accountId: string; at: string },
    readonly { role: 'owner' | 'member'; member: boolean; valid: string }[] | null
  >;
  batchWork?: AccessWorkProducer<
    { pairs: readonly { realmId: string; accountId: string }[]; at: string },
    readonly { realmId: string; accountId: string; role: 'owner' | 'member'; member: boolean; valid: string }[] | null
  >;
  /** One trusted statement for all admitted Realm/member anchors. */
  batch?: (
    client: AccessClient,
    input: { pairs: readonly { realmId: string; accountId: string }[]; at: string },
  ) => Promise<
    readonly { realmId: string; accountId: string; role: 'owner' | 'member'; member: boolean; valid: string }[] | null
  >;
};

/** Actions available to an access implementation for one application. */
export type AccessConfig = {
  actions: ActionCatalogue;
  resourceRoles?: ResourceRoleCatalogue;
  realmRoleReader?: AccessRealmRoleReader;
  /** Trusted Commerce current native reader; never supplied by HTTP input. */
  contentEditionBuyerFactReader?: ContentEditionBuyerFactReader;
  /** Commerce owns the finite footprint and actual receipt of its callback. */
  contentEditionBuyerFactWork?: AccessWorkProducer<
    Parameters<ContentEditionBuyerFactReader>[0],
    Awaited<ReturnType<ContentEditionBuyerFactReader>>
  >;
  /** Outside a command, permission checks bind this instant. Absent uses PostgreSQL clock_timestamp(). */
  clock?: () => Date;
};

/** Builds an access implementation from an application's configuration. */
export type AccessFactory = (config: AccessConfig) => Access;

export type AccessContext = {
  pool: Pool;
  deadline: number;
  time?: AuthoritativeTime;
  /** Trusted accounting only; never permission, identity or an extra allowance. */
  work?: AccessWorkAccounting;
};

export type AccessClient = Pick<PoolClient, 'query'>;
/** Ordinary permission plus the same formula with public floor and grant roles disabled. */
export type AccessDecision = Readonly<{ allowed: boolean; explicit: boolean }>;
export type AccessExplicitCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<AccessDecision>;
/** Trusted owner callback, evaluated at the formula's snapshot instant. UUIDs have no
 * resource-kind tag: the owner supplies the homogeneous resourceType and ids. */
export type ReadDecisionEligibility = ((
  client: AccessClient,
  ids: readonly string[],
  at: string,
) => Promise<Readonly<Record<string, boolean>>>) & {
  work?: AccessWorkProducer<
    Readonly<{ client: AccessClient; ids: readonly string[]; at: string }>,
    Readonly<Record<string, boolean>>
  >;
};
export type ReadDecisionInput = Readonly<{
  action: string;
  resourceType: string;
  ids: readonly string[];
  eligibility?: ReadDecisionEligibility;
}>;
/** Native, server-only operation binding. Only the installed evaluator produces
 * this handle; no request field, callback or authorization boolean is accepted. */
export type AccountAuthorityKind = 'profile' | 'self' | 'verification';
export type AccountAuthorityDecision = AccessDecision & { action: string };
export type AccountAuthority = Readonly<{
  decide(
    client: AccessClient,
    input: { kind: AccountAuthorityKind; action: string; ids: readonly string[] },
    time?: AuthoritativeTime,
  ): Promise<Readonly<Record<string, AccountAuthorityDecision>>>;
}>;
export type ReadDecisions = Readonly<{
  /** Prepare native Account/foreign-operator formula pages before target checkout. */
  prepareAccountAuthority?(ids: readonly string[]): Promise<AccountAuthority>;
  decide(
    client: AccessClient,
    input: ReadDecisionInput,
    time?: AuthoritativeTime,
  ): Promise<Readonly<Record<string, AccessDecision>>>;
}>;
export type PrepareReadDecisionsInput = {
  actor: Actor;
  actions: ReadonlySet<string>;
  /** Composed candidate sets for a mixed-type read; each type remains bounded to 64. */
  typeActions?: ReadonlyMap<string, ReadonlySet<string>>;
  /** Shared authoritative instant for a personal batch. */
  time?: AuthoritativeTime;
  context: AccessContext;
};
export type PreparedAccessCheckInvocation = Readonly<{
  client: AccessClient;
  time: AuthoritativeTime;
  work: AccessWorkAccounting;
}>;
export type PreparedAccessCheckWork = AccessWorkProducer<PreparedAccessCheckInvocation, boolean> &
  Readonly<{
    run(input: PreparedAccessCheckInvocation): Promise<boolean>;
  }>;
export type AccessCheck = ((client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>) &
  Readonly<{
    work?: PreparedAccessCheckWork;
  }>;
export type AccessCommandAuthorization = CommandAuthorization & { readonly check: AccessCheck };

export interface Access {
  /** Native Kind origin/evidence only; optional for existing mocks/adapters.
   * The original factory is staged unavailable before IO until owner bodies exist.
   */
  readonly kindAudience?: KindAudienceAccess;
  /** Authentication has no authorization-time input; preserve its native request contract. */
  authenticate(token: string, context: { pool: Pool; deadline: number }): Promise<AccountActor>;
  prepareReadDecisions?(input: PrepareReadDecisionsInput): Promise<ReadDecisions>;
  prepare?(actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
  preparePage?(actor: Actor, action: string, page: ResourcePage, context: AccessContext): Promise<unknown>;
  authorizePage?(
    client: AccessClient,
    actor: Actor,
    action: string,
    page: ResourcePage,
    evidence?: unknown,
    time?: AuthoritativeTime,
  ): Promise<boolean>;
  /** Optional explicit projection of the installed formula for a resource or homogeneous page. */
  authorizeExplicit?(
    client: AccessClient,
    actor: Actor,
    action: string,
    resource: Resource | ResourcePage,
    evidence?: unknown,
    time?: AuthoritativeTime,
  ): Promise<AccessDecision>;
  /** Derived only from the installed action catalogue's explicit declaration. */
  replayAuthorization?(action: string): 'self-account-read' | undefined;
  authorize(
    client: AccessClient,
    actor: Actor,
    action: string,
    resource: Resource,
    evidence?: unknown,
    time?: AuthoritativeTime,
  ): Promise<boolean>;
}

/** Recheck command admission and prepare fresh evidence on every live attempt
 * before resource checkout. The stable check wrapper always uses the current
 * attempt's evidence, including body checks captured before execution. A retry
 * does not renew the request: each attempt's context copies the fixed request
 * deadline, and its evidence budget is capped by it and by JWT expiry, so no
 * attempt's evidence outlives the request. Self-read permits receipt lookup
 * only, never a body.
 */
export async function accessCommandAuthorization(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
  denied: () => Error,
): Promise<AccessCommandAuthorization> {
  const target = Object.freeze({ ...resource });
  type Prepared = {
    attempt: CommandAttempt;
    check: AccessCheck;
    selfRead?: AccessCheck;
    historyAccounts: readonly AccountReference[] | undefined;
  };
  const proofs = new WeakMap<object, Prepared>();
  let current: Prepared | undefined;
  const check: AccessCheck = async (client, time = commandTime(client)) => {
    if (!current || time !== current.attempt.time || commandTime(client) !== time) return false;
    authoritativeTimeValue(time);
    return current.check(client, time);
  };
  return {
    action,
    resource: target,
    denied,
    check,
    async prepare(attempt) {
      current = undefined;
      let preparation: AccessContext;
      try {
        preparation = commandAccessContext(context, attempt);
        await requireCommandAdmission(access, actor, preparation);
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        if (error instanceof AuthenticationError) throw error;
        throw denied();
      }
      try {
        const evidence = access.prepare ? await access.prepare(actor, action, target, preparation) : null;
        const prepared: Prepared = {
          attempt,
          check: (client, time) => access.authorize(client, actor, action, target, evidence, time),
          historyAccounts: permissionHistoryAccounts(evidence, actor, action, target),
        };
        if (actor.kind === 'account' && access.replayAuthorization?.(action) === 'self-account-read') {
          prepared.selfRead = await accessCheck(
            access,
            actor,
            'account:read',
            {
              route: Number.parseInt(actor.accountId.slice(24, 28), 16),
              id: actor.accountId,
            },
            preparation,
          );
        }
        const proof = Object.freeze({});
        proofs.set(proof, prepared);
        return proof;
      } catch (error) {
        throwAccessUnavailable(error, context.deadline);
        throw denied();
      }
    },
    async authorize(tx, attempt, proof) {
      const prepared = typeof proof === 'object' && proof !== null ? proofs.get(proof) : undefined;
      if (typeof proof === 'object' && proof !== null) proofs.delete(proof);
      if (!prepared || prepared.attempt !== attempt || commandTime(tx) !== attempt.time) throw denied();
      if (
        actor.kind === 'anonymous' &&
        (target.eligibility === undefined ||
          !attempt.basis ||
          !('principal' in attempt.basis) ||
          attempt.basis.principal.kind !== 'anonymous' ||
          attempt.basis.actorAccountId !== null ||
          attempt.basis.clientId !== null ||
          attempt.basis.requestedBy !== null)
      )
        throw denied();
      if (
        actor.kind === 'account' &&
        (attempt.basis?.actorAccountId !== actor.accountId ||
          attempt.basis.clientId !== actor.clientId ||
          attempt.basis.requestedBy !== actor.requestedBy)
      )
        throw denied();
      current = prepared;
      if (await check(tx, attempt.time)) {
        if (prepared.historyAccounts) bindCommandHistoryEvidence(tx, prepared.historyAccounts);
        return 'execute';
      }
      if (prepared.selfRead && (await prepared.selfRead(tx, attempt.time))) return 'receipt-only';
      throw denied();
    },
  };
}

const invalidRequest = () => new AuthenticationError(400, 'Bearer error="invalid_request"');

export async function actorOf(access: Access, request: Request, context: AccessContext): Promise<Actor> {
  const authorization = request.headers.get('authorization');
  if (authorization === null) return { kind: 'anonymous' };

  const scheme = /^([^\s]+)(?:[ \t]+|$)/.exec(authorization)?.[1];
  if (scheme?.toLowerCase() !== 'bearer') {
    throw new AuthenticationError(401, 'Bearer');
  }

  const credentials = /^Bearer[ \t]+([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization);
  if (!credentials) throw invalidRequest();
  if (context.work && !hasOriginalAuthenticator(access.authenticate))
    context.work.unavailable('Auth bearer authentication native work producer');
  return access.authenticate(credentials[1]!, context);
}

export const anonymousAccess: Access = {
  async authenticate() {
    throw new AuthenticationError(401, 'Bearer error="invalid_token"');
  },
  async authorize(_client, _actor, action) {
    return action.endsWith(':read');
  },
};
