import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import { problemSchema } from '../../http/problem.ts';
import type { MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { visibleOperations } from './visibility.ts';

/** Mounted operations the site reads by id rather than by gate group. */
export const SHELL_JOURNEY_OPERATIONS = [
  'commerce_sale.list',
  'subject.create',
  'realm.create',
  'provider_review.list',
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
  'library_label.assign',
  'library_label.unassign',
  'library_label.assignment_list',
] as const;

/** Capture the complete mounted catalogue on the first request, as the served OpenAPI route does. */
export function admittedGroupsRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; clock: () => Date; access: () => Access },
) {
  let catalogue: readonly MountedRoute[] | undefined;
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
      catalogue ??= [...app.routes];
      const visible = await visibleOperations({
        viewer: actor,
        pool: dependencies.pool,
        access: dependencies.access(),
        routes: catalogue,
        deadline: job.deadline,
        clock: dependencies.clock,
      });
      const admitted = new Set(
        visible.flatMap((operation) => (operation.exposure.startsWith('gate:') ? [operation.exposure.slice(5)] : [])),
      );
      // Fixed shell journeys require their mounted operation, independently of gate-group admission.
      for (const id of SHELL_JOURNEY_OPERATIONS) {
        if (visible.some((operation) => operation.operationId === id)) admitted.add(id);
      }
      set.headers['cache-control'] = 'no-store';
      return { admitted: [...admitted].sort() };
    },
  );
}
