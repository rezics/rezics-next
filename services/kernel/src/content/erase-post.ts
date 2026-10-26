import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { DurableOperationAnchor, InitiatorRestorer } from '../access/durable-initiator.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandAttempt,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import readScope from './read-erasure-scope.sql';
import erase from './erase-content.sql';
import takedown from './takedown.sql';
import countRevisions from './erase-post-revisions.sql';

export type ErasePostDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock?: () => Date;
}>;
export type ErasePostContext = Readonly<{
  deadline: number;
  idempotencyKey: string;
  requestId: string;
}>;
export type ErasePostInput = Readonly<{ postId: string; reason: string }>;

/** Trusted workflow composition only. Attribution locates the original person's
 * receipt; it supplies no authority. Restoration verifies the immutable source
 * and returns a fresh native identity inside every command attempt's prepare.
 */
export type ErasureInitiator = Readonly<{
  kind: 'durable-initiator';
  operation: DurableOperationAnchor;
  accountId: string;
  clientId: string;
  requestedBy: string | null;
  restorer: InitiatorRestorer;
}>;

type Point =
  | Readonly<{ action: 'moderation:takedown'; kind: 'board' | 'thread' | 'post'; id: string; reason: string }>
  | Readonly<{ action: 'post:erase'; kind: 'post'; id: string; reason: string }>
  | Readonly<{ action: 'media:erase'; kind: 'media'; id: string; reason: string }>;
type Scope = {
  id: string;
  container_id: string | null;
  collection_pending: boolean;
  realm_id: string | null;
};

/** Shared native point boundary. Callers bind an action and kind in server code;
 * request bodies cannot supply authority, author selection or storage keys.
 * All account, scope, delegation and grant checks belong to shared Access.
 */
