import type { Pool, PoolClient } from 'pg';
import type { ResourceRoleCatalogue } from '../access/resource-roles.ts';
import { commandTime, type AuthoritativeTime, type CommandAuthorization } from '../command/command.ts';
import type { ResourceEligibility } from '../access/eligibility.ts';

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

export type ActionCatalogue = ReadonlyMap<string, { anonymous: boolean; replay?: 'self-account-read' }>;

/** Actions available to an access implementation for one application. */
export type AccessConfig = { actions: ActionCatalogue; resourceRoles?: ResourceRoleCatalogue };

/** Builds an access implementation from an application's configuration. */
export type AccessFactory = (config: AccessConfig) => Access;

export type AccessContext = { pool: Pool; deadline: number };

export type AccessClient = Pick<PoolClient, 'query'>;
export type AccessCheck = (client: AccessClient, time?: AuthoritativeTime) => Promise<boolean>;
export type AccessCommandAuthorization = CommandAuthorization & { readonly check: AccessCheck };

export interface Access {
  authenticate(token: string, context: AccessContext): Promise<AccountActor>;
  prepare?(actor: Actor, action: string, resource: Resource, context: AccessContext): Promise<unknown>;
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

/** Prepare request evidence once. The command boundary invokes the final formula
 * on every real attempt, at its trusted T, before looking up any receipt.
 * The explicit self-read exception can retrieve a receipt but never run a body.
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
  let check: AccessCheck = async () => false;
  let selfRead: AccessCheck | undefined;
  try {
    check = await accessCheck(access, actor, action, target, context);
    if (actor.kind === 'account' && access.replayAuthorization?.(action) === 'self-account-read') {
      selfRead = await accessCheck(
        access,
        actor,
        'account:read',
        {
          route: Number.parseInt(actor.accountId.slice(24, 28), 16),
          id: actor.accountId,
        },
        context,
      );
    }
  } catch {
    // Failure to obtain independently anchored evidence denies at the boundary.
  }
  return {
    action,
    resource: target,
    denied,
    check,
    async authorize(tx, attempt) {
      if (
        actor.kind === 'account' &&
        (attempt.basis?.actorAccountId !== actor.accountId ||
          attempt.basis.clientId !== actor.clientId ||
          attempt.basis.requestedBy !== actor.requestedBy)
      )
        throw denied();
      if (await check(tx, attempt.time)) return 'execute';
      if (selfRead && (await selfRead(tx, attempt.time))) return 'receipt-only';
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
