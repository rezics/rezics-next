import { createHash } from 'node:crypto';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import { principalCommandIdentity, runCommand, type CommandOutcome } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { MediaModerationEventData } from '../events/contracts/content-media-moderation.ts';
import type { ModerationDependencies } from './moderation.ts';
import type { MediaId, RequestContext, SecurityRevision } from './model.ts';
import readMedia from './read-erased-media.sql';
import takedown from './takedown-media.sql';

export type TakedownMediaInput = Readonly<{ mediaId: MediaId; reason: string }>;
export type MediaModerationValue = Readonly<{ mediaId: MediaId; securityRevision: SecurityRevision }>;

/** Account governance on the exact media object, independent of its container,
 * source tuple and uploader. Authorization is released before target checkout,
 * and repeats must pass the same current formula before any receipt is read.
 * Cost: bounded actor evidence plus two media PK probes, one receipt seek and
 * one event, O(A + log M); no reference/history walk or object-storage access.
 */
export async function takedownMedia(
  deps: ModerationDependencies,
  actor: Actor,
  input: TakedownMediaInput,
  context: RequestContext,
): Promise<CommandOutcome<MediaModerationValue>> {
  const { mediaId, reason } = input;
  const route = routeOf(mediaId);
  if (actor.kind !== 'account' || route === null) throw new GrantDeniedError();
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 1024 || !reason.isWellFormed())
    throw new RangeError('Invalid media takedown reason');
  const partition = partitionOf(route);
  const identity = principalCommandIdentity(actor);
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'moderation:takedown',
    anchor: {
      resource: { route, id: mediaId },
      async validate(client) {
        const anchor = await readPartition(client, partition);
        if (!anchor || anchor.writeState === 'moved') return false;
        const result = await client.query<(typeof readMedia)['~reylo']['element']>(readMedia.sql, [route, mediaId]);
        // Taken-down objects remain valid anchors for same-key replay. Erased
        // and missing objects fail closed even if an old receipt exists.
        return result.rows[0]?.erased === false;
      },
    },
    context: { pool: deps.pool, deadline: context.deadline, partition },
  });
  return runCommand(
    deps.pool,
    {
      ...identity,
      partition,
      deadline: context.deadline,
      clock: deps.clock,
      authorization,
      receipt: {
        kind: 'content.media.takedown',
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(JSON.stringify([identity, { mediaId, reason }]))
          .digest(),
      },
    },
    async (tx) => {
      const result = await tx.query<(typeof takedown)['~reylo']['element']>(takedown.sql, [route, mediaId]);
      const row = result.rows[0];
      // A distinct command on an already hidden object rolls back: no revision,
      // receipt, position or event is added. Kernel handles contention/retries.
      if (!row) throw new GrantDeniedError();
      const data: MediaModerationEventData<'com.rezics.content.media.taken-down.v1'> = {
        mediaId,
        securityRevision: row.securityRevision,
      };
      return { value: data, events: [{ type: 'com.rezics.content.media.taken-down.v1', subject: mediaId, data }] };
    },
  );
}
