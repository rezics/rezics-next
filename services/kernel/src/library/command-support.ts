import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { Bound } from '@rezics/bounds';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { readAccount, readAccountCommandState } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import {
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAttempt,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandResult,
  type CommandTransaction,
  type PrincipalCommandIdentity,
} from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { accessCommandAuthorization, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { receiptKeysFor } from '../command/receipt-key.ts';
import {
  currentCommandWorkAssociation,
  currentLibraryOperationAccounting,
  withLibraryOperationAccounting,
} from '../command/work-context.ts';
import {
  consumeSessionWork,
  sessionCommandPlan,
  sessionShelfWork,
  withSessionCommandPlan,
  type SessionOperationKind,
} from './session-operation-bounds.ts';

import { enterShelfWrite } from './shelf-maintenance-runtime.ts';
import {
  consumeFollowWork,
  followAccountAuthorizationWork,
  followCommandPlan,
  followNativeWork,
  withFollowCommandWork,
} from './follow-operation-bounds.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';

export { WORK_STEP_DEADLINE_MS };

/** Bind a closed Library SQL declaration to the caller's existing accounting frame. */
export function runLibraryBoundedStep<T>(operation: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  if (!association) return dispatch();
  const { engineRequests: _engineRequests, ...work } = bound;
  return association.run(operation, work, dispatch);
}

/** Reserve one complete Library operation, then run its leaves on the same caller-owned resources. */
export async function runLibraryBoundedOperation<T>(
  operation: string,
  bound: Bound,
  dispatch: () => Promise<T>,
): Promise<T> {
  if (currentLibraryOperationAccounting()) return dispatch();
  const association = currentCommandWorkAssociation();
  // The existing native association accepts eight axes; engineRequests stays in the full operation declaration.
  const { engineRequests: _engineRequests, ...work } = bound;
  const reservation = association?.reserve(operation, work);
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reservation?.settle();
  };
  try {
    const result = await withLibraryOperationAccounting(operation, dispatch);
    settle();
    return result;
  } catch (error) {
    settle();
    throw error;
  }
}

/** Shared deadline policy for native Library work steps outside actor commands. */
export function workStepDeadline(): number {
  return currentCommandWorkAssociation()?.deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
}

type CommandContext = { transactionId: string; time: AuthoritativeTime };
export type LibraryCommandBody<T> = (tx: CommandTransaction, command: CommandContext) => Promise<CommandResult<T>>;

export type OwnAccountCommand = {
  action: string;
  kind: string;
  requestKey: string;
  input: unknown;
  /** Local cost owners may bind this execution to their existing descriptor. */
  execution?: LibraryCommandExecutionBinding;
  /** Complete static operation cost, separate from a custom caller execution wrapper. */
  executionPlan?: LibraryCommandExecutionPlan;
  sessionOperation?: SessionOperationKind;
  sessionPreparation?: boolean;
  deadline?: number;
  followOperation?: true;
};

export type TrustedAccountCommand = {
  kind: string;
  stepKey: string;
  input: unknown;
  /** Local cost owners may bind this execution to their existing descriptor. */
  execution?: LibraryCommandExecutionBinding;
  /** Complete static operation cost, separate from a custom caller execution wrapper. */
  executionPlan?: LibraryCommandExecutionPlan;
  followOperation?: true;
  deadline?: number;
};

/** Wrap an existing Library command without changing its identity, authorization,
 * deadline, attempts, transaction, or result handling. This is a local cost
 * binding seam, not another admission or funding protocol.
 */
export type LibraryCommandExecutionPlan = Readonly<{ operation: string; total: Bound }>;
export type LibraryCommandExecutionBinding = <T>(
  dispatch: () => Promise<T>,
  plan?: LibraryCommandExecutionPlan,
) => Promise<T>;

export function runLibraryCommand<T>(
  dispatch: () => Promise<T>,
  bind?: LibraryCommandExecutionBinding,
  plan?: LibraryCommandExecutionPlan,
): Promise<T> {
  const execute = () => (bind ? bind(dispatch, plan) : dispatch());
  return plan ? runLibraryBoundedOperation(plan.operation, plan.total, execute) : execute();
}

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

export function libraryCommandReceiptDigest(identity: PrincipalCommandIdentity, kind: string, input: unknown): string {
  return digest(identity, kind, input).toString('hex');
}

export function libraryCommandReceiptDigestForActor(actor: Actor, kind: string, input: unknown): string {
  return libraryCommandReceiptDigest(principalCommandIdentity(ownActor(actor)), kind, input);
}

function ownActor(actor: Actor): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null) throw new GrantDeniedError();
  return actor;
}

