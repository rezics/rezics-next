import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import { customMethodPath } from '../../http/custom-method.ts';
import { formatDocument, openApiDocument } from '../../http/openapi.ts';
import { problemSchema } from '../../http/problem.ts';
import type { MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import { visibleOperations, type VisibleOperation } from './visibility.ts';

type ContractDocument = ReturnType<typeof openApiDocument>;

/** Finite 200 schema. `t.Any()` is an open record; a bare `t.Unknown()` omits this response. */
const documentSchema = t.Object({
  openapi: t.String(),
  info: t.Object({ title: t.String(), version: t.String() }),
  paths: t.Record(t.String(), t.Record(t.String(), t.Object({ operationId: t.Optional(t.String()) }))),
  components: t.Object({
    schemas: t.Record(t.String(), t.Unknown()),
    securitySchemes: t.Record(t.String(), t.Unknown()),
  }),
});

type Catalogue = {
  document: ContractDocument;
  routes: readonly MountedRoute[];
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
  dependencies: { pool: Pool; clock: () => Date; access: () => Access },
) {
  let catalogue: Catalogue | undefined;
  // Read routes from the shared instance. Naming the `get` result here and using it
  // inside the handler makes the route type circular once the 200 schema is closed.
  const routed = app.get(
    '/v1/openapi.json',
    {
      response: {
        200: documentSchema,
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
        document: openApiDocument(app),
        routes: [...app.routes],
      };
      const visible = await visibleOperations({
        viewer: actor,
        pool: dependencies.pool,
        access: dependencies.access(),
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
