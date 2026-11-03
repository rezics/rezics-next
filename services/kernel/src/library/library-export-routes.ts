import { t } from 'elysia';
import { defineRateLimit } from '../http/rate-limit.ts';
import { problemSchema } from '../http/problem.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { createLibraryExport, exportAuthorityTypes, type LibraryExportDependencies } from './library-export.ts';

const closed = { additionalProperties: false } as const;
const params = t.Object({ id: t.String({ format: 'uuid' }) }, closed);
const text = t.String();
const nullable = t.Union([text, t.Null()]);
const manifestFields = {
  format: t.Literal('https://rezics.com/formats/library-export'),
  version: t.Literal(1),
  exportId: text,
  capturedAt: text,
  expiresAt: text,
  privacy: t.Literal('private'),
  completeness: t.Literal('supported-native-facts'),
  sections: t.Array(text),
  omissions: t.Record(text, text),
  fullExport: t.Literal(false),
};
const state = t.Union(
  ['collecting', 'ready', 'stale', 'cancelled', 'expired', 'limit'].map((value) => t.Literal(value)),
);
const statusSchema = t.Object({ ...manifestFields, state, first: nullable }, closed);
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};
function detail(operationId: string, write = false) {
  return {
    operationId,
    'x-action': 'library_entry:list',
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': exportAuthorityTypes,
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}

export function libraryExportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<LibraryExportDependencies, 'access'> & { access: () => Access },
) {
  const service = () => createLibraryExport({ ...deps, access: deps.access() });
  return app
    .post(
      '/v1/libraryExports',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: text }),
        response: { 200: statusSchema, ...failures },
        detail: detail('library_export.create', true),
      },
      async ({ actor, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().create(actor, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.signal),
        );
      },
    )
    .get(
      '/v1/libraryExports/:id',
      {
        params,
        response: { 200: statusSchema, ...failures },
        detail: detail('library_export.get'),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().get(actor, params.id, job.signal));
      },
    )
    .get(
      '/v1/libraryExports/:id/pages',
      {
        params,
        query: t.Object({ cursor: t.String({ minLength: 1, maxLength: 4096 }) }, closed),
        response: {
          200: t.Object(
            {
              exportId: text,
              state,
              records: t.Array(t.Record(text, t.Unknown()), { maxItems: 16 }),
              next: nullable,
              manifest: t.Union([
                t.Object(
                  {
                    ...manifestFields,
                    rows: t.Integer(),
                    recordBytes: t.Integer(),
                  },
                  closed,
                ),
                t.Null(),
              ]),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('library_export.page'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().page(actor, params.id, query.cursor, job.signal));
      },
    )
    .delete(
      '/v1/libraryExports/:id',
      {
        params,
        response: { 200: statusSchema, ...failures },
        detail: detail('library_export.cancel', true),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().cancel(actor, params.id, job.signal));
      },
    );
}
