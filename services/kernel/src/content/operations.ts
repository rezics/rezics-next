import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type AccountActor, type Actor } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type {
  AuthorErasureDependencies,
  AuthorErasureInput,
  CommandRequestContext,
  NativeWorkflowStatus,
  Operation,
  OperationProgress,
  RequestContext,
} from './operation-contract.ts';
import createOperation from './create-erasure-operation.sql';
import readEndpoints from './read-first-erasure-post.sql';
import readIdentity from './read-erasure-operation.sql';

function accountAllowed(account: Awaited<ReturnType<typeof readAccount>>, actor: AccountActor): boolean {
  return (
    !!account &&
    account.kind === 'actor' &&
    account.state === 'active' &&
    !account.fenced &&
    Number.isSafeInteger(actor.authnEpoch) &&
    actor.authnEpoch > 0 &&
    BigInt(actor.authnEpoch) >= account.minimumAuthnEpoch
  );
}

/** The first actual affected post supplies authority; the author is selection only.
 * The native command boundary rechecks authorization before reading any receipt.
 * Its single committed requested event is the durable relay's only launch source.
 */
export async function beginAuthorErasure(
  deps: AuthorErasureDependencies,
  actor: Actor,
  input: AuthorErasureInput,
  context: CommandRequestContext,
): Promise<CommandOutcome<{ operationId: string }>> {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const route = routeOf(input.threadId);
  const accountRoute = routeOf(actor.accountId);
  if (route === null || accountRoute === null || routeOf(input.authorId) === null) throw new GrantDeniedError();
  const identity = principalCommandIdentity(actor);
  // Copy only verified identity fields; never serialize a bearer or caller extras.
  const snapshot = {
    accountId: actor.accountId,
    clientId: actor.clientId,
    scopes: [...actor.scopes],
    requestedBy: actor.requestedBy,
    authnEpoch: actor.authnEpoch,
  };
  const selection = { threadId: input.threadId, authorId: input.authorId };
  const operationId = newId(route);
  let firstPostId = selection.threadId;
  type Endpoints = NonNullable<Awaited<ReturnType<typeof readEndpoints.run>>>;
  let endpoints: Endpoints | undefined;
  const authorization: CommandAuthorization = {
    action: 'post:erase',
    resource: {
      route,
      get id() {
        return firstPostId;
      },
    },
    denied: () => new GrantDeniedError(),
    async prepare(attempt) {
      const current = await withConnection(deps.pool, (client) =>
        readAccount(deadlineClient(client, context.deadline), accountRoute, snapshot.accountId),
      );
      if (!accountAllowed(current, actor)) throw new GrantDeniedError();
      const rows = await withConnection(deps.pool, async (client) => {
        const bounded = deadlineClient(client, context.deadline);
        await readPartition(bounded, partitionOf(route));
        return readEndpoints.run(bounded, {
          route,
          thread_id: selection.threadId,
          author_id: selection.authorId,
          at: authoritativeTimeValue(attempt.time),
        });
      });
      endpoints = rows ?? undefined;
      // Empty selection has no actual post on which to establish post:erase.
      if (!endpoints) throw new GrantDeniedError();
      firstPostId = endpoints.post_id;
      return accessCheck(
        deps.access,
        actor,
        'post:erase',
        { route, id: firstPostId },
        { pool: deps.pool, deadline: context.deadline },
      );
    },
    async authorize(tx, attempt, evidence) {
      if (
        attempt.basis?.actorAccountId !== snapshot.accountId ||
        attempt.basis.clientId !== snapshot.clientId ||
        attempt.basis.requestedBy !== snapshot.requestedBy ||
        typeof evidence !== 'function'
      )
        throw new GrantDeniedError();
      // Evidence is this attempt's prepared AccessCheck, never request data.
      const check = evidence as Awaited<ReturnType<typeof accessCheck>>;
      if (!(await check(tx, attempt.time))) throw new GrantDeniedError();
      return 'execute';
    },
  };
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.author-erasure',
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, selection])!)
          .digest(),
      },
    },
    async (tx, { transactionId, time }) => {
      if (!endpoints) throw new GrantDeniedError();
      await createOperation.run(tx, {
        route,
        operation_id: operationId,
        initiator_id: snapshot.accountId,
        author_id: selection.authorId,
        thread_id: selection.threadId,
        client_id: snapshot.clientId,
        scopes: snapshot.scopes,
        requested_by: snapshot.requestedBy,
        authn_epoch: BigInt(snapshot.authnEpoch),
        upper_created_at: endpoints.upper_created_at,
        upper_post_id: endpoints.upper_post_id,
        at: authoritativeTimeValue(time),
        transaction_id: transactionId,
      });
      return {
        value: { operationId },
        events: [{ type: 'com.rezics.content.author-erasure.requested.v1', data: { operationId, ...selection } }],
      };
    },
  );
}

