import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import type { mediaModerationRoutes } from './media-moderation-routes.ts';
import type { ContentCommandDependencies } from './commands.ts';
import {
  importMediaFromUrl,
  MediaImportConflictError,
  readMediaImportStatus,
  type MediaImportDependencies,
  type MediaImportFetchConfig,
} from './media-import.ts';
import { MediaImportInputSchema, MediaImportReceiptSchema, MediaImportPollSchema } from './schemas.ts';

/** Supplied by trusted runtime composition. Missing configuration fails closed. */
export type MediaImportRouteDependencies = ContentCommandDependencies & { fetchConfig?: MediaImportFetchConfig };
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
  ),
};
const security = [{ bearerAuth: [] }];
const uploadRate = defineRateLimit({ family: 'upload', units: 1 });

async function importOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof MediaImportConflictError) throw new ProblemError('conflict');
    if (
      error instanceof TypeError &&
      [
        'Invalid media import request',
        'Invalid source URL',
        'Invalid placement subject',
        'Invalid media request identifier',
      ].includes(error.message)
    )
      throw new ProblemError('invalid_request');
    throw error;
  }
}

export function mediaImportRoutes(
  app: ReturnType<typeof mediaModerationRoutes>,
  dependencies: MediaImportRouteDependencies,
) {
  function configured(): MediaImportDependencies {
    if (!dependencies.fetchConfig) throw new ProblemError('dependency_unavailable');
    return {
      pool: dependencies.pool,
      access: dependencies.access,
      routeKey: dependencies.routeKey,
      clock: dependencies.clock ?? (() => new Date()),
      fetchConfig: dependencies.fetchConfig,
    };
  }
  return app
    .post(
      customMethod('/v1/media', 'importFromUrl'),
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
        body: MediaImportInputSchema,
        response: {
          202: withHeaders(MediaImportReceiptSchema, { [SESSION_HEADER]: t.String() }),
          ...failures,
          403: problemSchema('forbidden'),
          409: problemSchema('conflict'),
          422: problemSchema('idempotency_conflict', 'too_many_events'),
          429: problemSchema('rate_limited'),
          503: problemSchema(
            'overloaded',
            'deadline_exceeded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'dependency_unavailable',
            'rate_limit_unavailable',
          ),
        },
        detail: {
          operationId: 'media.import_from_url',
          'x-exposure': 'public',
          'x-action': 'media:import_from_url',
          'x-resource-types': ['content.media'],
          'x-rate-limit': uploadRate,
          security,
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = {
          deadline: job.deadline,
          idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
          requestId: Bun.randomUUIDv7(),
        };
        return importOperation(() =>
          admission.run('normal', job, async () => {
            const deps = configured();
            const outcome = await importMediaFromUrl(deps, actor, body, context);
            // Receipts contain IDs only. Resolve current disclosure on every return,
            // including replay, before publishing either the identity or session token.
            const current = await readMediaImportStatus(deps, actor, outcome.value.mediaId, { deadline: job.deadline });
            if (!current) throw new ProblemError('not_found');
            session.record(outcome);
            set.status = 202;
            return {
              media: {
                id: current.media.id,
                containerId: current.media.containerId,
                purpose: 'cover' as const,
                state: 'reserved' as const,
              },
            };
          }),
        );
      },
    )
    .get(
      customMethod('/v1/media/:id', 'importStatus'),
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        response: { 200: MediaImportPollSchema, ...failures },
        detail: {
          operationId: 'media.import_status',
          'x-exposure': 'public',
          'x-action': 'media:read_reservation',
          security,
        },
      },
      async ({ actor, params, admission, job }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return admission.run('normal', job, async () => {
          const current = await readMediaImportStatus(configured(), actor, params.id, { deadline: job.deadline });
          if (!current) throw new ProblemError('not_found');
          return current;
        });
      },
    );
}