function activeAccountAuthorization(accountId: string, route: number, follow = false): CommandAuthorization {
  return {
    action: 'library:account-command',
    resource: Object.freeze({ route, id: accountId }),
    denied: () => new GrantDeniedError(),
    async authorize(tx) {
      const authorize = async () => {
        try {
          await shareAccount(tx, accountId);
        } catch (error) {
          if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
          throw error;
        }
        const current = await readAccountCommandState(tx, route, accountId);
        if (!current || current.kind !== 'actor' || current.state !== 'active') throw new GrantDeniedError();
        return 'execute' as const;
      };
      return follow
        ? consumeFollowWork('authorize', followAccountAuthorizationWork(accountId), authorize)
        : authorize();
    },
  };
}

/** Shared command boundary for account-owned library data and durable workflow steps. */
export function createLibraryCommandRunner(config: { pool: Pool; clock?: KernelClock; access?: Access }) {
  const { pool, clock } = config;

  class ReceiptNotFoundError extends Error {}

  async function runOwnAccount<T>(
    actor: Actor,
    request: OwnAccountCommand,
    body: LibraryCommandBody<T>,
    prepare?: CommandAuthorization['prepare'],
    authorizePrepared?: (tx: CommandTransaction, attempt: CommandAttempt) => Promise<void>,
    receiptOnly?: Buffer,
  ): Promise<CommandOutcome<T>> {
    const owner = ownActor(actor);
    const route = routeOf(owner.accountId);
    if (route === null) throw new GrantDeniedError();
    const identity = principalCommandIdentity(owner);
    const deadline = request.deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
    const plan =
      request.sessionOperation === undefined
        ? undefined
        : sessionCommandPlan(
            request.sessionOperation,
            {
              accountId: owner.accountId,
              clientId: owner.clientId,
              requestedBy: owner.requestedBy ?? null,
              kind: request.kind,
              key: request.requestKey,
              input: request.input,
            },
            receiptKeysFor(pool).keys.size,
            request.sessionPreparation ?? false,
            Math.max(0, deadline - Date.now()),
          );
    const followPlan = request.followOperation
      ? followCommandPlan(
          {
            accountId: owner.accountId,
            clientId: owner.clientId,
            requestedBy: owner.requestedBy,
            kind: request.kind,
            key: request.requestKey,
            input: request.input,
          },
          deadline,
        )
      : undefined;
    // Capture original command identity before any permission preparation awaits.
    const commandInput = followPlan?.original.input ?? plan?.original.input ?? request.input;
    const native = config.access
      ? await accessCommandAuthorization(
          config.access,
          owner,
          request.action,
          { route, id: owner.accountId },
          {
            pool,
            deadline,
            ...(request.followOperation && currentCommandWorkAssociation()
              ? { work: currentCommandWorkAssociation()!.access }
              : {}),
          },
          () => new GrantDeniedError(),
        )
      : undefined;
    const authorization: CommandAuthorization = {
      action: request.action,
      resource: Object.freeze({ route, id: owner.accountId }),
      denied: () => (receiptOnly ? new ReceiptNotFoundError() : new GrantDeniedError()),
      async prepare(attempt) {
        await plan?.consumeAttempt();
        const evidence = await native?.prepare?.(attempt);
        await prepare?.(attempt);
        return evidence;
      },
      async authorize(tx, attempt, evidence) {
        const reservation = request.followOperation
          ? currentCommandWorkAssociation()?.reserve(
              'library.follow.authorize',
              followNativeWork(followAccountAuthorizationWork(owner.accountId)).dimensions,
            )
          : undefined;
        try {
          try {
            await shareAccount(tx, owner.accountId);
          } catch (error) {
            if (error instanceof LifecycleDeniedError) throw new GrantDeniedError();
            throw error;
          }
          const accessWork = currentCommandWorkAssociation()?.access;
          const current =
            accessWork && !request.followOperation && !request.executionPlan
              ? await readAccount(tx, route, owner.accountId, accessWork)
              : await readAccountCommandState(tx, route, owner.accountId);
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
          if (receiptOnly) {
            if (native && (await native.authorize(tx, attempt, evidence)) !== 'execute') throw new GrantDeniedError();
            await authorizePrepared?.(tx, attempt);
            return 'receipt-only';
          }
          await authorizePrepared?.(tx, attempt);
          if (native && (await native.authorize(tx, attempt, evidence)) !== 'execute') throw new GrantDeniedError();
          return 'execute';
        } finally {
          reservation?.settle();
        }
      },
    };

    const execute = () =>
      withRequestDeadline(deadline, () =>
        runCommand(
          pool,
          {
            ...identity,
            partition: partitionOf(route),
            deadline,
            clock,
            receipt: {
              kind: request.kind,
              key: request.requestKey,
              digest: receiptOnly ?? digest(identity, request.kind, commandInput),
            },
            authorization,
          },
          async (tx, command) => {
            const enter = () => enterShelfWrite(tx, { route, accountId: owner.accountId });
            if (plan) await consumeSessionWork('shelf-gate', sessionShelfWork(route, owner.accountId, false), enter);
            else if (followPlan)
              await consumeFollowWork('shelf', sessionShelfWork(route, owner.accountId, false), enter);
            else await enter();
            return body(tx, command);
          },
        ),
      );
    return runLibraryCommand(
      () =>
        followPlan
          ? withFollowCommandWork(followPlan, execute)
          : plan
            ? withSessionCommandPlan(plan, execute)
            : execute(),
      request.execution,
      request.executionPlan,
    );
  }

  async function ownAccount<T>(
    actor: Actor,
    request: OwnAccountCommand,
    body: LibraryCommandBody<T>,
  ): Promise<CommandOutcome<T>> {
    return runOwnAccount(actor, request, body);
  }

  /** Trusted read preparation precedes owner checkout; current owner authorization
   * still precedes receipt replay. Return deferred business errors as evidence
   * and throw them in the fresh body, so they cannot invalidate an exact replay.
   */
  async function ownAccountPrepared<P, T>(
    actor: Actor,
    request: OwnAccountCommand & { prepare: (attempt: CommandAttempt) => Promise<P> },
    body: (tx: CommandTransaction, context: CommandContext, prepared: P) => Promise<CommandResult<T>>,
    authorizePrepared?: (tx: CommandTransaction, attempt: CommandAttempt, prepared: P) => Promise<void>,
  ): Promise<CommandOutcome<T>> {
    // Native T is fresh on retry. Evidence belongs only to this invocation and T.
    const preparations = new WeakMap<AuthoritativeTime, { value: P }>();
    return runOwnAccount(
      actor,
      request,
      (tx, context) => {
        const prepared = preparations.get(context.time);
        if (!prepared) throw new Error('Missing Library command preparation for native attempt');
        return body(tx, context, prepared.value);
      },
      async (attempt) => {
        preparations.set(attempt.time, { value: await request.prepare(attempt) });
      },
      async (tx, attempt) => {
        const prepared = preparations.get(attempt.time);
        if (!prepared) throw new Error('Missing Library command preparation for native authorization');
        await authorizePrepared?.(tx, attempt, prepared.value);
      },
    );
  }

  async function ownAccountReceiptOnly<P, T>(
    actor: Actor,
    request: {
      action: string;
      kind: string;
      requestKey: string;
      digest: string;
      prepare: (attempt: CommandAttempt) => Promise<P>;
      authorize: (tx: CommandTransaction, attempt: CommandAttempt, prepared: P) => Promise<void>;
    },
  ): Promise<CommandOutcome<T> | null> {
    if (!/^[0-9a-f]{64}$/.test(request.digest)) throw new TypeError('Invalid native receipt digest');
    const preparations = new WeakMap<AuthoritativeTime, { value: P }>();
    try {
      return await runOwnAccount(
        actor,
        { action: request.action, kind: request.kind, requestKey: request.requestKey, input: null },
        async () => {
          throw new TypeError('A receipt-only Library command cannot execute a body');
        },
        async (attempt) => {
          preparations.set(attempt.time, { value: await request.prepare(attempt) });
        },
        async (tx, attempt) => {
          const prepared = preparations.get(attempt.time);
          if (!prepared) throw new TypeError('Missing Library receipt preparation');
          await request.authorize(tx, attempt, prepared.value);
        },
        Buffer.from(request.digest, 'hex'),
      );
    } catch (error) {
      if (error instanceof ReceiptNotFoundError) return null;
      throw error;
    }
  }

  async function trustedAccount<T>(
    accountId: string,
    request: TrustedAccountCommand,
    body: LibraryCommandBody<T>,
    prepare?: CommandAuthorization['prepare'],
  ): Promise<CommandOutcome<T>> {
    const route = routeOf(accountId);
    if (route === null) throw new GrantDeniedError();
    const identity = Object.freeze({
      principal: Object.freeze({ kind: 'account' as const, id: accountId }),
      basis: null,
    });

    const deadline = request.deadline ?? workStepDeadline();
    const followPlan = request.followOperation
      ? followCommandPlan(
          {
            accountId,
            clientId: null,
            requestedBy: null,
            kind: request.kind,
            key: request.stepKey,
            input: request.input,
          },
          deadline,
        )
      : undefined;

    return runLibraryCommand(
      () => {
        const execute = () =>
          runCommand(
            pool,
            {
              partition: partitionOf(route),
              deadline,
              clock,
              receipt: {
                actorAccountId: accountId,
                kind: request.kind,
                key: request.stepKey,
                digest: digest(identity, request.kind, followPlan?.original.input ?? request.input),
              },
              authorization: {
                ...activeAccountAuthorization(accountId, route, request.followOperation),
                ...(prepare ? { prepare } : {}),
              },
            },
            async (tx, command) => {
              const enter = () => enterShelfWrite(tx, { route, accountId });
              if (followPlan) await consumeFollowWork('shelf', sessionShelfWork(route, accountId, false), enter);
              else await enter();
              return body(tx, command);
            },
          );
        return followPlan ? withFollowCommandWork(followPlan, execute) : execute();
      },
      request.execution,
      request.executionPlan,
    );
  }

  return { ownAccount, ownAccountPrepared, ownAccountReceiptOnly, trustedAccount };
}
