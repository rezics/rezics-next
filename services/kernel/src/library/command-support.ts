import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import {
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandEvent,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';

export const WORK_STEP_DEADLINE_MS = 5_000;

/** Shared deadline policy for native Library work steps outside actor commands. */
export function workStepDeadline(): number {
  return deadlineFor(WORK_STEP_DEADLINE_MS);
}

type CommandContext = { transactionId: string; time: AuthoritativeTime };
export type LibraryCommandBody<T> = (
  tx: CommandTransaction,
  command: CommandContext,
) => Promise<{ value: T; events: CommandEvent[] }>;

export type OwnAccountCommand = {
  action: string;
  kind: string;
  requestKey: string;
  input: unknown;
};

export type TrustedAccountCommand = {
  kind: string;
  stepKey: string;
  input: unknown;
};

export class LibraryNotFoundError extends Error {
  constructor() {
    super('Library item not found');
    this.name = 'LibraryNotFoundError';
  }
}

/** Return the route encoded by an ID, mapping invalid IDs to the library not-found result. */
export function requireRoute(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new LibraryNotFoundError();
  return route;
}

/** Keep an ID on its owning account route and conceal foreign or malformed IDs. */
export function sameAccountRoute(accountId: string, id: string): number {
  const accountRoute = requireRoute(accountId);
  if (requireRoute(id) !== accountRoute) throw new LibraryNotFoundError();
  return accountRoute;
}

function digest(identity: unknown, kind: string, input: unknown): Buffer {
  const canonical = canonicalize([identity, kind, input]);
  if (typeof canonical !== 'string') throw new TypeError('Command input must be canonical JSON');
  return createHash('sha256').update(canonical).digest();
}

function ownActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return actor;
}

function activeAccountAuthorization(accountId: string, route: number): CommandAuthorization {
  return {
    action: 'library:account-command',
    resource: Object.freeze({ route, id: accountId }),
    denied: () => new GrantDeniedError(),
    async authorize(tx) {
      try {
        await shareAccount(tx, accountId);
      } catch (error) {
        if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
        throw error;
      }
      const current = await readAccount(tx, route, accountId);
      if (!current || current.kind !== 'actor' || current.state !== 'active') throw new GrantDeniedError();
      return 'execute';
    },
  };
}

/** Shared command boundary for account-owned library data and durable workflow steps. */
export function createLibraryCommandRunner(config: { pool: Pool; clock?: KernelClock }) {
  const { pool, clock } = config;

  async function ownAccount<T>(
    actor: Actor,
    request: OwnAccountCommand,
    body: LibraryCommandBody<T>,
  ): Promise<CommandOutcome<T>> {
    const owner = ownActor(actor);
    const route = routeOf(owner.accountId);
    if (route === null) throw new GrantDeniedError();
    const identity = principalCommandIdentity(owner);
    const authorization: CommandAuthorization = {
      action: request.action,
      resource: Object.freeze({ route, id: owner.accountId }),
      denied: () => new GrantDeniedError(),
      async authorize(tx) {
        try {
          await shareAccount(tx, owner.accountId);
        } catch (error) {
          if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
          throw error;
        }
        const current = await readAccount(tx, route, owner.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(owner.authnEpoch) ||
          owner.authnEpoch <= 0 ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch) ||
          !owner.scopes.includes(request.action)
        )
          throw new GrantDeniedError();
        return 'execute';
      },
    };

    return runCommand(
      pool,
      {
        ...identity,
        partition: partitionOf(route),
        deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
        clock,
        receipt: {
          kind: request.kind,
          key: request.requestKey,
          digest: digest(identity, request.kind, request.input),
        },
        authorization,
      },
      body,
    );
  }

  async function trustedAccount<T>(
    accountId: string,
    request: TrustedAccountCommand,
    body: LibraryCommandBody<T>,
  ): Promise<CommandOutcome<T>> {
    const route = routeOf(accountId);
    if (route === null) throw new GrantDeniedError();
    const identity = Object.freeze({
      principal: Object.freeze({ kind: 'account' as const, id: accountId }),
      basis: null,
    });

    return runCommand(
      pool,
      {
        partition: partitionOf(route),
        deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
        clock,
        receipt: {
          actorAccountId: accountId,
          kind: request.kind,
          key: request.stepKey,
          digest: digest(identity, request.kind, request.input),
        },
        authorization: activeAccountAuthorization(accountId, route),
      },
      body,
    );
  }

  return { ownAccount, trustedAccount };
}
