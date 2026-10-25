import { t } from 'elysia';
import type { Pool } from 'pg';
import { createAccess } from '../index.ts';
import type { Access } from '../../request/access.ts';
import { customMethodPath } from '../../http/custom-method.ts';
import { formatDocument, openApiDocument } from '../../http/openapi.ts';
import { problemSchema } from '../../http/problem.ts';
import { actionCatalogue, type MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { visibleOperations, type VisibleOperation } from './visibility.ts';

type ContractDocument = ReturnType<typeof openApiDocument>;

type Catalogue = {
  document: ContractDocument;
  routes: readonly MountedRoute[];
  access: Access;
};

function documentPath(path: string): string {
  return customMethodPath(path.replace(/:([^/?]+)\??/g, '{$1}'));
}

/** Keep the generated contract and drop operations this viewer cannot use. Unused schemas stay. */
function project(document: ContractDocument, visible: readonly VisibleOperation[]): ContractDocument {
  const allowed = new Set(
    visible.map((operation) => `${operation.method.toLowerCase()} ${documentPath(operation.path)}`),
  );
  const paths: ContractDocument['paths'] = {};
  for (const [path, operations] of Object.entries(document.paths)) {
    const kept: ContractDocument['paths'][string] = {};
    for (const [method, operation] of Object.entries(operations)) {
      if (allowed.has(`${method.toLowerCase()} ${path}`)) kept[method] = operation;
    }
    if (Object.keys(kept).length > 0) paths[path] = kept;
  }
  return { ...document, paths };
}

/**
 * Public read of the generated contract. The route list is taken from the shared
 * Elysia instance on the first request, after later plugins have mounted, and reused.
 * `openapi:read` is a read-family action, so the write-rate stage does not charge it.
 */
export function openApiRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; clock: () => Date },
) {
  let catalogue: Catalogue | undefined;
  const routed = app.get(
    '/v1/openapi.json',
    {
      response: {
        200: t.Any(),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
      },
      detail: {
        operationId: 'openapi.read',
        'x-exposure': 'public',
        'x-action': 'openapi:read',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    async ({ actor, job }) => {
      catalogue ??= {
        document: openApiDocument(routed),
        routes: [...routed.routes],
        access: createAccess({ actions: actionCatalogue(routed) }),
      };
      const visible = await visibleOperations({
        viewer: actor,
        pool: dependencies.pool,
        access: catalogue.access,
        routes: catalogue.routes,
        deadline: job.deadline,
        clock: dependencies.clock,
      });
      return new Response(formatDocument(project(catalogue.document, visible)), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  );
  return routed;
}
