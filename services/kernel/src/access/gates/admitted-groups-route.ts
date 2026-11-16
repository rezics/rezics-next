import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import { problemSchema } from '../../http/problem.ts';
import type { MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { visibleOperations } from './visibility.ts';

const standaloneOperations = new Set([
  'commerce_sale.list',
  'subject.create',
  'realm.create',
  'provider_review.list',
  'knowledge_document.public_export',
]);

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
      const admitted = new Set<string>();
      // Knowledge controls use exact mounted Account operations. The target still requires native authorization.
      for (const { operationId, action, exposure } of visible) {
        if (exposure.startsWith('gate:')) admitted.add(exposure.slice(5));
        const scopedKnowledgeOperation =
          (operationId.startsWith('knowledge_document.') || operationId.startsWith('knowledge_notebook.')) &&
          (action === 'account:read' || action === 'account:update') &&
          actor.kind === 'account' &&
          actor.scopes.includes(action);
        if (standaloneOperations.has(operationId) || scopedKnowledgeOperation) admitted.add(operationId);
      }
      set.headers['cache-control'] = 'no-store';
      return { admitted: [...admitted].sort() };
    },
  );
}
