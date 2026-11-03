import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import { ModerationDecisionSchema, readModerationDecision } from './moderation-decisions.ts';
import {
  listModerationHistory,
  ModerationHistoryPageSchema,
  ModerationHistoryQuerySchema,
} from './moderation-history.ts';
import { erasePost, takedown } from './moderation.ts';
import type { ModerationDependencies } from './moderation.ts';
import { beginAuthorErasure, postEraseReceiptAccess, readOperation } from './operations.ts';
import type { AuthorErasureDependencies, Operation } from './operation-contract.ts';
import type { reportRoutes } from './report-routes.ts';
import type { ContentRuntime } from './runtime.ts';
import {
  AuthorErasureInputSchema,
  ModerationReasonSchema,
  ModerationResponseSchema,
  OperationSchema,
  strictContentSchema,
} from './schemas.ts';

const params = t.Object({ id: t.String() }, { additionalProperties: false });
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const sessionHeader = { [SESSION_HEADER]: t.String() };
const reason = strictContentSchema(ModerationReasonSchema);
const response = strictContentSchema(ModerationResponseSchema);
const operation = strictContentSchema(OperationSchema);
const readFailures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'dependency_unavailable'),
};
const historyReadFailures = { ...readFailures, 400: problemSchema('invalid_request', 'invalid_cursor') };
const writeFailures = {
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
};
const writeRate = defineRateLimit({ family: 'write', units: 1 });
function detail(operationId: string, action: 'moderation:takedown' | 'post:erase', type: 'board' | 'thread' | 'post') {
  return {
    operationId,
    'x-resource-types': [`content.${type}`],
    'x-exposure': 'public' as const,
    'x-action': action,
    'x-rate-limit': writeRate,
    ...(action === 'post:erase' ? { 'x-replay-authorization': 'self-account-read' as const } : {}),
    security: [{ bearerAuth: [] }],
  };
}
function context(request: Request, deadline: number) {
  return {
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    deadline,
    requestId: Bun.randomUUIDv7(),
  };
}
async function command<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof RangeError) throw new ProblemError('invalid_request');
    throw error;
  }
}

/** Transport only: exact point commands own authorization before receipt replay;
 * author-scope initiation commits an operation for the native outbox relay.
 */
