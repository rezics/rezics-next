import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Access } from '../../request/access.ts';
import { problemSchema } from '../../http/problem.ts';
import type { MountedRoute } from '../../http/request.ts';
import type { definitionRoutes } from '../../semantic/http/definitions.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import { readExposureManagementPage } from './management-read.ts';

const closed = { additionalProperties: false } as const;

/** Capture the complete catalogue after construction, matching the existing discovery routes. */
export function exposureManagementRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: Pool; clock: () => Date; access: () => Access; cursorKeys: KeyRing },
) {
  let catalogue: readonly MountedRoute[] | undefined;
  return app.get(
    '/v1/platform/exposure/management',
    {
      query: t.Object(
        {
          cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
        },
        closed,
      ),
      response: {
        200: t.Object(
          {
            viewer: t.Object({ accountId: t.String(), clientId: t.String() }, closed),
            actions: t.Object({ open: t.Boolean(), close: t.Boolean() }, closed),
            exposureGroups: t.Array(t.Object({ group: t.String(), open: t.Boolean(), at: t.String() }, closed), {
              maxItems: 100,
            }),
            next: t.Union([t.String(), t.Null()]),
          },
          closed,
        ),
        400: problemSchema('invalid_request', 'invalid_cursor'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        503: problemSchema(
          'overloaded',
          'deadline_exceeded',
          'partition_unavailable',
          'transaction_retry_exhausted',
          'dependency_unavailable',
        ),
      },
      detail: {
        operationId: 'exposure.read_management',
        'x-action': 'exposure:manage_read',
        'x-exposure': 'public',
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, query, job, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      catalogue ??= Object.freeze([...app.routes]);
      return readExposureManagementPage(
        { ...dependencies, access: dependencies.access(), routes: catalogue },
        actor,
        query,
        { deadline: job.deadline },
      );
    },
  );
}
