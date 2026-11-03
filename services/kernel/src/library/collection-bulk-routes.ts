import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import { IdempotencyConflictError } from '../command/command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { CollectionBulkSelectionTooLarge } from './collection-bulk-store.ts';
import { CollectionBulkSourcePreparingError } from './collection-bulk-capture.ts';
import { strict } from './collection-routes.ts';
import { BULK_ADMISSION_BODY_BYTES } from './bulk-limits.ts';
import {
  bulkPreviewSchema,
  bulkCancelSchema,
  bulkOperationResultSchema,
  bulkOutcomePageSchema,
  bulkOutcomeQuerySchema,
} from './bulk-schemas.ts';
import { createCollectionBulkOperations, type CollectionBulkDependencies } from './collection-bulk-operation.ts';

type Dependencies = Omit<CollectionBulkDependencies, 'access'> & { access: () => Access };
const params = t.Object({ operationId: t.String({ format: 'uuid' }) });
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  403: problemSchema('forbidden', 'platform_closed'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('dependency_unavailable'),
};
function detail(operationId: string, write = false) {
  return {
    operationId,
    'x-action': write ? 'library_entry:update' : 'library_entry:list',
    'x-exposure': 'gate:personal_library',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    'x-body-limit': BULK_ADMISSION_BODY_BYTES,
    ...(write ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}
async function mapped<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ProblemError) throw error;
    if (error instanceof CollectionBulkSelectionTooLarge)
      throw new ProblemError('content_too_large', { detail: error.message });
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
    if (error instanceof IdempotencyConflictError) throw new ProblemError('idempotency_conflict');
    if (error instanceof TypeError || error instanceof RangeError) throw new ProblemError('invalid_request');
    throw error;
  }
}

/** Ordinary mounted typed routes. GETs never confirm or wake personal effects. */
export function collectionBulkRoutes(app: ReturnType<typeof definitionRoutes>, deps: Dependencies) {
  const operations = () => createCollectionBulkOperations({ ...deps, access: deps.access() });
  return app
    .post(
      '/v1/libraryOperations',
      {
        headers,
        body: strict(bulkPreviewSchema),
        response: {
          201: strict(bulkOperationResultSchema),
          202: strict(t.Object({ preparing: t.Literal(true) }, { additionalProperties: false })),
          ...failures,
        },
        detail: detail('library_operation.preview', true),
      },
      async ({ actor, body, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        try {
          const result = await admission.run('normal', job, () =>
            mapped(() => operations().preview(actor, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]))),
          );
          session.record(result);
          set.status = 201;
          return { operation: result.value.operation };
        } catch (error) {
          if (!(error instanceof CollectionBulkSourcePreparingError)) throw error;
          set.status = 202;
          return { preparing: true as const };
        }
      },
    )
    .get(
      '/v1/libraryOperations/:operationId',
      {
        params,
        response: { 200: strict(bulkOperationResultSchema), ...failures },
        detail: detail('library_operation.get'),
      },
      async ({ actor, params, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () => mapped(() => operations().get(actor, params.operationId)));
      },
    )
    .get(
      '/v1/libraryOperations/:operationId/outcomes',
      {
        params,
        query: bulkOutcomeQuerySchema,
        response: { 200: strict(bulkOutcomePageSchema), ...failures },
        detail: detail('library_operation.outcomes'),
      },
      async ({ actor, params, query, admission, job, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, () =>
          mapped(() => operations().outcomes(actor, params.operationId, query)),
        );
      },
    )
    .post(
      customMethod('/v1/libraryOperations/:operationId', 'confirm'),
      {
        params,
        headers,
        body: strict(bulkCancelSchema),
        response: { 200: strict(bulkOperationResultSchema), ...failures },
        detail: detail('library_operation.confirm', true),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const result = await admission.run('normal', job, () =>
          mapped(() => operations().confirm(actor, params.operationId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]))),
        );
        session.record(result);
        return result.value;
      },
    )
    .post(
      customMethod('/v1/libraryOperations/:operationId', 'cancel'),
      {
        params,
        headers,
        body: strict(bulkCancelSchema),
        response: { 200: strict(bulkOperationResultSchema), ...failures },
        detail: detail('library_operation.cancel', true),
      },
      async ({ actor, params, headers, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const result = await admission.run('normal', job, () =>
          mapped(() => operations().cancel(actor, params.operationId, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]))),
        );
        session.record(result);
        return result.value;
      },
    );
}
