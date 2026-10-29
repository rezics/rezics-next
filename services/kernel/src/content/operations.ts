import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import { captureDurableInitiator, durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import type { DurableInitiatorRecord } from '../access/durable-initiator.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Access, type Actor, type Resource } from '../request/access.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type {
  AuthorErasureDependencies,
  AuthorErasureInput,
  AuthorErasureReceipt,
  CommandRequestContext,
  NativeWorkflowStatus,
  Operation,
  OperationProgress,
  OperationResponse,
  RequestContext,
} from './operation-contract.ts';
import createOperation from './create-erasure-operation.sql';
import readEndpoints from './read-first-erasure-post.sql';
import readIdentity from './read-erasure-operation.sql';
import readPostAvailability from './read-erasure-post-availability.sql';

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
  const idempotencyKey = context.idempotencyKey;
  if (!/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) throw new TypeError('Invalid erasure command key');
  const route = routeOf(input.threadId);
  const accountRoute = routeOf(actor.accountId);
  if (route === null || accountRoute === null || routeOf(input.authorId) === null) throw new GrantDeniedError();
  const identity = principalCommandIdentity(actor);
  // Copy only verified identity fields; never serialize a bearer or caller extras.
  const snapshot = {
    kind: 'account' as const,
    accountId: actor.accountId,
    clientId: actor.clientId,
    scopes: [...actor.scopes],
    requestedBy: actor.requestedBy,
    authnEpoch: actor.authnEpoch,
  };
  const selection = { threadId: input.threadId, authorId: input.authorId };
  const operationId = newId(route);
  const operation = { route, id: operationId, kind: 'content.author-erasure', sourceId: operationId };
  const requestDigest = createHash('sha256')
    .update(canonicalize([identity, selection])!)
    .digest();
  let firstPostId = selection.threadId;
  type Endpoints = NonNullable<Awaited<ReturnType<typeof readEndpoints.run>>>;
  let endpoints: Endpoints | undefined;
  let captured: Awaited<ReturnType<typeof captureDurableInitiator>> | undefined;
  type Check = Awaited<ReturnType<typeof accessCheck>>;
  type AuthorizationEvidence = { postErase: Check; selfRead: Check };
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
      captured = undefined;
      endpoints = undefined;
      const preparation = commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt);
      try {
        await requireCommandAdmission(deps.access, actor, preparation);
        captured = await captureDurableInitiator(preparation, actor);
      } catch (error) {
        if (error instanceof AccessUnavailableError) throw error;
        throw new GrantDeniedError();
      }
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
      const postErase = await accessCheck(deps.access, actor, 'post:erase', { route, id: firstPostId }, preparation);
      const selfRead = await accessCheck(
        deps.access,
        actor,
        'account:read',
        { route: accountRoute, id: actor.accountId },
        preparation,
      );
      return { postErase, selfRead } satisfies AuthorizationEvidence;
    },
    async authorize(tx, attempt, evidence) {
      if (
        attempt.basis?.actorAccountId !== snapshot.accountId ||
        attempt.basis.clientId !== snapshot.clientId ||
        attempt.basis.requestedBy !== snapshot.requestedBy ||
        typeof evidence !== 'object' ||
        evidence === null
      )
        throw new GrantDeniedError();
      // Evidence is this attempt's prepared AccessChecks, never request data.
      const checks = evidence as AuthorizationEvidence;
      if (typeof checks.postErase !== 'function' || typeof checks.selfRead !== 'function') throw new GrantDeniedError();
      if (!(await checks.postErase(tx, attempt.time)) || !(await checks.selfRead(tx, attempt.time)))
        throw new GrantDeniedError();
      return 'execute';
    },
  };
  const outcome = await runCommand<AuthorErasureReceipt>(
    deps.pool,
    {
      ...identity,
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.author-erasure',
        key: idempotencyKey,
        digest: requestDigest,
      },
    },
    async (tx, { transactionId, time }) => {
      if (!endpoints || !captured) throw new GrantDeniedError();
      const target = { route, id: firstPostId };
      const sourceDigest = createHash('sha256')
        .update(
          canonicalize({
            operation,
            target,
            selection: {
              ...selection,
              upperCreatedAt: endpoints.upper_created_at,
              upperPostId: endpoints.upper_post_id,
            },
          })!,
        )
        .digest('hex');
      const record: DurableInitiatorRecord = {
        operation,
        initiatorAccountId: snapshot.accountId,
        actor: snapshot,
        recordedTransactionId: transactionId,
        sourceDigest,
        ...captured,
        creation: {
          commandKind: operation.kind,
          idempotencyKey,
          requestDigest: requestDigest.toString('hex'),
          target,
        },
      };
      await createOperation.run(tx, {
        route,
        operation_id: operationId,
        initiator_id: snapshot.accountId,
        author_id: selection.authorId,
        thread_id: selection.threadId,
        anchor_post_id: firstPostId,
        client_id: snapshot.clientId,
        scopes: snapshot.scopes,
        requested_by: snapshot.requestedBy,
        authn_epoch: BigInt(snapshot.authnEpoch),
        upper_created_at: endpoints.upper_created_at,
        upper_post_id: endpoints.upper_post_id,
        at: authoritativeTimeValue(time),
        transaction_id: transactionId,
        source_digest: sourceDigest,
        original_minimum_authn_epoch: captured.originalAccount.minimumAuthnEpoch,
        original_operator_account_id: captured.originalAccount.operatorAccountId,
        original_delegation_transaction_id: captured.originalDelegation?.transactionId ?? null,
        original_delegation_issued_valid: captured.originalDelegation?.issuedValid ?? null,
        creation_command_kind: record.creation.commandKind,
        creation_idempotency_key: record.creation.idempotencyKey,
        creation_request_digest: record.creation.requestDigest,
        creation_target_route: target.route,
        creation_target_id: target.id,
      });
      return {
        value: { operationId, durableInitiator: durableInitiatorCommitment(record) },
        events: [{ type: 'com.rezics.content.author-erasure.requested.v1', data: { operationId, ...selection } }],
      };
    },
  );
  // runCommand replays the exact internal receipt; the public value stays ID-only.
  return { ...outcome, value: { operationId: outcome.value.operationId } };
}

