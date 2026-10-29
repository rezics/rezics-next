import { withHeaders } from '@elysia/openapi';
import { status, t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '../http/request.ts';
import { routeOf } from '../route/route.ts';
import type { documentRoutes } from './document-routes.ts';
import { ContentForbiddenError, ContentNotFoundError as CommandNotFoundError } from './commands.ts';
import type { AnchoredPosition } from './model.ts';
import { ContentNotFoundError as ReadNotFoundError } from './reads.ts';
import { dismissReport, ReportResolvedError } from './report-outcomes.ts';
import { parseReportBody, reportRequestContext, requireReportInspection } from './report-admission.ts';
import {
  createReport,
  listTargetReports,
  readReport,
  ReportProofRequiredError,
  ReportProofUnavailableError,
  ReportUnavailableError,
  type ReportDependencies,
  type ReportTarget,
} from './reports.ts';
import {
  ContentPageQuerySchema,
  ReportReceiptSchema,
  ReportInputSchema,
  ReportPageResponseSchema,
  ReportResponseSchema,
  strictContentSchema,
} from './schemas.ts';

export type ReportRouteDependencies = ReportDependencies;
const params = t.Object({ id: t.String() }, { additionalProperties: false });
const privateHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
const readFailures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  409: problemSchema('stale_cursor'),
  500: problemSchema('internal_error'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
    'rate_limit_unavailable',
  ),
};
const writeFailures = {
  ...readFailures,
  403: problemSchema('forbidden'),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
  429: problemSchema('rate_limited'),
};

function existingId(id: string): void {
  if (routeOf(id) === null) throw new ProblemError('not_found');
}

function component(anchor: AnchoredPosition) {
  return { partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position };
}

async function reportOperation<T>(operation: () => Promise<T>, inspection = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ReportProofRequiredError) throw new ProblemError('forbidden');
    if (error instanceof ReportProofUnavailableError)
      throw new ProblemError('dependency_unavailable', { headers: { 'retry-after': '1' } });
    if (error instanceof ReportResolvedError) throw new ProblemError('conflict');
    if (error instanceof ReportUnavailableError) throw new ProblemError('not_found');
    if (error instanceof GrantDeniedError) throw new ProblemError(inspection ? 'not_found' : 'forbidden');
    if (error instanceof CommandNotFoundError || error instanceof ReadNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError) throw new ProblemError(inspection ? 'not_found' : 'forbidden');
    if (error instanceof Error && error.name === 'UnfinishedPortError')
      throw new ProblemError('dependency_unavailable');
    throw error;
  }
}

/** HTTP delegates disclosure, the one authorization formula and receipts to the
 * real report adapter. The shared request stage alone owns network attribution
 * and budget charging. No handler may spend again or verify a one-use proof.
 */