async function prepareAuthorizedPoint(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  actor: Actor | ErasureInitiator,
  requested: Point,
  context: ErasePostContext,
) {
  if (actor.kind !== 'account' && actor.kind !== 'durable-initiator') throw new GrantDeniedError();
  if (actor.kind === 'durable-initiator' && requested.action !== 'post:erase') throw new GrantDeniedError();
  const point = Object.freeze({ ...requested });
  const route = routeOf(point.id);
  if (route === null) throw new GrantDeniedError();
  if (
    typeof point.reason !== 'string' ||
    !point.reason.length ||
    point.reason.length > 1024 ||
    !point.reason.isWellFormed()
  )
    throw new RangeError('Invalid moderation reason');
  const target = Object.freeze({ route, id: point.id });
  const identity =
    actor.kind === 'account'
      ? principalCommandIdentity(actor)
      : {
          principal: { kind: 'account' as const, id: actor.accountId },
          basis: { clientId: actor.clientId, requestedBy: actor.requestedBy },
        };
  const parameters = { route, id: point.id, kind: point.kind, resolve_realm: false };
  const args = (statement: { params: readonly string[] }, resolveRealm = false) =>
    statement.params.map((name) =>
      name === 'resolve_realm' ? resolveRealm : parameters[name as keyof typeof parameters],
    );
  let scope: Scope | undefined;
  const ordinaryAdmission = (
    verified: Extract<Actor, { kind: 'account' }>,
    resource: Readonly<{ route: number; id: string }> = target,
  ) =>
    accessCommandAuthorization(
      deps.access,
      verified,
      point.action,
      resource,
      { pool: deps.pool, deadline: context.deadline },
      () => new GrantDeniedError(),
    );
  const restore = (attempt: CommandAttempt) =>
    actor.kind === 'account'
      ? Promise.resolve(actor)
      : actor.restorer.restoreInitiator(
          {
            operation: actor.operation,
            action: point.action,
            anchor: {
              resource: target,
              async validate(client) {
                const rows = await client.query<Scope>(readScope.sql, args(readScope));
                return rows.rows.length === 1;
              },
            },
            context: { pool: deps.pool, deadline: context.deadline },
          },
          attempt.time,
        );
  const prepareRestored = async (attempt: CommandAttempt, verified: Extract<Actor, { kind: 'account' }>) => {
    const current = await ordinaryAdmission(verified);
    return { current, proof: await current.prepare!(attempt) };
  };
  const admission: CommandAuthorization =
    actor.kind === 'account'
      ? await ordinaryAdmission(actor)
      : {
          action: point.action,
          resource: target,
          denied: () => new GrantDeniedError(),
          async prepare(attempt) {
            return prepareRestored(attempt, await restore(attempt));
          },
          async authorize(tx, attempt, evidence) {
            const { current, proof } = evidence as {
              current: CommandAuthorization;
              proof: unknown;
            };
            return current.authorize(tx, attempt, proof);
          },
        };
  const authorization: CommandAuthorization = {
    ...admission,
    async prepare(attempt) {
      const targetProof = await admission.prepare!(attempt);
      if (
        actor.kind !== 'account' ||
        point.action !== 'moderation:takedown' ||
        (point.kind !== 'thread' && point.kind !== 'post')
      )
        return { targetProof };

      const rows = await withConnection(deps.pool, (connection) =>
        deadlineClient(connection, context.deadline).query<Scope>(readScope.sql, args(readScope, true)),
      );
      const realmId = rows.rows.length === 1 ? rows.rows[0]?.realm_id ?? null : null;
      if (realmId === null) return { targetProof };

      const realm = await ordinaryAdmission(actor, { route: routeOf(realmId)!, id: realmId }).catch(() => undefined);
      if (!realm) return { targetProof };
      const realmProof = await realm.prepare!(attempt).catch(() => undefined);
      return { targetProof, realm, realmProof };
    },
    async authorize(tx, attempt, evidence) {
      const prepared = evidence as {
        targetProof: unknown;
        realm?: CommandAuthorization;
        realmProof?: unknown;
      };
      // At trusted T, before even the receipt lookup. Denied replay cannot see
      // the old response or security revision and cannot append an effect.
      let targetAllowed = false;
      try {
        targetAllowed = (await admission.authorize(tx, attempt, prepared.targetProof)) === 'execute';
      } catch (error) {
        if (!(error instanceof GrantDeniedError)) throw error;
      }
      if (!targetAllowed) {
        if (!prepared.realm || prepared.realmProof === undefined) throw new GrantDeniedError();
        const targetRows = await tx.query<Scope>(readScope.sql, args(readScope, true));
        scope = targetRows.rows.length === 1 ? targetRows.rows[0] : undefined;
        if (
          !scope ||
          scope.realm_id !== prepared.realm.resource.id ||
          (point.action === 'media:erase' && scope.collection_pending)
        )
          throw new GrantDeniedError();
        if ((await prepared.realm.authorize(tx, attempt, prepared.realmProof)) !== 'execute')
          throw new GrantDeniedError();
        return 'execute';
      }
      const rows = await tx.query<Scope>(readScope.sql, args(readScope));
      scope = rows.rows.length === 1 ? rows.rows[0] : undefined;
      if (!scope || (point.action === 'media:erase' && scope.collection_pending)) throw new GrantDeniedError();
      return 'execute';
    },
  };
  return {
    point,
    route,
    identity,
    authorization,
    restore,
    prepareRestored,
    async mutate(tx: CommandTransaction) {
      if (!scope) throw new GrantDeniedError();
      const statement = point.action === 'moderation:takedown' ? takedown : erase;
      const result = await tx.query<{ security_revision: string }>(statement.sql, args(statement));
      const changed = result.rows[0];
      // A different key cannot turn an already erased object into a new effect.
      // Same-key retries have already returned from the native receipt phase.
      if (!changed) throw new GrantDeniedError();
      const securityRevision = changed.security_revision;
      const value = { targetId: point.id, securityRevision };
      if (point.action === 'moderation:takedown')
        return {
          value,
          events: [
            {
              type: 'com.rezics.content.moderation.takedown.v1',
              data: {
                targetKind: point.kind,
                targetId: point.id,
                securityRevision,
              },
            },
          ],
        };
      if (point.kind === 'post')
        return {
          value,
          events: [{ type: 'com.rezics.content.post.erased.v1', data: { postId: point.id, securityRevision } }],
        };
      // The media purge consumer resolves this ID and purges only m/<id>/.
      // No remote call or worker connection occurs inside the point transaction.
      return {
        value,
        events: [
          {
            type: 'com.rezics.content.media.erased.v1',
            data: {
              mediaId: point.id,
              containerId: scope.container_id!,
            },
          },
        ],
      };
    },
  };
}

async function mutateAuthorizedPoint(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  actor: Actor | ErasureInitiator,
  requested: Point,
  context: ErasePostContext,
): Promise<CommandOutcome<{ targetId: string; securityRevision: string }>> {
  const prepared = await prepareAuthorizedPoint(deps, actor, requested, context);
  return runCommand(
    deps.pool,
    {
      ...prepared.identity,
      partition: partitionOf(prepared.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization: prepared.authorization,
      receipt: {
        kind: `content.${prepared.point.action}`,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([prepared.identity, prepared.point])!)
          .digest(),
      },
    },
    (tx) => prepared.mutate(tx),
  );
}

