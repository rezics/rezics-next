import { memoizedValue } from '../memoized.ts';
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
import { vndbLabelAdoptionRoutes } from './list-import-vndb-label-routes.ts';
import { VNDB_LIMITS, VndbInvalid } from './list-import-vndb-parser.ts';
import { ENTRY_IMPORT_METADATA_LIMITS } from './list-import-entry-metadata.ts';
import { IMPORT_CONSUMPTION_LIMITS } from './import-consumption.ts';
import {
  vndbApplySchema,
  vndbPageSchema,
  vndbPreviewSchema,
  vndbRemovalSchema,
  vndbReviewSchema,
  vndbSourceSchema,
} from './list-import-vndb-http.ts';

type Service = ReturnType<typeof createVndbImport>;
type Output<K extends keyof Service> = Awaited<ReturnType<Service[K]>>;
const closed = { additionalProperties: false } as const;
const uuid = t.String({ format: 'uuid' });
function ordinal() {
  return memoizedValue(ordinal, () => t.Integer({ minimum: 0, maximum: VNDB_LIMITS.rows - 1 }));
}
function dateRows() {
  return memoizedValue(dateRows, () => Math.min(IMPORT_CONSUMPTION_LIMITS.rows, VNDB_LIMITS.page));
}
const params = t.Object({ uploadId: uuid }, closed);
function metadataParams() {
  return memoizedValue(metadataParams, () => t.Object({ uploadId: uuid, ordinal: ordinal() }, closed));
}
const metadataSelection = t.Object(
  {
    field: t.Union([
      t.Literal('note'),
      t.Literal('priority'),
      t.Literal('privacy'),
      t.Literal('sourceCreated'),
      t.Literal('sourceUpdated'),
    ]),
    action: t.Union([t.Literal('adopt'), t.Literal('clear')]),
    mapping: t.Optional(t.String({ maxLength: 64 })),
  },
  closed,
);
const scoreSelection = t.Union([
  t.Object({ kind: t.Literal('vote'), units: t.Integer({ minimum: 0, maximum: 20 }) }, closed),
  t.Object({ kind: t.Literal('clear') }, closed),
]);
const progressSelection = t.Object(
  {
    occurrence: t.Union([
      t.Object({ kind: t.Literal('existing'), sessionId: uuid }, closed),
      t.Object({ kind: t.Literal('start'), primaryUnit: t.String({ minLength: 1, maxLength: 64 }) }, closed),
    ]),
    measures: t.Array(
      t.Object(
        {
          field: t.String({ minLength: 1, maxLength: 64 }),
          action: t.Union([t.Literal('adopt'), t.Literal('clear')]),
          replace: t.Optional(t.Boolean()),
        },
        closed,
      ),
      { minItems: 1, maxItems: 8 },
    ),
  },
  closed,
);
function reviewChoice() {
  return memoizedValue(reviewChoice, () =>
    t.Union([
      t.Object(
        { ordinal: ordinal(), action: t.Union([t.Literal('skip'), t.Literal('retain')]), targetId: t.Optional(uuid) },
        closed,
      ),
      t.Object(
        {
          ordinal: ordinal(),
          action: t.Literal('state'),
          targetId: t.Optional(uuid),
          state: t.String({ pattern: '^[a-z][a-z0-9_.-]{0,63}$' }),
          replace: t.Optional(t.Boolean()),
          progress: t.Optional(progressSelection),
        },
        closed,
      ),
      t.Object(
        { ordinal: ordinal(), action: t.Literal('progress'), targetId: t.Optional(uuid), progress: progressSelection },
        closed,
      ),
      t.Object(
        {
          ordinal: ordinal(),
          action: t.Literal('score'),
          targetId: t.Optional(uuid),
          questionId: uuid,
          questionRevision: t.Integer({ minimum: 1 }),
          selection: scoreSelection,
          consent: t.Union([t.Literal('adopt-native-vote'), t.Literal('clear-native-vote')]),
        },
        closed,
      ),
    ]),
  );
}
function headers() {
  return memoizedValue(headers, () => t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }));
}
function failures() {
  return memoizedValue(failures, () => ({
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
  }));
}
function schemas() {
  return memoizedValue(schemas, () => ({
    page: vndbPageSchema(),
    apply: vndbApplySchema(),
    source: vndbSourceSchema(),
  }));
}
const response = <K extends keyof ReturnType<typeof schemas>>(kind: K) => ({
  200: t.Unsafe<Output<K>>(schemas()[kind]),
  ...failures(),
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
  return vndbLabelAdoptionRoutes(app, dependencies)
    .post(
      customMethod('/v1/libraryImports/vndb', 'preview'),
      {
        headers: headers(),
        body: t.Object({ xml: t.String({ minLength: 1, maxLength: VNDB_LIMITS.bytes }) }, closed),
        response: { 200: t.Unsafe<Output<'preview'>['value']>(vndbPreviewSchema()), ...failures() },
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
        headers: headers(),
        body: reviewChoice(),
        response: { 200: t.Unsafe<Output<'review'>['value']>(vndbReviewSchema), ...failures() },
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
      '/v1/libraryImports/vndb/:uploadId/dates/review',
      {
        params,
        headers: headers(),
        body: t.Object(
          {
            ordinal: ordinal(),
            sourceReviewToken: uuid,
            occurrenceId: uuid,
            startAction: t.Optional(t.Union([t.Literal('adopt'), t.Literal('clear')])),
            finishAction: t.Optional(t.Union([t.Literal('adopt'), t.Literal('clear')])),
          },
          closed,
        ),
        response: {
          200: t.Unsafe<Output<'reviewConsumptionDates'>['value']>(t.Any()),
          ...failures(),
        },
        detail: { ...detail('dates_review'), 'x-body-limit': IMPORT_CONSUMPTION_LIMITS.requestBytes },
      },
      ({ actor, params, body, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().reviewConsumptionDates(
              actor,
              params.uploadId,
              body,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          );
          session.record(result);
          return result.value;
        }),
    )
    .post(
      '/v1/libraryImports/vndb/:uploadId/dates/apply',
      {
        params,
        body: t.Object(
          {
            confirm: t.Literal(true),
            rows: t.Array(
              t.Object(
                {
                  ordinal: ordinal(),
                  version: uuid,
                  fields: t.Array(t.Union([t.Literal('startDate'), t.Literal('finishDate')]), {
                    minItems: 1,
                    maxItems: IMPORT_CONSUMPTION_LIMITS.fields,
                    uniqueItems: true,
                  }),
                },
                closed,
              ),
              { minItems: 1, maxItems: dateRows(), uniqueItems: true },
            ),
          },
          closed,
        ),
        response: { 200: t.Unsafe<Output<'applyConsumptionDates'>>(t.Any()), ...failures() },
        detail: { ...detail('dates_apply'), 'x-body-limit': IMPORT_CONSUMPTION_LIMITS.requestBytes },
      },
      ({ actor, params, body, request, admission, job, session, set }) =>
        run(set, () =>
          admission.run('normal', job, () =>
            service().applyConsumptionDates(
              actor,
              params.uploadId,
              body,
              (outcome) => session.record(outcome),
              request.signal,
            ),
          ),
        ),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'reviewMetadata'),
      {
        params,
        headers: headers(),
        body: t.Object({ ordinal: ordinal(), sourceReviewToken: uuid }, closed),
        response: { 200: t.Unsafe<Output<'reviewMetadata'>['value']>(t.Any()), ...failures() },
        detail: { ...detail('review_metadata'), 'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS().requestBytes },
      },
      ({ actor, params, body, headers, admission, job, session, set }) =>
        run(set, async () => {
          const result = await admission.run('normal', job, () =>
            service().reviewMetadata(
              actor,
              params.uploadId,
              body.ordinal,
              body.sourceReviewToken,
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            ),
          );
          session.record(result);
          return result.value;
        }),
    )
    .get(
      '/v1/libraryImports/vndb/:uploadId/metadata/:ordinal',
      {
        params: metadataParams(),
        query: t.Object({ reviewToken: uuid }, closed),
        response: { 200: t.Unsafe<Output<'metadata'>>(t.Any()), ...failures() },
        detail: detail('read_metadata', false),
      },
      ({ actor, params, query, admission, job, set }) =>
        run(set, () =>
          admission.run('normal', job, () =>
            service().metadata(actor, params.uploadId, params.ordinal, query.reviewToken),
          ),
        ),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'applyMetadata'),
      {
        params,
        body: t.Object(
          {
            ordinal: ordinal(),
            reviewToken: uuid,
            fields: t.Array(metadataSelection, {
              minItems: 1,
              maxItems: ENTRY_IMPORT_METADATA_LIMITS().fields,
              uniqueItems: true,
            }),
          },
          closed,
        ),
        response: { 200: t.Unsafe<Output<'applyMetadata'>>(t.Any()), ...failures() },
        detail: { ...detail('apply_metadata'), 'x-body-limit': ENTRY_IMPORT_METADATA_LIMITS().requestBytes },
      },
      ({ actor, params, body, request, admission, job, session, set }) =>
        run(set, () =>
          admission.run('normal', job, () =>
            service().applyMetadata(
              actor,
              params.uploadId,
              body.ordinal,
              body.reviewToken,
              body.fields,
              (outcome) => session.record(outcome),
              request.signal,
            ),
          ),
        ),
    )
    .post(
      customMethod('/v1/libraryImports/vndb/:uploadId', 'apply'),
      {
        params,
        body: t.Object(
          {
            rows: t.Array(
              t.Object({ ordinal: ordinal(), reviewId: t.Optional(uuid), scoreReviewId: t.Optional(uuid) }, closed),
              {
                minItems: 1,
                maxItems: VNDB_LIMITS.page,
              },
            ),
          },
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
        headers: headers(),
        response: { 200: t.Unsafe<Output<'remove'>['value']>(vndbRemovalSchema), ...failures() },
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
        headers: headers(),
        response: { 200: t.Unsafe<Output<'remove'>['value']>(vndbRemovalSchema), ...failures() },
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
