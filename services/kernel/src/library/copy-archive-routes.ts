import { t } from 'elysia';
import { bodyBytes } from '../http/body.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { COPY_ARCHIVE_LIMITS } from './copy-archive-format.ts';
import { createCopyArchive, copyArchiveAuthorityTypes, type CopyArchiveDependencies } from './copy-archive.ts';
import { MAX_EPISODE_IDS } from './episode-progress.ts';
import { MAX_PROGRESS_MEASURES } from './progress.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const params = t.Object({ id }, closed);
const reviewParams = t.Object({ id, reviewId: id }, closed);
const unitParams = t.Object({ id, sessionId: id }, closed);
const reviewBody = t.Object(
  {
    sessionId: id,
    subjectId: id,
    mode: t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]),
    unit: t.String({ minLength: 1, maxLength: 128 }),
    additionalMeasures: t.Array(
      t.Object(
        {
          sourceUnit: t.String({ minLength: 1, maxLength: 128 }),
          unit: t.String({ minLength: 1, maxLength: 128 }),
        },
        closed,
      ),
      { maxItems: MAX_PROGRESS_MEASURES - 1 },
    ),
    unitIds: t.Array(t.String({ minLength: 1, maxLength: 128 }), { maxItems: MAX_EPISODE_IDS }),
  },
  closed,
);
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
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
  ),
};
function detail(name: string, write = false, progressAction?: 'progress_session:read' | 'progress_session:create') {
  return {
    operationId: `library_copy_archive.${name}`,
    'x-action': progressAction ?? 'copy:list',
    'x-required-actions': progressAction
      ? ['copy:list', progressAction, ...(progressAction === 'progress_session:create' ? ['progress_session:read', 'progress_session:update'] : [])]
      : ['copy:list'],
    'x-exposure': progressAction ? 'gate:reading_progress' : 'gate:personal_library',
    ...(progressAction ? { 'x-required-exposures': ['gate:personal_library', 'gate:reading_progress'] } : {}),
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': copyArchiveAuthorityTypes,
    security: [{ bearerAuth: [] }],
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
export function copyArchiveRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<CopyArchiveDependencies, 'access'> & { access: () => Access },
) {
  const service = () => createCopyArchive({ ...deps, access: deps.access() });
  type Page = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['page']>>;
  type ProgressPage = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['progressPage']>>;
  type ProgressUnitPage = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['progressUnitPage']>>;
  type Review = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['reviewProgress']>>;
  type Application = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['applyProgress']>>;
  type Result = Awaited<ReturnType<ReturnType<typeof createCopyArchive>['progressResult']>>;
  return app
    .post(
      '/v1/libraryCopyArchives',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        response: {
          200: t.Object({ uploadId: id, holdings: t.Integer(), progressRecords: t.Integer(), expiresAt: t.String() }, closed),
          ...failures,
        },
        detail: {
          ...detail('upload', true),
          'x-body-mode': 'raw',
          'x-body-limit': COPY_ARCHIVE_LIMITS.bytes,
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
      async ({ actor, request, headers, admission, job, session, set }) => {
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
      '/v1/libraryCopyArchives/:id',
      {
        params,
        query: t.Object(
          { after: t.Optional(t.Integer({ minimum: -1, maximum: COPY_ARCHIVE_LIMITS.records - 1 })) },
          closed,
        ),
        response: { 200: t.Unsafe<Page>(t.Any()), ...failures },
        detail: detail('page'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().page(actor, params.id, query.after ?? -1, job.signal));
      },
    )
    .get(
      '/v1/libraryCopyArchives/:id/progress',
      {
        params,
        query: t.Object({ after: t.Optional(t.Integer({ minimum: -1, maximum: COPY_ARCHIVE_LIMITS.records - 1 })) }, closed),
        response: { 200: t.Unsafe<ProgressPage>(t.Any()), ...failures },
        detail: detail('progress_page', false, 'progress_session:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().progressPage(actor, params.id, query.after ?? -1, job.signal));
      },
    )
    .get(
      '/v1/libraryCopyArchives/:id/progress/:sessionId/units',
      {
        params: unitParams,
        query: t.Object({ after: t.Optional(t.Integer({ minimum: -1, maximum: COPY_ARCHIVE_LIMITS.records - 1 })) }, closed),
        response: { 200: t.Unsafe<ProgressUnitPage>(t.Any()), ...failures },
        detail: detail('progress_units', false, 'progress_session:read'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().progressUnitPage(actor, params.id, params.sessionId, query.after ?? -1, job.signal),
        );
      },
    )
    .post(
      '/v1/libraryCopyArchives/:id/progressReviews',
      {
        params,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        body: reviewBody,
        response: { 200: t.Unsafe<Review>(t.Any()), ...failures },
        detail: detail('progress_review', true, 'progress_session:read'),
      },
      async ({ actor, params, body, headers, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().reviewProgress(actor, params.id, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), body, job.signal),
        );
      },
    )
    .post(
      customMethod('/v1/libraryCopyArchives/:id/progressReviews/:reviewId', 'apply'),
      {
        params: reviewParams,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }),
        response: { 200: t.Unsafe<Application>(t.Any()), ...failures },
        detail: detail('progress_apply', true, 'progress_session:create'),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          service().applyProgress(
            actor,
            params.id,
            params.reviewId,
            idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            job.signal,
            (receipt) => session.record(receipt),
          ),
        );
      },
    )
    .get(
      '/v1/libraryCopyArchives/:id/progressReviews/:reviewId',
      {
        params: reviewParams,
        response: { 200: t.Unsafe<Result>(t.Any()), ...failures },
        detail: detail('progress_result', false, 'progress_session:read'),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().progressResult(actor, params.id, params.reviewId, job.signal));
      },
    )
    .post(
      customMethod('/v1/libraryCopyArchives/:id', 'cancel'),
      {
        params,
        response: { 200: t.Object({ uploadId: id, cancelled: t.Literal(true) }, closed), ...failures },
        detail: detail('cancel', true),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().cancel(actor, params.id, job.signal));
      },
    )
    .delete(
      '/v1/libraryCopyArchives/:id',
      {
        params,
        response: { 200: t.Object({ uploadId: id, removed: t.Integer(), complete: t.Boolean() }, closed), ...failures },
        detail: detail('remove', true),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => service().remove(actor, params.id, job.signal));
      },
    );
}