function counts(value: OperationResponse): OperationResponse {
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
  let progress: OperationProgress = { processedPosts: 0, erasedRevisions: 0, steps: 0 };
  if (status) {
    const counters = counts(status.progress);
    if (!Number.isSafeInteger(status.progress.steps) || status.progress.steps < 0)
      throw new Error('Invalid native operation counters');
    progress = { ...counters, steps: status.progress.steps };
  }
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
  if (status.response === null || status.error === null) throw new Error('Invalid native operation status');
  if (status.response !== undefined) return { ...base, done: true, response: counts(status.response) };
  const nativeCode = status.error!.code;
  const code = Number.isInteger(nativeCode) && nativeCode >= 1 && nativeCode <= 16 ? nativeCode : 13;
  // Native errors may contain SQL, SDK internals or authored content. Expose only
  // the canonical RPC code and a fixed public message, never native details.
  return {
    ...base,
    done: true,
    error: {
      code,
      message: code === 7 ? 'Permission denied' : code === 13 ? 'Internal error' : 'Author erasure failed',
    },
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
  if (!row || row.initiator_account_id !== actor.accountId || row.author_account_id === null) return null;
  const anchorRoute = routeOf(row.anchor_post_id);
  if (anchorRoute !== route) return null;
  const accountCheck = await accessCheck(
    deps.access,
    actor,
    'account:read',
    { route: accountRoute, id: actor.accountId },
    { pool: deps.pool, deadline: context.deadline },
  );
  const postCheck = await accessCheck(
    deps.access,
    actor,
    'post:erase',
    { route: anchorRoute, id: row.anchor_post_id },
    { pool: deps.pool, deadline: context.deadline },
  );
  const allowed = await withConnection(deps.pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    try {
      const bounded = deadlineClient(client, context.deadline);
      const partitions = new Set([partitionOf(accountRoute), partitionOf(anchorRoute)]);
      for (const partition of partitions) await readPartition(bounded, partition);
      const accountAllowed = await accountCheck(bounded);
      const postAllowed = await postCheck(bounded);
      await client.query('COMMIT');
      return accountAllowed && postAllowed;
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

/** Post erasure is irreversible. When its current post:erase grant has been
 * revoked, an erased post may authorize lookup of its existing receipt through
 * the route's declared self-account-read permission. A missing receipt still
 * reaches the existing mutation guard, which rejects an already erased post.
 */
export function postEraseReceiptAccess(access: Access): Access {
  type Evidence = {
    actor: Actor;
    action: string;
    resource: Resource;
    actionEvidence: unknown;
    accountResource?: Resource;
    accountEvidence?: unknown;
  };
  const prepared = new WeakMap<object, Evidence>();
  return deriveAccess(access, {
    replayAuthorization(action) {
      // This adapter handles the action-denied receipt path itself so the
      // generic helper does not prepare or execute a duplicate self-read check.
      return action === 'post:erase' ? undefined : access.replayAuthorization?.(action);
    },
    async prepare(actor, action, resource, context) {
      const actionEvidence = await access.prepare?.(actor, action, resource, context);
      let accountResource: Resource | undefined;
      let accountEvidence: unknown;
      if (
        action === 'post:erase' &&
        actor.kind === 'account' &&
        access.replayAuthorization?.(action) === 'self-account-read' &&
        access.prepare
      ) {
        const route = routeOf(actor.accountId);
        if (route !== null) {
          accountResource = { route, id: actor.accountId };
          accountEvidence = await access.prepare(actor, 'account:read', accountResource, context);
        }
      }
      const proof = Object.freeze({});
      prepared.set(proof, {
        actor,
        action,
        resource,
        actionEvidence,
        ...(accountResource === undefined ? {} : { accountResource, accountEvidence }),
      });
      return proof;
    },
    async authorize(client, actor, action, resource, evidence, time) {
      const facts = typeof evidence === 'object' && evidence !== null ? prepared.get(evidence) : undefined;
      if (
        !facts ||
        facts.actor !== actor ||
        facts.action !== action ||
        facts.resource.route !== resource.route ||
        facts.resource.id !== resource.id
      )
        return false;
      const allowed = await access.authorize(client, actor, action, resource, facts.actionEvidence, time);
      if (
        allowed ||
        action !== 'post:erase' ||
        facts.accountResource === undefined ||
        facts.accountEvidence === undefined
      )
        return allowed;
      const post = await readPostAvailability.run(client, { route: resource.route, post_id: resource.id });
      if (post?.availability !== 'erased') return false;
      return access.authorize(client, actor, 'account:read', facts.accountResource, facts.accountEvidence, time);
    },
  });
}
