import { contentRequestId } from './adapters/bind.ts';
import { memoizedValue } from '../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import { strictContentSchema } from './schemas.ts';
import { takedownSourceFence, type SourceFenceDependencies } from './source-fence-command.ts';
import type { sourceFenceRoutes } from './source-fence-routes.ts';

function body() {
  return memoizedValue(body, () =>
    strictContentSchema(
      t.Object(
        {
          source: t.String({ minLength: 1, maxLength: 32, pattern: '^[a-z][a-z0-9_-]{0,31}$' }),
          externalId: t.String({ minLength: 1, maxLength: 1024 }),
          fieldGroup: t.Union([t.Literal('facts'), t.Literal('summary'), t.Literal('cover')]),
          reason: t.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
    ),
  );
}
function response() {
  return memoizedValue(response, () =>
    strictContentSchema(
      t.Object(
        {
          securityRevision: t.String({ pattern: '^[1-9][0-9]*$' }),
        },
        { additionalProperties: false },
      ),
    ),
  );
}
function writeRate() {
  return memoizedValue(writeRate, () => defineRateLimit({ family: 'write', units: 1 }));
}

export function sourceFenceGovernanceRoutes(app: ReturnType<typeof sourceFenceRoutes>, deps: SourceFenceDependencies) {
  const oversized = new WeakSet<Request>();
  app.wrap((handle) => async (request) => {
    const result = await handle(request);
    const path = new URL(request.url).pathname;
    if (path === '/v1/sourceFences:takedown' || /^\/v1\/sourceFences\/(?:\$|%24)takedown$/i.test(path))
      result.headers.set('cache-control', 'private, no-store');
    return result;
  });
  return app.post(
    customMethod('/v1/sourceFences', 'takedown'),
    {
      // The largest valid escaped JSON envelope fits within this fixed byte cap.
      parse: [
        async ({ request, contentType }) => {
          if (contentType !== 'application/json' || !request.body) throw new ProblemError('invalid_request');
          const reader = request.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > 16384) {
                await reader.cancel();
                oversized.add(request);
                return {};
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        },
        'json',
      ],
      transform: ({ request }) => {
        if (oversized.delete(request)) throw new ProblemError('content_too_large');
      },
      headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
      body: body(),
      response: {
        200: withHeaders(response(), { [SESSION_HEADER]: t.String(), 'cache-control': t.String() }),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden'),
        404: problemSchema('not_found'),
        413: problemSchema('content_too_large'),
        422: problemSchema('idempotency_conflict', 'too_many_events'),
        429: problemSchema('rate_limited'),
        500: problemSchema('internal_error'),
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
        operationId: 'source_fence.takedown',
        'x-exposure': 'public',
        'x-action': 'source_fence:takedown',
        'x-rate-limit': writeRate(),
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, body, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const context = {
        idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
        deadline: job.deadline,
        requestId: contentRequestId(),
      };
      try {
        const result = await admission.run('normal', job, () =>
          takedownSourceFence(
            deps,
            actor,
            {
              source: body.source,
              external_id: body.externalId,
              field_group: body.fieldGroup,
              reason: body.reason,
            },
            context,
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      } catch (error) {
        if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
        if (error instanceof RangeError) throw new ProblemError('invalid_request');
        throw error;
      }
    },
  );
}