export function reportRoutes(app: ReturnType<typeof documentRoutes>, dependencies: ReportRouteDependencies) {
  const oversized = new WeakSet<Request>();
  const created = app
    .post(
      customMethod('/v1/reports/:id', 'dismiss'),
      {
        params,
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
        response: {
          200: withHeaders(
            t.Object({ reportId: t.String(), outcome: t.Literal('dismissed') }, { additionalProperties: false }),
            privateHeaders,
          ),
          ...writeFailures,
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'report.dismiss',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        existingId(id);
        return reportOperation(
          () =>
            admission.run('normal', job, async () => {
              const result = await dismissReport(
                dependencies,
                actor,
                id,
                reportRequestContext(actor, request, job.deadline, undefined),
              );
              session.record(result);
              return result.value;
            }),
          true,
        );
      },
    )
    .post(
      '/v1/reports',
      {
        parse: [(context) => parseReportBody(context, oversized), 'json'],
        transform: ({ request }) => {
          if (oversized.delete(request)) throw new ProblemError('content_too_large');
        },
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
        body: strictContentSchema(ReportInputSchema),
        response: {
          201: withHeaders(strictContentSchema(ReportReceiptSchema), { ...privateHeaders, location: t.String() }),
          ...writeFailures,
        },
        detail: {
          operationId: 'report.create',
          'x-exposure': 'public',
          'x-action': 'report:create',
          'x-rate-limit': defineRateLimit({ family: 'report', units: 1 }),
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        // Keep this credential separate from semantic input. createReport verifies
        // it once, before runCommand and before receipt disclosure.
        set.headers['cache-control'] = 'private, no-store';
        const { botToken, ...input } = body;
        const context = reportRequestContext(actor, request, job.deadline, botToken);
        return reportOperation(
          () =>
            admission.run('normal', job, async () => {
              const result = await createReport(dependencies, actor, input, context);
              session.record(result);
              set.headers.location = `/v1/reports/${result.value.reportId}`;
              return status(201, { reportId: result.value.reportId });
            }),
          actor.kind === 'anonymous',
        );
      },
    )
    .get(
      '/v1/reports/:id',
      {
        params,
        response: { 200: withHeaders(strictContentSchema(ReportResponseSchema), privateHeaders), ...readFailures },
        detail: {
          operationId: 'report.get',
          'x-exposure': 'public',
          'x-action': 'moderation:read_reports',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        existingId(id);
        return reportOperation(
          () =>
            admission.run('normal', job, async () => {
              const result = await readReport(dependencies, id, { actor, deadline: job.deadline });
              if (!result.value) throw new ProblemError('not_found');
              session.record(component(result.anchor));
              return { report: result.value };
            }),
          true,
        );
      },
    );

  // Literal mounts preserve every target-specific Eden path. Each adapter call
  // owns its independent target anchor and per-report partition fills.
  const listOptions = {
    params,
    query: ContentPageQuerySchema,
    response: { 200: withHeaders(strictContentSchema(ReportPageResponseSchema), privateHeaders), ...readFailures },
  };
  const board = created.get(
    '/v1/boards/:id/reports',
    {
      ...listOptions,
      detail: {
        operationId: 'board.reports',
        'x-exposure': 'public',
        'x-action': 'moderation:read_reports',
        security: [{ bearerAuth: [] }],
      },
    },
    ({ params: { id }, query, actor, admission, job, session, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      return list(
        { kind: 'board', id },
        { actor, deadline: job.deadline },
        query,
        (operation) => admission.run('normal', job, operation),
        session,
      );
    },
  );
  const thread = board.get(
    '/v1/threads/:id/reports',
    {
      ...listOptions,
      detail: {
        operationId: 'thread.reports',
        'x-exposure': 'public',
        'x-action': 'moderation:read_reports',
        security: [{ bearerAuth: [] }],
      },
    },
    ({ params: { id }, query, actor, admission, job, session, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      return list(
        { kind: 'thread', id },
        { actor, deadline: job.deadline },
        query,
        (operation) => admission.run('normal', job, operation),
        session,
      );
    },
  );
  return thread.get(
    '/v1/posts/:id/reports',
    {
      ...listOptions,
      detail: {
        operationId: 'post.reports',
        'x-exposure': 'public',
        'x-action': 'moderation:read_reports',
        security: [{ bearerAuth: [] }],
      },
    },
    ({ params: { id }, query, actor, admission, job, session, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      return list(
        { kind: 'post', id },
        { actor, deadline: job.deadline },
        query,
        (operation) => admission.run('normal', job, operation),
        session,
      );
    },
  );

  function list(
    target: ReportTarget,
    context: Parameters<typeof listTargetReports>[2],
    query: { cursor?: string; limit?: number },
    admit: <T>(operation: () => Promise<T>) => Promise<T>,
    session: { record: (value: ReturnType<typeof component>) => void },
  ) {
    existingId(target.id);
    return reportOperation(
      () =>
        admit(async () => {
          await requireReportInspection(dependencies, target.id, context);
          let page;
          try {
            page = await listTargetReports(dependencies, target, context, query.cursor, query.limit ?? 20);
          } catch (error) {
            if (query.cursor !== undefined && error instanceof TypeError) throw new ProblemError('invalid_cursor');
            throw error;
          }
          await requireReportInspection(dependencies, target.id, context);
          session.record(component(page.anchor));
          return { reports: [...page.entries], next: page.nextCursor };
        }),
      true,
    );
  }
}
