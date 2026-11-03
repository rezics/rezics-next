import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { idempotencyKeyOf, IDEMPOTENCY_HEADER } from '../http/request.ts';
import { customMethod } from '../http/custom-method.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { AniListInputError } from './list-import-anilist-parser.ts';
import { ANILIST_LABEL_LIMITS } from './list-import-anilist-label-evidence.ts';
import { createAniListImport } from './list-import-anilist.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const ordinal = t.Integer({ minimum: 0, maximum: 199 });
const params = t.Object({ importId: id }, closed);
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden', 'platform_closed'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};
function detail(operation: string) {
  return {
    operationId: `library_import_anilist.${operation}`,
    'x-action': 'library_entry:update',
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  };
}
async function command<T>(run: () => Promise<T>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AniListInputError) throw new ProblemError('invalid_request');
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    if (error instanceof LibraryConflictError) throw new ProblemError('conflict');
    throw error;
  }
}
/** Mounted native journey; the browser never supplies account authority or native command operands. */
export function aniListImportRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: {
    pool: Pool;
    access: () => Access;
    clock: KernelClock;
    tokens: KeyRing;
    routeKey: Uint8Array;
  },
) {
  const imports = () => createAniListImport({ ...deps, access: deps.access() });
  const path = '/v1/libraryImports/anilist/:importId';
  return app
    .post(
      customMethod('/v1/libraryImports/anilist', 'preview'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        headers,
        body: t.Object(
          {
            upload: t.String({ maxLength: 1048576 }),
            scoreFormat: t.Optional(
              t.Union(['POINT_100', 'POINT_10', 'POINT_10_DECIMAL', 'POINT_5', 'POINT_3'].map((v) => t.Literal(v))),
            ),
          },
          closed,
        ),
        response: { 200: t.Object({ id, count: t.Integer() }, closed), ...failures },
        detail: detail('preview'),
      },
      ({ actor, body, headers }) =>
        command(() =>
          imports().preview(actor, body.upload, body.scoreFormat, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
        ),
    )
    .get(
      path,
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        query: t.Object({ after: t.Optional(t.Integer({ minimum: -1, maximum: 199 })) }, closed),
        // Exact private result type is shared with the native composition, including retained arbitrary source JSON.
        response: {
          200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createAniListImport>['page']>>>(
            t.Object({}, { additionalProperties: true }),
          ),
          ...failures,
        },
        detail: detail('page'),
      },
      ({ actor, params, query }) => command(() => imports().page(actor, params.importId, query.after ?? -1)),
    )
    .post(
      customMethod(path, 'review'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        headers,
        body: t.Object(
          {
            ordinal,
            subjectId: t.Optional(id),
            skip: t.Optional(t.Boolean()),
            fields: t.Array(t.String({ maxLength: 100 }), { maxItems: 30, uniqueItems: true }),
            replace: t.Optional(t.Boolean()),
          },
          closed,
        ),
        response: {
          200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createAniListImport>['review']>>>(
            t.Object({}, { additionalProperties: true }),
          ),
          ...failures,
        },
        detail: detail('review'),
      },
      ({ actor, params, body, headers }) => {
        const { ordinal, ...input } = body;
        return command(() =>
          imports().review(actor, params.importId, ordinal, input, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
        );
      },
    )
    .post(
      customMethod(path, 'apply'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        body: t.Object(
          { confirmations: t.Array(t.Object({ ordinal, reviewId: id }, closed), { minItems: 1, maxItems: 20 }) },
          closed,
        ),
        response: {
          200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createAniListImport>['apply']>>>(
            t.Object({}, { additionalProperties: true }),
          ),
          ...failures,
        },
        detail: detail('apply'),
      },
      ({ actor, params, body, request }) =>
        command(() => imports().apply(actor, params.importId, body.confirmations, request.signal)),
    )
    .post(
      customMethod(path, 'reviewLabels'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        headers,
        body: t.Object(
          {
            ordinal,
            subjectId: t.Optional(id),
            selections: t.Array(
              t.Object(
                {
                  key: t.String({ minLength: 1, maxLength: 4096 }),
                  target: t.Union([
                    t.Object({ labelId: id }, closed),
                    t.Object({ name: t.String({ minLength: 1, maxLength: 4096 }) }, closed),
                  ]),
                },
                closed,
              ),
              { minItems: 1, maxItems: ANILIST_LABEL_LIMITS.selected },
            ),
          },
          closed,
        ),
        response: {
          200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createAniListImport>['reviewLabels']>>>(
            t.Object({}, { additionalProperties: true }),
          ),
          ...failures,
        },
        detail: detail('review_labels'),
      },
      ({ actor, params, body, headers }) => {
        const { ordinal, ...input } = body;
        return command(() =>
          imports().reviewLabels(actor, params.importId, ordinal, input, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
        );
      },
    )
    .post(
      customMethod(path, 'applyLabels'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        body: t.Object(
          {
            confirmations: t.Array(t.Object({ ordinal, reviewId: id }, closed), {
              minItems: 1,
              maxItems: ANILIST_LABEL_LIMITS.rows,
            }),
          },
          closed,
        ),
        response: {
          200: t.Unsafe<Awaited<ReturnType<ReturnType<typeof createAniListImport>['applyLabels']>>>(
            t.Object({}, { additionalProperties: true }),
          ),
          ...failures,
        },
        detail: detail('apply_labels'),
      },
      ({ actor, params, body, request }) =>
        command(() => imports().applyLabels(actor, params.importId, body.confirmations, request.signal)),
    )
    .post(
      customMethod(path, 'cancel'),
      {
        beforeHandle: ({ set }) => {
          set.headers['Cache-Control'] = 'private, no-store';
        },
        params,
        headers,
        body: t.Object({ remove: t.Optional(t.Boolean()) }, closed),
        response: { 200: t.Object({ cancelled: t.Boolean() }, closed), ...failures },
        detail: detail('cancel'),
      },
      ({ actor, params, body, headers }) =>
        command(() =>
          imports().cancel(actor, params.importId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]), body.remove),
        ),
    );
}
