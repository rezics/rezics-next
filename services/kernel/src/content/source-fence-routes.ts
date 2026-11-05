import { memoizedValue } from '../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { deadlineClient, within } from '../access/authenticate.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { SESSION_HEADER } from '../http/request.ts';
import { readPartition } from '../partition/partition.ts';
import {
  accessCheck,
  actorOf,
  AuthenticationError,
  type Access,
  type AccessClient,
  type Actor,
} from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import readContext from '../semantic/read-context.sql';
import type { Pool } from 'pg';
import { tupleRoute } from './imported-contract.ts';
import type { Anchored } from './model.ts';
import { SourceFenceQuerySchema, SourceFenceResponseSchema, strictContentSchema } from './schemas.ts';
import { readFences } from './source-fences.ts';

type Dependencies = Readonly<{ pool: Pool; access: Access; routeKey: Uint8Array }>;
function root() {
  return memoizedValue(root, () => Object.freeze({ route: 0, id: GLOBAL_CONTEXT }));
}

/** Each boundary owns one independently anchored read-only checkout. Preparation
 * and any other partition read happen only after that connection is released.
 */
async function snapshot<T>(
  pool: Pool,
  partitionNo: number,
  deadline: number,
  work: (client: AccessClient) => Promise<T>,
): Promise<Anchored<T>> {
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionNo);
        if (!partition || partition.writeState === 'moved') throw new ProblemError('partition_unavailable');
        const value = await work(client);
        await client.query('COMMIT');
        return { value, anchor: { partition, epoch: partition.epoch, position: partition.position } };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    }),
  );
}

async function authorizeRoot(dependencies: Dependencies, actor: Actor, deadline: number) {
  // No anonymous eligibility or synthetic tuple UUID: the sole seeded Context
  // supplies authority, using the mounted protected action and normal formula.
  const check = await accessCheck(dependencies.access, actor, 'source_fence:read', root(), {
    pool: dependencies.pool,
    deadline,
  });
  return snapshot(dependencies.pool, 0, deadline, async (client) => {
    const current = await readContext.run(client, { route: root().route, context_id: root().id });
    // Access obtains authoritative database time on this root's own client.
    if (current?.kind !== 'global' || !(await check(client))) throw new ProblemError('forbidden');
  });
}

export function sourceFenceRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  return app.get(
    customMethod('/v1/sourceFences', 'check'),
    {
      query: strictContentSchema(SourceFenceQuerySchema),
      response: {
        200: withHeaders(strictContentSchema(SourceFenceResponseSchema), { [SESSION_HEADER]: t.String() }),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        500: problemSchema('internal_error'),
        503: problemSchema(
          'overloaded',
          'deadline_exceeded',
          'partition_unavailable',
          'transaction_retry_exhausted',
          'dependency_unavailable',
        ),
      },
      detail: {
        operationId: 'source_fence.read',
        'x-exposure': 'public',
        'x-action': 'source_fence:read',
        security: [{ bearerAuth: [] }],
      },
      mapResponse({ set }) {
        set.headers['cache-control'] = 'private, no-store';
      },
    },
    async ({ actor, query, request, admission, job, session }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      // JSON Schema bounds characters; storage identity also bounds UTF-8 bytes.
      if (
        /^[a-z][a-z0-9_-]{0,31}$/.exec(query.source)?.[0] !== query.source ||
        !query.externalId.isWellFormed() ||
        Buffer.byteLength(query.externalId, 'utf8') > 1024
      )
        throw new ProblemError('invalid_request');
      return admission.run('normal', job, async () => {
        await authorizeRoot(dependencies, actor, job.deadline);
        const route = tupleRoute(dependencies.routeKey, query.source, query.externalId);
        const observed = await snapshot(dependencies.pool, partitionOf(route), job.deadline, (client) =>
          readFences(client, [
            { route, source: query.source, external_id: query.externalId, field_group: query.fieldGroup },
          ]),
        );
        // Re-enter shared authentication and the current root formula after tuple
        // checkout is released. Revocation or suspension suppresses all observed facts.
        const currentActor = await actorOf(dependencies.access, request, {
          pool: dependencies.pool,
          deadline: job.deadline,
        });
        const final = await authorizeRoot(dependencies, currentActor, job.deadline);
        for (const { anchor } of [observed, final])
          session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
        // Preflight is only a hint. Commands always recheck the fence independently.
        const fence = observed.value[0]!;
        return { fenced: fence.takenDown, securityRevision: fence.securityRevision };
      });
    },
  );
}
