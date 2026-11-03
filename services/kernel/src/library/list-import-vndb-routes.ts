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
import { createVndbImport } from './list-import-vndb.ts';
import { VNDB_LIMITS, VndbInvalid } from './list-import-vndb-parser.ts';
import {
  vndbApplySchema,
  vndbDecisionSchema,
  vndbPageSchema,
  vndbPreviewSchema,
  vndbRemovalSchema,
  vndbSourceSchema,
} from './list-import-vndb-http.ts';

type Service = ReturnType<typeof createVndbImport>;
type Output<K extends keyof Service> = Awaited<ReturnType<Service[K]>>;
const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' }),
  ordinal = t.Integer({ minimum: 0, maximum: VNDB_LIMITS.rows - 1 });
const params = t.Object({ uploadId: uuid }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
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
const schemas = { page: vndbPageSchema, apply: vndbApplySchema, source: vndbSourceSchema };
const response = <K extends keyof typeof schemas>(kind: K) => ({
  200: t.Unsafe<Output<K>>(schemas[kind]),
  ...failures,
});
const detail = (operation: string, write = true) => ({
  operationId: `library_vndb.${operation}`,
  'x-action': 'library_entry:update',
  'x-exposure': 'gate:personal_library',
  'x-authority-anchor': 'own-account',
  'x-authority-resource-types': Object.keys(bundledRelease.types),
  security: [{ bearerAuth: [] }],
  ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
});
async function run<T>(set: { headers: Record<string, unknown> }, body: () => Promise<T>): Promise<T> {
  set.headers['cache-control'] = 'private, no-store';
  try {
    return await body();
  } catch (error) {
    if (error instanceof VndbInvalid) throw new ProblemError('invalid_request');
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    throw error;
  }
}
export function vndbImportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: Omit<Parameters<typeof createVndbImport>[0], 'access'> & { access: () => Access },
) {
  const service = () => createVndbImport({ ...dependencies, access: dependencies.access() });
  return app
    .post(
      customMethod('/v1/libraryImports/vndb', 'preview'),
      {
        headers,
        body: t.Object({ xml: t.String({ minLength: 1, maxLength: VNDB_LIMITS.bytes }) }, closed),
        response: { 200: t.Unsafe<Output<'preview'>['value']>(vndbPreviewSchema), ...failures },
        detail: { ...detail('preview'), 'x-body-limit': VNDB_LIMITS.wireBytes },
      },
      async ({ actor, body, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().preview(actor, body.xml, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(result);
          return result.value;
        }),
    )
    .get(
      '/v1/libraryImports/vndb/:uploadId',
      {
        params,
        query: t.Object(
          { offset: t.Optional(t.Integer({ minimum: 0, maximum: VNDB_LIMITS.rows, default: 0 })) },
          closed,
        ),
        response: response('page'),
        detail: detail('page', false),
      },
      ({ actor, params, query, admission, job, set }) =>
        run(set, () => admission.run('normal', job, () => service().page(actor, params.uploadId, query.offset ?? 0))),
    )
    .get(
      '/v1/libraryImports/vndb/:uploadId/source',
      { params, response: response('source'), detail: detail('source', false) },
      ({ actor, params, admission, job, set }) =>
        run(set, () => admission.run('normal', job, () => service().source(actor, params.uploadId))),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'review'),
      {
        params,
        headers,
        body: t.Object(
          {
            ordinal,
            action: t.Union([t.Literal('skip'), t.Literal('retain'), t.Literal('state')]),
            targetId: t.Optional(uuid),
            state: t.Optional(t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' })),
            replace: t.Optional(t.Boolean()),
          },
          closed,
        ),
        response: { 200: t.Unsafe<Output<'review'>['value']>(vndbDecisionSchema), ...failures },
        detail: detail('review'),
      },
      ({ actor, params, body, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().review(actor, params.uploadId, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(result);
          return result.value;
        }),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'apply'),
      {
        params,
        body: t.Object(
          { rows: t.Array(t.Object({ ordinal, reviewId: uuid }, closed), { minItems: 1, maxItems: VNDB_LIMITS.page }) },
          closed,
        ),
        response: response('apply'),
        detail: detail('apply'),
      },
      ({ actor, params, body, request, admission, job, session, set }) =>
        run(set, () =>
          admission.run('normal', job, () =>
            service().apply(actor, params.uploadId, body.rows, (outcome) => session.record(outcome), request.signal),
          ),
        ),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'cancel'),
      {
        params,
        headers,
        response: { 200: t.Unsafe<Output<'remove'>['value']>(vndbRemovalSchema), ...failures },
        detail: detail('cancel'),
      },
      ({ actor, params, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().remove(actor, params.uploadId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), true),
          );
          session.record(result);
          return result.value;
        }),
    )
    .delete(
      '/v1/libraryImports/vndb/:uploadId',
      {
        params,
        headers,
        response: { 200: t.Unsafe<Output<'remove'>['value']>(vndbRemovalSchema), ...failures },
        detail: detail('delete'),
      },
      ({ actor, params, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().remove(actor, params.uploadId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), false),
          );
          session.record(result);
          return result.value;
        }),
    );
}
