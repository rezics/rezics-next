import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { createVndbLabelAdoption } from './list-import-vndb-labels.ts';
import { vndbLabelChoiceSchema, VNDB_LABEL_LIMITS } from './list-import-vndb-label-model.ts';

type Service = ReturnType<typeof createVndbLabelAdoption>;
type Output<K extends keyof Service> = Awaited<ReturnType<Service[K]>>;
const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
const params = t.Object({ uploadId: uuid }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const errors = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'semantic_not_ready',
  ),
};
const response = <T>() => ({ 200: t.Unsafe<T>(t.Any()), ...errors });
const detail = (operation: string, write = true) => ({
  operationId: `library_vndb.labels.${operation}`,
  'x-action': 'library_entry:update',
  'x-exposure': 'gate:personal_library',
  'x-authority-anchor': 'own-account',
  'x-authority-resource-types': Object.keys(bundledRelease.types),
  security: [{ bearerAuth: [] }],
  ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }), 'x-body-limit': 32768 } : {}),
});
async function run<T>(set: { headers: Record<string, unknown> }, body: () => Promise<T>) {
  set.headers['cache-control'] = 'private, no-store';
  try {
    return await body();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    if (error instanceof LibraryConflictError) throw new ProblemError('conflict');
    throw error;
  }
}
/** Additional methods in Web's existing VNDB flow, with native receiving types. */
export function vndbLabelAdoptionRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<Parameters<typeof createVndbLabelAdoption>[0], 'access'> & { access: () => Access },
) {
  const service = () => createVndbLabelAdoption({ ...deps, access: deps.access() });
  return app
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId/labels', 'review'),
      {
        params,
        headers,
        body: vndbLabelChoiceSchema,
        response: response<Output<'review'>['value']>(),
        detail: detail('review'),
      },
      ({ actor, params, headers, body, admission, job, session, set }) =>
        run(set, async () => {
          const outcome = await admission.run('normal', job, () =>
            service().review(actor, params.uploadId, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(outcome);
          return outcome.value;
        }),
    )
    .get(
      '/v1/libraryImports/vndb/:uploadId/labels',
      {
        params,
        query: t.Object(
          { after: t.Optional(t.Integer({ minimum: -1, maximum: VNDB_LABEL_LIMITS.items - 1 })) },
          closed,
        ),
        response: response<Output<'page'>>(),
        detail: detail('page', false),
      },
      ({ actor, params, query, admission, job, set }) =>
        run(set, () => admission.run('normal', job, () => service().page(actor, params.uploadId, query.after ?? -1))),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId/labels', 'apply'),
      {
        params,
        body: t.Object(
          {
            previewId: uuid,
            items: t.Array(t.Integer({ minimum: 0, maximum: VNDB_LABEL_LIMITS.items - 1 }), {
              minItems: 1,
              maxItems: VNDB_LABEL_LIMITS.page,
            }),
          },
          closed,
        ),
        response: response<Output<'apply'>>(),
        detail: detail('apply'),
      },
      ({ actor, params, body, request, admission, job, session, set }) =>
        run(set, () =>
          admission.run('normal', job, () =>
            service().apply(
              actor,
              params.uploadId,
              body.previewId,
              body.items,
              (outcome) => session.record(outcome),
              request.signal,
            ),
          ),
        ),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId/labels', 'cancel'),
      {
        params,
        headers,
        body: t.Object({ previewId: uuid }, closed),
        response: response<Output<'cancel'>['value']>(),
        detail: detail('cancel'),
      },
      ({ actor, params, body, headers, admission, job, session, set }) =>
        run(set, async () => {
          const outcome = await admission.run('normal', job, () =>
            service().cancel(actor, params.uploadId, body.previewId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(outcome);
          return outcome.value;
        }),
    );
}
