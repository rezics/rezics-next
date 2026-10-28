import { AccessUnavailableError } from '../access/unavailable.ts';
import { accessRoot } from '../access/derived-access.ts';
import { throwAccessUnavailable } from '../access/unavailable.ts';
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
import { routeOf } from '../route/route.ts';

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

/** Reject malformed pages synchronously, before any database or actor read. */
export function resourcePage(page: ResourcePage): ResourcePage {
  if (
    !page ||
    !Number.isInteger(page.route) ||
    page.route < 0 ||
    page.route > 65535 ||
    typeof page.resourceType !== 'string' ||
    page.resourceType.length === 0 ||
    !Array.isArray(page.ids) ||
    page.ids.length < 1 ||
    page.ids.length > 100 ||
    page.ids.some((id) => typeof id !== 'string' || routeOf(id) !== page.route) ||
    new Set(page.ids).size !== page.ids.length
  )
    throw new RangeError('Invalid resource page');
  return Object.freeze({
    route: page.route,
    resourceType: page.resourceType,
    ids: Object.freeze([...page.ids].sort()),
  });
}

export type ActionMetadata = {
  anonymous: boolean;
  replay?: 'self-account-read';
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
  /** Outside a command, permission checks bind this instant. Absent uses PostgreSQL clock_timestamp(). */
  clock?: () => Date;
};

/** Builds an access implementation from an application's configuration. */
export type AccessFactory = (config: AccessConfig) => Access;

export type AccessContext = { pool: Pool; deadline: number };

export type AccessClient = Pick<PoolClient, 'query'>;
/** Ordinary permission plus the same formula with public floor and grant roles disabled. */
export type AccessDecision = Readonly<{ allowed: boolean; explicit: boolean }>;
export type AccessExplicitCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<AccessDecision>;
/** Trusted owner callback, evaluated at the formula's snapshot instant. UUIDs have no
 * resource-kind tag: the owner supplies the homogeneous resourceType and ids. */
export type ReadDecisionEligibility = (
  client: AccessClient,
  ids: readonly string[],
  at: string,
) => Promise<Readonly<Record<string, boolean>>>;
export type ReadDecisionInput = Readonly<{
  action: string;
  resourceType: string;
  ids: readonly string[];
  eligibility?: ReadDecisionEligibility;
}>;
export type ReadDecisions = Readonly<{
  decide(
    client: AccessClient,
    input: ReadDecisionInput,
    time?: AuthoritativeTime,
  ): Promise<Readonly<Record<string, AccessDecision>>>;
}>;
export type PrepareReadDecisionsInput = {
  actor: Actor;
  actions: ReadonlySet<string>;
  context: AccessContext;
};
export type AccessCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>;
export type AccessCommandAuthorization = CommandAuthorization & { readonly check: AccessCheck };

export interface Access {
  authenticate(token: string, context: AccessContext): Promise<AccountActor>;
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

export async function accessCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
): Promise<AccessCheck> {
  const evidence = access.prepare ? await access.prepare(actor, action, resource, context) : null;
  return (client, time = commandTime(client)) => access.authorize(client, actor, action, resource, evidence, time);
}

/** Resolve the installed port through derived adapters; never infer explicit
 * authority from an adapter's ordinary boolean decision. */
export async function accessExplicitCheck(
  access: Access,
  actor: Actor,
  action: string,
  resource: Resource,
  context: AccessContext,
): Promise<AccessExplicitCheck> {
  const root = accessRoot(access);
  if (!root.authorizeExplicit) return async () => ({ allowed: false, explicit: false });
  const evidence = root.prepare ? await root.prepare(actor, action, resource, context) : null;
  return (client, time = commandTime(client)) =>
    root.authorizeExplicit!(client, actor, action, resource, evidence, time);
}

/** The installed root owns the sole batch read formula, including through adapters. */
export async function prepareReadDecisions(access: Access, input: PrepareReadDecisionsInput): Promise<ReadDecisions> {
  const root = accessRoot(access);
  if (!root.prepareReadDecisions) throw new AccessUnavailableError('overloaded');
  return root.prepareReadDecisions(input);
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
  type Prepared = { attempt: CommandAttempt; check: AccessCheck; selfRead?: AccessCheck };
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
      try {
        const preparation = commandAccessContext(context, attempt);
        await requireCommandAdmission(access, actor, preparation);
        const prepared: Prepared = { attempt, check: await accessCheck(access, actor, action, target, preparation) };
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
      if (await check(tx, attempt.time)) return 'execute';
      if (prepared.selfRead && (await prepared.selfRead(tx, attempt.time))) return 'receipt-only';
      throw denied();
    },
  };
}

export class AuthenticationError extends Error {
  readonly status: 400 | 401;
  readonly challenge: string;

  constructor(status: 400 | 401, challenge: string) {
    super('Authentication failed');
    this.name = 'AuthenticationError';
    this.status = status;
    this.challenge = challenge;
  }
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