/** Ordinary point callers retain the original authenticated-actor boundary. */
export function mutateContentPoint(
  deps: ErasePostDependencies,
  actor: Actor,
  requested: Point,
  context: ErasePostContext,
): Promise<CommandOutcome<{ targetId: string; securityRevision: string }>> {
  return mutateAuthorizedPoint(deps, actor, requested, context);
}

/** Erase one actual post without enumerating its revisions or media. Native
 * author-erasure work separately pages physical rows and authorizes each post.
 */
async function logicalErasure(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  actor: Actor | ErasureInitiator,
  input: ErasePostInput,
  context: ErasePostContext,
): Promise<CommandOutcome<{ postId: string; securityRevision: string }>> {
  const result = await mutateAuthorizedPoint(
    deps,
    actor,
    {
      action: 'post:erase',
      kind: 'post',
      id: input.postId,
      reason: input.reason,
    },
    context,
  );
  return { ...result, value: { postId: result.value.targetId, securityRevision: result.value.securityRevision } };
}

export function erasePostLogical(
  deps: ErasePostDependencies,
  actor: Actor,
  input: ErasePostInput,
  context: ErasePostContext,
): Promise<CommandOutcome<{ postId: string; securityRevision: string }>> {
  return logicalErasure(deps, actor, input, context);
}

/** Person-attributed native workflow variant; uses the identical point command,
 * mutation, authorization/admission seam and source receipts as ordinary erasure.
 */
export function erasePostLogicalAsInitiator(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  initiator: ErasureInitiator,
  input: ErasePostInput,
  context: ErasePostContext,
): Promise<CommandOutcome<{ postId: string; securityRevision: string }>> {
  return logicalErasure(deps, initiator, input, context);
}

/** One bounded logical page, authorized completely at the command's T before
 * receipt lookup or mutations. Each post uses the ordinary point seam; one
 * denied point rolls back the entire page, including its events and receipt.
 */
export async function erasePostLogicalPageAsInitiator(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  initiator: ErasureInitiator,
  input: Readonly<{ postIds: readonly string[]; reason: string }>,
  context: ErasePostContext,
): Promise<CommandOutcome<{ postIds: string[]; processedPosts: number; erasedRevisions: number }>> {
  const postIds = [...input.postIds];
  if (postIds.length < 1 || postIds.length > 100 || new Set(postIds).size !== postIds.length)
    throw new RangeError('Invalid erasure page');
  const points: Awaited<ReturnType<typeof prepareAuthorizedPoint>>[] = [];
  for (const id of postIds) {
    points.push(
      await prepareAuthorizedPoint(
        deps,
        initiator,
        { action: 'post:erase', kind: 'post', id, reason: input.reason },
        context,
      ),
    );
  }
  const first = points[0]!;
  if (points.some((point) => point.route !== first.route)) throw new GrantDeniedError();
  const authorization: CommandAuthorization = {
    action: 'post:erase',
    resource: first.authorization.resource,
    denied: () => new GrantDeniedError(),
    async prepare(attempt) {
      // Restore one native person/action identity for this live attempt. Account,
      // source, consent and delegation evidence is shared at T; every actual post
      // still gets its own ordinary Access admission/check and scope validation.
      const verified = await first.restore(attempt);
      const proofs: unknown[] = [];
      for (const point of points) proofs.push(await point.prepareRestored(attempt, verified));
      return proofs;
    },
    async authorize(tx, attempt, evidence) {
      const proofs = evidence as unknown[];
      for (const [index, point] of points.entries())
        if ((await point.authorization.authorize(tx, attempt, proofs[index])) !== 'execute')
          throw new GrantDeniedError();
      return 'execute';
    },
  };
  return runCommand(
    deps.pool,
    {
      ...first.identity,
      partition: partitionOf(first.route),
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.author-erasure.page',
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([first.identity, points.map((point) => point.point)])!)
          .digest(),
      },
    },
    async (tx) => {
      let erasedRevisions = 0;
      const events = [];
      for (const point of points) {
        const parameters = { route: point.route, id: point.point.id };
        const result = await tx.query<{ revisions: string }>(
          countRevisions.sql,
          countRevisions.params.map((name) => parameters[name as keyof typeof parameters]),
        );
        erasedRevisions += Number(result.rows[0]!.revisions);
        if (!Number.isSafeInteger(erasedRevisions) || erasedRevisions < 0)
          throw new RangeError('Operation counter overflow');
        events.push(...(await point.mutate(tx)).events);
      }
      return { value: { postIds, processedPosts: postIds.length, erasedRevisions }, events };
    },
  );
}
