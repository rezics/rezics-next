import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { MAX_DOCUMENT_BYTES } from './document.ts';
import type { documentRoutes } from './document-routes.ts';
import { createReport, readReport, ReportUnavailableError, type ReportDependencies } from './reports.ts';
import { ReportInputSchema, ReportReceiptSchema, ReportResponseSchema, strictContentSchema } from './schemas.ts';

const readFailures = {
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
const privateHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };

/** Account transport only. Anonymous front admission is composed separately. */
export function reportRoutes(app: ReturnType<typeof documentRoutes>, dependencies: ReportDependencies) {
  const oversized = new WeakSet<Request>();
  app.onTransform(({ request }) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST' && path === '/v1/reports' && !request.headers.has('authorization'))
      throw new AuthenticationError(401, 'Bearer');
  });
  return app
    .post(
      '/v1/reports',
      {
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
                if (length > MAX_DOCUMENT_BYTES) {
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
        body: strictContentSchema(ReportInputSchema),
        response: {
          201: withHeaders(strictContentSchema(ReportReceiptSchema), { ...privateHeaders, location: t.String() }),
          ...readFailures,
          403: problemSchema('forbidden'),
          413: problemSchema('content_too_large'),
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
          operationId: 'report.create',
          'x-exposure': 'public',
          'x-action': 'report:create',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const { botToken, ...input } = body;
        try {
          const result = await admission.run('normal', job, () =>
            createReport(dependencies, actor, input, {
              idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
              deadline: job.deadline,
              requestId: Bun.randomUUIDv7(),
              ...(botToken === undefined ? {} : { botToken }),
            }),
          );
          session.record(result);
          set.status = 201;
          set.headers.location = `/v1/reports/${result.value.reportId}`;
          set.headers['cache-control'] = 'private, no-store';
          return result.value;
        } catch (error) {
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          if (error instanceof ReportUnavailableError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .get(
      '/v1/reports/:reportId',
      {
        params: t.Object({ reportId: t.String() }, { additionalProperties: false }),
        response: { 200: withHeaders(strictContentSchema(ReportResponseSchema), privateHeaders), ...readFailures },
        detail: {
          operationId: 'report.get',
          'x-exposure': 'public',
          'x-action': 'moderation:read_reports',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { reportId }, actor, admission, job, session, set }) => {
        if (routeOf(reportId) === null) throw new ProblemError('not_found');
        const result = await admission.run('normal', job, () =>
          readReport(dependencies, reportId, { actor, deadline: job.deadline }),
        );
        if (!result.value) throw new ProblemError('not_found');
        session.record({
          partition: result.anchor.partition.partitionNo,
          epoch: result.anchor.epoch,
          position: result.anchor.position,
        });
        set.headers['cache-control'] = 'private, no-store';
        return { report: result.value };
      },
    );
}
