import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { customMethod } from '../http/custom-method.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { createSessionCommands } from './sessions.ts';
import { createMalImport } from './list-import-mal.ts';
import { MAL_LIMITS } from './list-import-mal-parser.ts';
import { MAL_LABEL_LIMITS } from './list-import-mal-tags.ts';
import { MAL_DATE_LIMITS } from './list-import-mal.ts';
import { ENTRY_IMPORT_METADATA_LIMITS } from './list-import-entry-metadata.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' }),
  row = t.Integer({ minimum: 0, maximum: MAL_LIMITS.rows - 1 });
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const params = t.Object({ id }, closed);
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
};
const detail = (name: string) => ({
  operationId: `library_mal.${name}`,
  'x-action': 'library_entry:update',
  'x-exposure': 'gate:personal_library',
  'x-authority-anchor': 'own-account',
  'x-authority-resource-types': Object.keys(bundledRelease.types),
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
});
const result = t.Object({ id }, closed);
type Page = Awaited<ReturnType<ReturnType<typeof createMalImport>['page']>>;
type Applied = Awaited<ReturnType<ReturnType<typeof createMalImport>['apply']>>;
type DateApplied = Awaited<ReturnType<ReturnType<typeof createMalImport>['applyDates']>>;

export function malImportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: {
    pool: Pool;
    access: () => Access;
    routeKey: Uint8Array;
    tokens: KeyRing;
    journal: ReturnType<typeof createSessionCommands>;
    clock?: KernelClock;
  },
) {
  const service = () => createMalImport({ ...deps, access: deps.access() });
  async function safe<T>(body: () => Promise<T>): Promise<T> {
    try {
      return await body();
    } catch (e) {
      if (e instanceof GrantDeniedError) throw new ProblemError('forbidden');
      throw e;
    }
  }
  return app
    .post(
      customMethod('/v1/libraryImports/mal', 'preview'),
      {
        headers,
        body: t.Object({ xml: t.String({ maxLength: MAL_LIMITS.bytes }) }, closed),
        response: { 200: result, ...failures },
        detail: { ...detail('preview'), 'x-body-limit': MAL_LIMITS.wireBytes },
      },
      async ({ actor, body, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().preview(actor, body.xml, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.deadline),
          );
          session.record(command);
          set.headers['Cache-Control'] = 'private, no-store';
          return command.value;
        }),
    )
    .get(
      '/v1/libraryImports/mal/:id',
      {
        params,
        query: t.Object({ after: t.Optional(t.Integer({ minimum: 0, maximum: MAL_LIMITS.rows })) }, closed),
        response: { 200: t.Unsafe<Page>(t.Any()), ...failures },
        detail: detail('page'),
      },
      async ({ actor, params, query, job, admission, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          return admission.run('normal', job, () => service().page(actor, params.id, query.after ?? 0, job.deadline));
        }),
    )
    .get(
      '/v1/libraryImports/mal/:id/source',
      {
        params,
        response: { 200: t.Object({ xml: t.String() }, closed), ...failures },
        detail: detail('source'),
      },
      async ({ actor, params, job, admission, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          return admission.run('normal', job, () => service().source(actor, params.id, job.deadline));
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/review',
      {
        params,
        headers,
        body: t.Object(
          {
            row,
            target: t.Union([id, t.Null()]),
            skip: t.Boolean(),
            replace: t.Boolean(),
            labels: t.Optional(
              t.Array(
                t.Object(
                  {
                    value: t.Integer({ minimum: 0, maximum: MAL_LABEL_LIMITS.values - 1 }),
                    target: t.Union([
                      t.Object({ labelId: id, revision: t.Integer({ minimum: 1, maximum: 2147483647 }) }, closed),
                      t.Object({ name: t.String({ maxLength: 1024 }) }, closed),
                    ]),
                  },
                  closed,
                ),
                { maxItems: MAL_LABEL_LIMITS.values },
              ),
            ),
          },
          closed,
        ),
        response: { 200: result, ...failures },
        detail: detail('review'),
      },
      async ({ actor, params, body, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().review(actor, params.id, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.deadline),
          );
          session.record(command);
          set.headers['Cache-Control'] = 'private, no-store';
          return command.value;
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/apply',
      {
        params,
        body: t.Object(
          {
            confirm: t.Literal(true),
            rows: t.Array(
              t.Object(
                {
                  row,
                  version: t.String({ minLength: 1, maxLength: 1024 }),
                  fields: t.Array(t.String({ maxLength: 128 }), { maxItems: 64, uniqueItems: true }),
                },
                closed,
              ),
              { minItems: 1, maxItems: MAL_LIMITS.page, uniqueItems: true },
            ),
          },
          closed,
        ),
        response: { 200: t.Unsafe<Applied>(t.Any()), ...failures },
        detail: detail('apply'),
      },
      async ({ actor, params, body, request, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          if (new Set(body.rows.map((r) => r.row)).size !== body.rows.length) throw new ProblemError('invalid_request');
          return admission.run('normal', job, () =>
            service().apply(actor, params.id, body, job.deadline, request.signal, (v) => session.record(v)),
          );
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/metadata/review',
      {
        params,
        headers,
        body: t.Object({ row, sourceReviewToken: t.String({ minLength: 1, maxLength: 128 }) }, closed),
        response: { 200: t.Object({ id, reviewToken: t.String({ minLength: 1, maxLength: 128 }) }, closed), ...failures },
        detail: { ...detail('metadata.review'), 'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS.requestBytes },
      },
      async ({ actor, params, body, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().reviewMetadata(actor, params.id, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.deadline),
          );
          session.record(command);
          return command.value;
        }),
    )
    .get(
      '/v1/libraryImports/mal/:id/metadata/:row',
      {
        params: t.Object({ id, row }, closed),
        query: t.Object({ reviewToken: t.String({ minLength: 1, maxLength: 128 }) }, closed),
        response: { 200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createMalImport>['metadata']>>>(t.Any()), ...failures },
        detail: detail('metadata'),
      },
      async ({ actor, params, query, job, admission, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          return admission.run('normal', job, () => service().metadata(actor, params.id, params.row, query.reviewToken, job.deadline));
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/metadata/apply',
      {
        params,
        body: t.Object(
          {
            row,
            reviewToken: t.String({ minLength: 1, maxLength: 128 }),
            fields: t.Array(
              t.Object({
                field: t.Union(['note', 'priority', 'privacy', 'sourceCreated', 'sourceUpdated'].map((v) => t.Literal(v))),
                action: t.Union([t.Literal('adopt'), t.Literal('clear')]),
                mapping: t.Optional(t.String({ maxLength: 64 })),
              }, closed),
              { minItems: 1, maxItems: ENTRY_IMPORT_METADATA_LIMITS.fields },
            ),
          },
          closed,
        ),
        response: { 200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createMalImport>['applyMetadata']>>>(t.Any()), ...failures },
        detail: { ...detail('metadata.apply'), 'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS.requestBytes },
      },
      async ({ actor, params, body, request, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          return admission.run('normal', job, () =>
            service().applyMetadata(actor, params.id, body.row, body.reviewToken, body.fields, job.deadline, request.signal,
              (value) => session.record(value)),
          );
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/dates/review',
      {
        params,
        headers,
        body: t.Object(
          {
            row,
            occurrenceId: id,
            startAction: t.Optional(t.Union([t.Literal('adopt'), t.Literal('clear')])),
            finishAction: t.Optional(t.Union([t.Literal('adopt'), t.Literal('clear')])),
          },
          closed,
        ),
        response: { 200: result, ...failures },
        detail: { ...detail('dates_review'), 'x-body-limit': MAL_DATE_LIMITS.requestBytes },
      },
      async ({ actor, params, body, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().reviewDates(actor, params.id, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.deadline),
          );
          session.record(command);
          return command.value;
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/dates/apply',
      {
        params,
        body: t.Object(
          {
            confirm: t.Literal(true),
            rows: t.Array(
              t.Object(
                {
                  row,
                  version: t.String({ minLength: 1, maxLength: 1024 }),
                  fields: t.Array(t.Union([t.Literal('startDate'), t.Literal('finishDate')]), {
                    minItems: 1,
                    maxItems: MAL_DATE_LIMITS.fields,
                    uniqueItems: true,
                  }),
                },
                closed,
              ),
              { minItems: 1, maxItems: MAL_DATE_LIMITS.rows, uniqueItems: true },
            ),
          },
          closed,
        ),
        response: { 200: t.Unsafe<DateApplied>(t.Any()), ...failures },
        detail: { ...detail('dates_apply'), 'x-body-limit': MAL_DATE_LIMITS.requestBytes },
      },
      async ({ actor, params, body, request, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          if (new Set(body.rows.map((r) => r.row)).size !== body.rows.length) throw new ProblemError('invalid_request');
          return admission.run('normal', job, () =>
            service().applyDates(actor, params.id, body, job.deadline, request.signal, (value) =>
              session.record(value),
            ),
          );
        }),
    )
    .post(
      '/v1/libraryImports/mal/:id/cancel',
      {
        params,
        headers,
        body: t.Object({}, closed),
        response: { 200: result, ...failures },
        detail: detail('cancel'),
      },
      async ({ actor, params, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().cancel(actor, params.id, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(command);
          return command.value;
        }),
    )
    .delete(
      '/v1/libraryImports/mal/:id',
      {
        params,
        headers,
        response: { 200: result, ...failures },
        detail: detail('delete'),
      },
      async ({ actor, params, headers, job, admission, session, set }) =>
        safe(async () => {
          set.headers['Cache-Control'] = 'private, no-store';
          const command = await admission.run('normal', job, () =>
            service().delete(actor, params.id, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          );
          session.record(command);
          return command.value;
        }),
    );
}
