import {
  prepareDiscoveryMutation,
  discoveryMutationAuthorization,
  lockDiscoveryMutation,
  applyDiscoveryMutation,
  abortDiscoveryMutation,
} from './discovery-mutation.ts';
import { createHash } from 'node:crypto';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
} from '../command/command.ts';
import { accessCommandAuthorization } from './access-port.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, ReviewConflictError } from './commands.ts';
import type { ErasePostDependencies, ErasePostContext } from './erase-post.ts';
import read from './read-post-restoration.sql';
import restore from './restore-post.sql';
import restoreReview from './restore-review.sql';

/** Access and the exact native author are checked before receipt lookup. */
export async function restorePost(
  deps: ErasePostDependencies,
  actor: Actor,
  postId: string,
  context: ErasePostContext,
) {
  const route = routeOf(postId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  const target = { route, id: postId };
  const access = await accessCommandAuthorization(
    deps.access,
    actor,
    'post:erase',
    target,
    { pool: deps.pool, deadline: context.deadline },
    () => new ContentNotFoundError(),
  );
  const identity = principalCommandIdentity(actor);
  const authorization: CommandAuthorization = {
    ...access,
    async authorize(tx, attempt, evidence) {
      if ((await access.authorize(tx, attempt, evidence)) !== 'execute') throw new ContentNotFoundError();
      const row = await read.run(tx, { route, post_id: postId });
      if (!row || row.author_account_id !== actor.accountId || row.purge_started_at !== null || row.purge_completed)
        throw new ContentNotFoundError();
      // An available post permits a same-key receipt replay. A new key still
      // has no applicable mutation. Expired tombstones never expose receipts.
      if (
        row.availability === 'erased' &&
        (!row.deleted_at ||
          Date.parse(row.deleted_at) + 30 * 86400000 <= Date.parse(authoritativeTimeValue(attempt.time)))
      )
        throw new ContentNotFoundError();
      return 'execute';
    },
  };
  const receipt = {
    kind: 'content.post:restore',
    key: context.idempotencyKey,
    digest: createHash('sha256')
      .update(JSON.stringify([identity, postId]))
      .digest(),
  };
  const discovery = await prepareDiscoveryMutation(deps, {
    identity,
    authorization,
    receipt,
    deadline: context.deadline,
    target: { kind: 'post', id: postId },
    effect: 'restore',
  });
  try {
    return await runCommand(
      deps.pool,
      {
        ...identity,
        partition: partitionOf(route),
        clock: deps.clock,
        deadline: context.deadline,
        authorization: discoveryMutationAuthorization(deps, authorization, discovery),
        receipt,
      },
      async (tx, { time }) => {
        await lockDiscoveryMutation(tx, discovery);
        const parameters = { route, post_id: postId, author_id: actor.accountId, at: authoritativeTimeValue(time) };
        const changed = (
          await tx.query<{ thread_id: string; security_revision: string }>(
            restore.sql,
            restore.params.map((name) => parameters[name as keyof typeof parameters]),
          )
        ).rows[0];
        if (!changed) throw new ContentNotFoundError();
        await restoreReview.run(tx, { route, thread_id: changed.thread_id, post_id: postId });
        const value = { postId, securityRevision: changed.security_revision };
        return {
          value,
          events: [
            { type: 'com.rezics.content.post.restored.v1', subject: postId, data: value },
            ...(await applyDiscoveryMutation(tx, discovery)),
          ],
        };
      },
    );
  } catch (error) {
    await abortDiscoveryMutation(deps.pool, discovery);
    if (
      (error as { code?: string; constraint?: string }).code === '23505' &&
      (error as { constraint?: string }).constraint === 'thread_one_live_review_idx'
    )
      throw new ReviewConflictError();
    throw error;
  }
}