function counts(value: OperationProgress): OperationProgress {
  if (
    !value ||
    !Number.isSafeInteger(value.processedPosts) ||
    value.processedPosts < 0 ||
    !Number.isSafeInteger(value.erasedRevisions) ||
    value.erasedRevisions < 0
  )
    throw new Error('Invalid native operation counters');
  return { processedPosts: value.processedPosts, erasedRevisions: value.erasedRevisions };
}
function view(operationId: string, threadId: string, authorId: string, status: NativeWorkflowStatus | null): Operation {
  const progress = status ? counts(status.progress) : { processedPosts: 0, erasedRevisions: 0 };
  const base = {
    name: `operations/${operationId}` as const,
    metadata: { type: 'content.author_erasure' as const, threadId, authorId, ...progress },
  };
  if (!status || status.done === false) {
    if (status && (status.error !== undefined || status.response !== undefined))
      throw new Error('Invalid native operation status');
    return { ...base, done: false };
  }
  if (status.done !== true || (status.response === undefined) === (status.error === undefined))
    throw new Error('Invalid native operation status');
  if (status.response) return { ...base, done: true, response: counts(status.response) };
  const code = status.error?.status;
  if (!Number.isInteger(code) || code! < 400 || code! > 599) throw new Error('Invalid native operation problem');
  // Native errors may contain SQL, SDK internals or authored content. Expose only
  // the bounded public problem classification, never its raw message or stack.
  return {
    ...base,
    done: true,
    error: { type: 'about:blank', title: code === 403 ? 'Forbidden' : 'Author erasure failed', status: code! },
  };
}

/** Resolve identity first, then authorize at the initiating account's own anchor.
 * PostgreSQL's transaction timestamp supplies the trusted read T to Access.
 * DBOS alone owns progress; an identity awaiting relay remains pending.
 */
export async function readOperation(
  deps: AuthorErasureDependencies,
  actor: Actor,
  operationId: string,
  context: RequestContext,
): Promise<Operation | null> {
  const route = routeOf(operationId);
  if (actor.kind !== 'account' || route === null) return null;
  const accountRoute = routeOf(actor.accountId);
  if (accountRoute === null) return null;
  const rows = await within(context.deadline, () =>
    withConnection(deps.pool, async (client) => {
      const bounded = deadlineClient(client, context.deadline);
      await readPartition(bounded, partitionOf(route));
      return readIdentity.run(bounded, { route, operation_id: operationId });
    }),
  );
  const row = rows;
  if (!row || row.initiator_account_id !== actor.accountId) return null;
  const check = await accessCheck(
    deps.access,
    actor,
    'account:read',
    { route: accountRoute, id: actor.accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const allowed = await withConnection(deps.pool, async (client) => {
    await client.query('BEGIN READ ONLY');
    try {
      const bounded = deadlineClient(client, context.deadline);
      await readPartition(bounded, partitionOf(accountRoute));
      const current = await readAccount(bounded, accountRoute, actor.accountId);
      const result = accountAllowed(current, actor) && (await check(bounded));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!allowed) return null;
  let status: NativeWorkflowStatus | null = null;
  if (row.native_workflow_id !== null) {
    try {
      status = await within(context.deadline, () => deps.workflows.status(row.native_workflow_id!, context));
    } catch {
      throw new Error('Native operation status unavailable');
    }
  }
  return view(operationId, row.thread_id, row.author_account_id, status);
}
