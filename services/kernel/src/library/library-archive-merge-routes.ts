import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bodyBytes } from '../http/body.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  LIBRARY_ARCHIVE_MERGE_LIMITS,
  createLibraryArchiveMerge,
  type ArchiveMergeReviewInput,
  type LibraryArchiveMergeDependencies,
} from './library-archive-merge.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const text = t.String();
const nullable = t.Union([text, t.Null()]);
const object = t.Record(text, t.Any());
const coverage = t.Array(
  t.Object(
    {
      section: text,
      capture: t.Union([t.Literal('present'), t.Literal('empty')]),
      treatment: t.Union([t.Literal('requires-explicit-mapping'), t.Literal('retained-unsupported')]),
      rows: t.Integer({ minimum: 0 }),
    },
    closed,
  ),
);
const uploadState = t.Union([t.Literal('ready'), t.Literal('cancelled'), t.Literal('expired')]);
const statusSchema = t.Object(
  {
    uploadId: id,
    createdAt: text,
    expiresAt: text,
    state: uploadState,
    rows: t.Integer({ minimum: 0, maximum: LIBRARY_ARCHIVE_MERGE_LIMITS.records }),
    recordBytes: t.Integer({ minimum: 0, maximum: LIBRARY_ARCHIVE_MERGE_LIMITS.recordBytes }),
    coverage,
  },
  closed,
);
const pageQuery = t.Object(
  {
    after: t.Optional(t.Integer({ minimum: -1, maximum: LIBRARY_ARCHIVE_MERGE_LIMITS.records - 1, default: -1 })),
    limit: t.Optional(t.Integer({ minimum: 1, maximum: LIBRARY_ARCHIVE_MERGE_LIMITS.page, default: 50 })),
  },
  closed,
);
const ordinal = t.Integer({ minimum: 0, maximum: LIBRARY_ARCHIVE_MERGE_LIMITS.records - 1 });
const fieldChoice = t.Union([t.Literal('preserve'), t.Literal('set'), t.Literal('clear')]);
const reviewItem = t.Union([
  t.Object(
    {
      ordinal,
      kind: t.Literal('entry'),
      subjectId: id,
      action: t.Literal('preserve'),
    },
    closed,
  ),
  t.Object(
    {
      ordinal,
      kind: t.Literal('entry'),
      subjectId: id,
      stateId: t.String({ minLength: 1, maxLength: 64 }),
      action: t.Union([t.Literal('create'), t.Literal('update')]),
    },
    closed,
  ),
  t.Object(
    {
      ordinal,
      kind: t.Literal('label'),
      target: t.Union([
        t.Object({ mode: t.Literal('existing'), labelId: id }, closed),
        t.Object({ mode: t.Literal('create') }, closed),
      ]),
    },
    closed,
  ),
  t.Object(
    {
      ordinal,
      kind: t.Literal('assignment'),
      subjectId: id,
      action: t.Union([t.Literal('assign'), t.Literal('preserve')]),
    },
    closed,
  ),
  t.Object(
    {
      ordinal,
      kind: t.Literal('annotation'),
      subjectId: id,
      incarnationId: id,
      fields: t.Object({ note: t.Optional(fieldChoice), priority: t.Optional(fieldChoice) }, closed),
    },
    closed,
  ),
  t.Object(
    {
      ordinal,
      kind: t.Literal('journal'),
      subjectId: id,
      sessionId: id,
      fields: t.Object({ startDate: t.Optional(fieldChoice), finishDate: t.Optional(fieldChoice) }, closed),
    },
    closed,
  ),
]);
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema(
    'dependency_unavailable',
    'overloaded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'deadline_exceeded',
  ),
};

