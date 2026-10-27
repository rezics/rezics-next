import { t } from 'elysia';
import type { Pool } from 'pg';
import { createAccess } from '../index.ts';
import type { Access } from '../../request/access.ts';
import { problemSchema } from '../../http/problem.ts';
import { actionCatalogue, type MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { admittedGroups } from './visibility.ts';

/** Capture the complete mounted catalogue on the first request, as the served OpenAPI route does. */
export function admittedGroupsRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; clock: () => Date },
) {
  let catalogue: { routes: readonly MountedRoute[]; access: Access } | undefined;
  return app.get(
    '/v1/platform/exposure',
    {
      response: {
        200: t.Object({ admitted: t.Array(t.String()) }, { additionalProperties: false }),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
      },
      detail: {
        operationId: 'exposure.read',
        'x-exposure': 'public',
        'x-action': 'exposure:read',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    async ({ actor, job, set }) => {
      catalogue ??= { routes: [...app.routes], access: createAccess({ actions: actionCatalogue(app) }) };
      const admitted = await admittedGroups({
        viewer: actor,
        pool: dependencies.pool,
        access: catalogue.access,
        routes: catalogue.routes,
        deadline: job.deadline,
        clock: dependencies.clock,
      });
      set.headers['cache-control'] = 'no-store';
      return { admitted: [...admitted] };
    },
  );
}