export function moderationRoutes(app: ReturnType<typeof reportRoutes>, deps: ModerationDependencies & ContentRuntime) {
  const operations: AuthorErasureDependencies = {
    pool: deps.pool,
    get access() {
      return deps.access;
    },
    clock: deps.clock ?? (() => new Date()),
    get workflows() {
      // An unstarted operation needs only its native identity row. A status
      // lookup requiring a workflow adapter fails closed if not composed.
      if (!deps.workflows) throw new ProblemError('dependency_unavailable');
      return deps.workflows;
    },
  };
  const oversized = new WeakSet<Request>();
  const parse = [
    async ({ request, contentType }: { request: Request; contentType: string }) => {
      if (contentType !== 'application/json' || !request.body) throw new ProblemError('invalid_request');
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8192) {
            await reader.cancel();
            oversized.add(request);
            return {};
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    },
    'json' as const,
  ];
  const pointOptions = {
    params,
    headers,
    body: reason,
    parse,
    transform: ({ request }: { request: Request }) => {
      if (oversized.delete(request)) throw new ProblemError('content_too_large');
    },
    response: { 200: withHeaders(response, sessionHeader), ...writeFailures },
  };
  return app
    .get(
      '/v1/moderation-decisions/:id',
      {
        params,
        response: {
          200: withHeaders(ModerationDecisionSchema, { ...sessionHeader, 'cache-control': t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'moderation_decision.get',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () => {
          const result = await readModerationDecision(deps, id, { actor, deadline: job.deadline });
          if (!result || !result.value) throw new ProblemError('not_found');
          session.record(result.anchor);
          return result.value;
        });
      },
    )
    .get(
      '/v1/boards/:id/moderation-history',
      {
        params,
        query: ModerationHistoryQuerySchema,
        response: {
          200: withHeaders(strictContentSchema(ModerationHistoryPageSchema), {
            ...sessionHeader,
            'cache-control': t.String(),
          }),
          ...historyReadFailures,
        },
        detail: {
          operationId: 'board.moderation_history.list',
          'x-resource-types': ['content.board'],
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, query, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () => {
          const result = await listModerationHistory(deps, id, { actor, deadline: job.deadline }, query);
          session.record(result.anchor);
          return result.value;
        });
      },
    )
    .post(
      customMethod('/v1/boards/:id', 'takeDown'),
      { ...pointOptions, detail: detail('board.takedown', 'moderation:takedown', 'board') },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return command(() =>
          admission.run('normal', job, async () => {
            const result = await takedown(
              deps,
              actor,
              { target: { kind: 'board', id }, reason: body.reason },
              context(request, job.deadline),
            );
            session.record(result);
            return { securityRevision: result.value.securityRevision };
          }),
        );
      },
    )
    .post(
      customMethod('/v1/threads/:id', 'takeDown'),
      { ...pointOptions, detail: detail('thread.takedown', 'moderation:takedown', 'thread') },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return command(() =>
          admission.run('normal', job, async () => {
            const result = await takedown(
              deps,
              actor,
              { target: { kind: 'thread', id }, reason: body.reason },
              context(request, job.deadline),
            );
            session.record(result);
            return { securityRevision: result.value.securityRevision };
          }),
        );
      },
    )
    .post(
      customMethod('/v1/posts/:id', 'takeDown'),
      { ...pointOptions, detail: detail('post.takedown', 'moderation:takedown', 'post') },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return command(() =>
          admission.run('normal', job, async () => {
            const result = await takedown(
              deps,
              actor,
              { target: { kind: 'post', id }, reason: body.reason },
              context(request, job.deadline),
            );
            session.record(result);
            return { securityRevision: result.value.securityRevision };
          }),
        );
      },
    )
    .post(
      customMethod('/v1/posts/:id', 'erase'),
      { ...pointOptions, detail: detail('post.erase_point', 'post:erase', 'post') },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return command(() =>
          admission.run('normal', job, async () => {
            const result = await erasePost(
              { ...deps, access: postEraseReceiptAccess(deps.access) },
              actor,
              { postId: id, reason: body.reason },
              context(request, job.deadline),
            );
            session.record(result);
            return { securityRevision: result.value.securityRevision };
          }),
        );
      },
    )
    .post(
      customMethod('/v1/threads/:id', 'erase'),
      {
        ...pointOptions,
        body: strictContentSchema(AuthorErasureInputSchema),
        response: { 202: withHeaders(operation, sessionHeader), ...writeFailures },
        detail: detail('thread.erase', 'post:erase', 'thread'),
      },
      async ({ params: { id }, actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return command(() =>
          admission.run('normal', job, async () => {
            const result = await beginAuthorErasure(
              operations,
              actor,
              { threadId: id, authorId: body.authorId },
              context(request, job.deadline),
            );
            session.record(result);
            set.status = 202;
            // The command committed this bounded initial identity, not a worker
            // run. Progress is read separately through the own-account gate.
            return {
              name: `operations/${result.value.operationId}`,
              done: false,
              metadata: {
                type: 'content.author_erasure',
                threadId: id,
                authorId: body.authorId,
                processedPosts: 0,
                erasedRevisions: 0,
                steps: 0,
              },
            } satisfies Operation;
          }),
        );
      },
    )
    .get(
      '/v1/operations/:id',
      {
        params,
        response: { 200: operation, ...readFailures },
        detail: {
          operationId: 'operation.get',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job }) =>
        admission.run('normal', job, async () => {
          const current = await readOperation(operations, actor, id, { deadline: job.deadline });
          if (!current) throw new ProblemError('not_found');
          return current;
        }),
    );
}