function detail(operationId: string, action: 'library_entry:read' | 'library_entry:update', write = false) {
  return {
    operationId,
    'x-action': action,
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}

export function libraryArchiveMergeRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<LibraryArchiveMergeDependencies, 'access'> & { access: () => Access },
) {
  const service = () => createLibraryArchiveMerge({ ...deps, access: deps.access() });
  return app
    .post(
      '/v1/libraryArchiveMerges',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: text }),
        response: { 200: statusSchema, ...failures },
        detail: {
          ...detail('library_archive_merge.upload', 'library_entry:update', true),
          'x-body-mode': 'raw',
          'x-body-limit': LIBRARY_ARCHIVE_MERGE_LIMITS.uploadBytes,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['manifest', 'records'],
                  additionalProperties: false,
                  properties: { manifest: { type: 'object' }, records: { type: 'array', items: { type: 'object' } } },
                },
              },
            },
          },
        },
      },
      async ({ request, actor, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const bytes = bodyBytes(request);
        if (!bytes) throw new ProblemError('invalid_request');
        const result = await admission.run('normal', job, () =>
          service().upload(actor, bytes, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), job.signal),
        );
        session.record(result);
        return result.value;
      },
    )
    .get(
      '/v1/libraryArchiveMerges/:id',
      {
        params: t.Object({ id }, closed),
        response: { 200: statusSchema, ...failures },
        detail: detail('library_archive_merge.get', 'library_entry:read'),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().get(actor, params.id, job.signal));
      },
    )
    .get(
      '/v1/libraryArchiveMerges/:id/preview',
      {
        params: t.Object({ id }, closed),
        query: pageQuery,
        response: {
          200: t.Object(
            {
              uploadId: id,
              state: uploadState,
              coverage,
              records: t.Array(
                t.Object({
                  ordinal,
                  section: text,
                  evidence: object,
                  status: text,
                  review: t.Union([object, t.Null()]),
                }),
                { maxItems: LIBRARY_ARCHIVE_MERGE_LIMITS.page },
              ),
              next: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('library_archive_merge.preview', 'library_entry:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().page(actor, params.id, query.after ?? -1, query.limit ?? 50, job.signal),
        );
      },
    )
    .patch(
      '/v1/libraryArchiveMerges/:id/review',
      {
        params: t.Object({ id }, closed),
        body: t.Object(
          { items: t.Array(reviewItem, { minItems: 1, maxItems: LIBRARY_ARCHIVE_MERGE_LIMITS.reviewItems }) },
          closed,
        ),
        response: {
          200: t.Object({ uploadId: id, reviewed: t.Array(t.Object({ ordinal, status: text }, closed)) }, closed),
          ...failures,
        },
        detail: detail('library_archive_merge.review', 'library_entry:update', true),
      },
      async ({ actor, params, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().review(actor, params.id, body.items as ArchiveMergeReviewInput[], job.signal),
        );
      },
    )
    .post(
      '/v1/libraryArchiveMerges/:id/apply',
      {
        params: t.Object({ id }, closed),
        body: t.Object(
          { ordinals: t.Array(ordinal, { minItems: 1, maxItems: LIBRARY_ARCHIVE_MERGE_LIMITS.applyItems }) },
          closed,
        ),
        response: {
          200: t.Object(
            {
              uploadId: id,
              applied: t.Array(t.Object({ ordinal, status: text, result: t.Union([object, t.Null()]) }, closed)),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('library_archive_merge.apply', 'library_entry:update', true),
      },
      async ({ actor, params, body, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().apply(actor, params.id, body.ordinals, job.signal));
      },
    )
    .get(
      '/v1/libraryArchiveMerges/:id/results',
      {
        params: t.Object({ id }, closed),
        query: pageQuery,
        response: {
          200: t.Object(
            {
              uploadId: id,
              state: uploadState,
              results: t.Array(
                t.Object({ ordinal, section: text, status: text, result: t.Union([object, t.Null()]) }, closed),
                { maxItems: LIBRARY_ARCHIVE_MERGE_LIMITS.page },
              ),
              next: t.Union([t.Integer({ minimum: 0 }), t.Null()]),
            },
            closed,
          ),
          ...failures,
        },
        detail: detail('library_archive_merge.results', 'library_entry:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().results(actor, params.id, query.after ?? -1, query.limit ?? 50, job.signal),
        );
      },
    )
    .delete(
      '/v1/libraryArchiveMerges/:id',
      {
        params: t.Object({ id }, closed),
        response: { 200: statusSchema, ...failures },
        detail: detail('library_archive_merge.cancel', 'library_entry:update', true),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().cancel(actor, params.id, job.signal));
      },
    )
    .post(
      '/v1/libraryArchiveMerges/:id/prune',
      {
        params: t.Object({ id }, closed),
        response: {
          200: t.Object({ uploadId: id, removed: t.Integer({ minimum: 0 }), complete: t.Boolean() }, closed),
          ...failures,
        },
        detail: detail('library_archive_merge.prune', 'library_entry:update', true),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().prune(actor, params.id, job.signal));
      },
    );
}
