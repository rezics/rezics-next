import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import type { DurableOperationAnchor, InitiatorRestorer } from '../access/durable-initiator.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandOutcome,
} from '../command/command.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import readScope from './read-erasure-scope.sql';
import erase from './erase-content.sql';
import takedown from './takedown.sql';

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
};

/** Shared native point boundary. Callers bind an action and kind in server code;
 * request bodies cannot supply authority, author selection or storage keys.
 * All account, scope, delegation and grant checks belong to shared Access.
 */
async function mutateAuthorizedPoint(
  deps: Omit<ErasePostDependencies, 'routeKey'>,
  actor: Actor | ErasureInitiator,
  requested: Point,
  context: ErasePostContext,
): Promise<CommandOutcome<{ targetId: string; securityRevision: string }>> {
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
  const parameters = { route, id: point.id, kind: point.kind };
  const args = (statement: { params: readonly string[] }) =>
    statement.params.map((name) => parameters[name as keyof typeof parameters]);
  let scope: Scope | undefined;
  const ordinaryAdmission = (verified: Extract<Actor, { kind: 'account' }>) =>
    accessCommandAuthorization(
      deps.access,
      verified,
      point.action,
      target,
      { pool: deps.pool, deadline: context.deadline },
      () => new GrantDeniedError(),
    );
  const admission: CommandAuthorization =
    actor.kind === 'account'
      ? await ordinaryAdmission(actor)
      : {
          action: point.action,
          resource: target,
          denied: () => new GrantDeniedError(),
          async prepare(attempt) {
            const verified = await actor.restorer.restoreInitiator(
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
            const current = await ordinaryAdmission(verified);
            return { current, proof: await current.prepare!(attempt) };
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
    async authorize(tx, attempt, evidence) {
      // At trusted T, before even the receipt lookup. Denied replay cannot see
      // the old response or security revision and cannot append an effect.
      if ((await admission.authorize(tx, attempt, evidence)) !== 'execute') throw new GrantDeniedError();
      const rows = await tx.query<Scope>(readScope.sql, args(readScope));
      scope = rows.rows.length === 1 ? rows.rows[0] : undefined;
      if (!scope || (point.action === 'media:erase' && scope.collection_pending)) throw new GrantDeniedError();
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
        kind: `content.${point.action}`,
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(canonicalize([identity, point])!)
          .digest(),
      },
    },
    async (tx) => {
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
