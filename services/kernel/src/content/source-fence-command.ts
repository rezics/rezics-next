import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { resourceAuthorization } from '../access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type CommandOutcome,
} from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, Actor } from '../request/access.ts';
import { newId, partitionOf } from '../route/route.ts';
import readContext from '../semantic/read-context.sql';
import { tupleRoute, type ImportedFieldGroup } from './imported-contract.ts';
import type { RequestContext } from './model.ts';
import type { SourceFenceEventData } from './source-fence-events.ts';
import takedown from './takedown-source-fence.sql';

export type SourceFenceDependencies = Readonly<{
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  clock?: () => Date;
}>;
export type SourceFenceTakedownInput = Readonly<{
  source: string;
  external_id: string;
  field_group: ImportedFieldGroup;
  reason: string;
}>;

const platform = Object.freeze({ route: 0, id: '00000000-0000-8000-8000-000000000000' });
const sourcePattern = /^[a-z][a-z0-9_-]{0,31}$/;
const controls = /[\u0000-\u001f\u007f-\u009f]/u;

/** Global governance authorizes a stable source tuple, independently of subjects.
 * Each native attempt releases its root authorization before tuple checkout and
 * authorizes before reading receipts. An upsert never grants creation rights.
 */
export async function takedownSourceFence(
  deps: SourceFenceDependencies,
  actor: Actor,
  input: SourceFenceTakedownInput,
  context: RequestContext,
): Promise<CommandOutcome<{ securityRevision: string }>> {
  if (actor.kind !== 'account') throw new GrantDeniedError();
  const { source, external_id, field_group, reason } = input;
  if (
    typeof source !== 'string' ||
    source.length > 32 ||
    sourcePattern.exec(source)?.[0] !== source ||
    typeof external_id !== 'string' ||
    external_id.length === 0 ||
    external_id.length > 1024 ||
    !external_id.isWellFormed() ||
    controls.test(external_id) ||
    Buffer.byteLength(external_id, 'utf8') > 1024 ||
    !['facts', 'summary', 'cover'].includes(field_group) ||
    typeof reason !== 'string' ||
    reason.length === 0 ||
    reason.length > 1024 ||
    !reason.isWellFormed()
  )
    throw new RangeError('Invalid source fence identity, field group or reason');
  const route = tupleRoute(deps.routeKey, source, external_id);
  const partition = partitionOf(route);
  const identity = principalCommandIdentity(actor);
  const authorization = resourceAuthorization({
    access: deps.access,
    actor,
    action: 'source_fence:takedown',
    anchor: {
      resource: platform,
      async validate(client) {
        if (!(await readPartition(client, partitionOf(platform.route)))) return false;
        const root = await readContext.run(client, { route: platform.route, context_id: platform.id });
        return root?.kind === 'global';
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
        kind: 'content.source-fence.takedown',
        key: context.idempotencyKey,
        digest: createHash('sha256')
          .update(JSON.stringify([identity, { source, external_id, field_group, reason }]))
          .digest(),
      },
    },
    async (tx, command) => {
      // The compiled statement avoids periodic catalogue freshness queries in
      // this exact tuple write. PostgreSQL increments the bigint without JS loss.
      const result = await tx.query<(typeof takedown)['~reylo']['element']>(takedown.sql, [
        route,
        source,
        external_id,
        field_group,
        authoritativeTimeValue(command.time),
        newId(route),
      ]);
      const row = result.rows[0];
      if (!row) throw new Error('Source fence upsert returned no security revision');
      const data: SourceFenceEventData<'com.rezics.content.source_fence.taken_down.v1'> = {
        route,
        source,
        external_id,
        field_group,
        securityRevision: row.securityRevision,
        ...(row.takenDownAt !== null && row.takedownId !== null
          ? { takenDownAt: row.takenDownAt, takedownId: row.takedownId }
          : {}),
      };
      return {
        value: { securityRevision: row.securityRevision },
        events: [{ type: 'com.rezics.content.source_fence.taken_down.v1', data }],
      };
    },
  );
}
