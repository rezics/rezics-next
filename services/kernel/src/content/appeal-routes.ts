import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, SESSION_HEADER, idempotencyKeyOf } from '../http/request.ts';
import type { moderationRoutes } from './moderation-routes.ts';
import { createAppeal, resolveAppeal, listAppeals, type AppealDependencies } from './appeals.ts';
import { ContentPageQuerySchema, strictContentSchema } from './schemas.ts';

const params = t.Object({ id: t.String() }, { additionalProperties: false });
const statement = t.String({ minLength: 1, maxLength: 2000 });
const receipt = t.Object({ id: t.String() }, { additionalProperties: false });
const privateHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
const listQuerySchema = t.Object(
  {
    ...ContentPageQuerySchema.properties,
    inspect: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  },
  { additionalProperties: false },
);
const sourceSchema = t.Object(
  { partition: t.Integer(), epoch: t.Integer(), position: t.String({ pattern: '^(0|[1-9][0-9]*)$' }) },
  { additionalProperties: false },
);
const appellantIdentitySchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      kind: t.Union([t.Literal('actor'), t.Literal('organization')]),
      handle: t.Union([t.String(), t.Null()]),
      displayName: t.Union([t.String(), t.Null()]),
      automated: t.Boolean(),
    },
    { additionalProperties: false },
  ),
  ...(['deleted', 'concealed', 'unavailable'] as const).map((state) =>
    t.Object({ state: t.Literal(state) }, { additionalProperties: false }),
  ),
]);
const targetContextSchema = t.Union([
  t.Object(
    {
      state: t.Literal('available'),
      destination: t.Union([
        t.Object({ kind: t.Literal('board'), id: t.String() }, { additionalProperties: false }),
        t.Object({ kind: t.Literal('thread'), id: t.String(), boardId: t.String() }, { additionalProperties: false }),
      ]),
    },
    { additionalProperties: false },
  ),
  ...(['concealed', 'unavailable'] as const).map((state) =>
    t.Object({ state: t.Literal(state) }, { additionalProperties: false }),
  ),
]);
const appealReviewProperties = {
  id: t.String(),
  decisionId: t.String(),
  appellantId: t.String(),
  appellantIdentity: appellantIdentitySchema,
  statement: t.String(),
  createdAt: t.String({ format: 'date-time' }),
  decision: t.Object(
    {
      statement: t.String(),
      target: t.Object(
        {
          kind: t.Union([t.Literal('board'), t.Literal('thread'), t.Literal('post')]),
          id: t.String(),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  targetContext: targetContextSchema,
  canResolve: t.Boolean(),
  resolutionCommand: t.Object(
    {
      operationId: t.Literal('moderation_appeal.resolve'),
      method: t.Literal('POST'),
      path: t.String(),
    },
    { additionalProperties: false },
  ),
  source: sourceSchema,
};
const appealReviewSchema = t.Object(appealReviewProperties, { additionalProperties: false });
const selectedAppealSchema = t.Object(
  {
    ...appealReviewProperties,
    resolution: t.Union([
      t.Object(
        {
          outcome: t.Union([t.Literal('upheld'), t.Literal('reversed')]),
          statement: t.String(),
          resolvedAt: t.String({ format: 'date-time' }),
        },
        { additionalProperties: false },
      ),
      t.Null(),
    ]),
  },
  { additionalProperties: false },
);
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
const writeOptions = {
  params,
  transform: ({ body }: { body: unknown }) => {
    if (typeof body !== 'object' || body === null || !('statement' in body) || typeof body.statement !== 'string')
      return;
    const length = Array.from(body.statement).length;
    if (length < 1 || length > 2000 || !body.statement.isWellFormed())
      throw new ProblemError('unsupported_query', { detail: 'Statements must contain 1 to 2,000 characters.' });
  },
  headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
};
const writeFailures = {
  ...readFailures,
  403: problemSchema('forbidden'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict', 'too_many_events', 'unsupported_query'),
  429: problemSchema('rate_limited'),
};
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const context = (request: Request, deadline: number) => ({
  deadline,
  idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
  requestId: Bun.randomUUIDv7(),
});
async function operation<T>(work: () => Promise<T>, denied: 'not_found' | 'forbidden' = 'not_found') {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GrantDeniedError) throw new ProblemError(denied);
    throw error;
  }
}

export function appealRoutes(app: ReturnType<typeof moderationRoutes>, deps: AppealDependencies) {
  const writes = app
    .post(
      customMethod('/v1/moderation-decisions/:id', 'appeal'),
      {
        ...writeOptions,
        body: strictContentSchema(t.Object({ statement }, { additionalProperties: false })),
        response: { 201: withHeaders(receipt, privateHeaders), ...writeFailures },
        detail: {
          operationId: 'moderation_decision.appeal',
          'x-exposure': 'public',
          'x-action': 'account:read',
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      ({ params: { id }, actor, body, request, admission, job, session, set }) =>
        operation(() =>
          admission.run('normal', job, async () => {
            const result = await createAppeal(deps, actor, id, body.statement, context(request, job.deadline));
            session.record(result);
            set.status = 201;
            set.headers['cache-control'] = 'private, no-store';
            return result.value;
          }),
        ),
    )
    .post(
      customMethod('/v1/moderation-appeals/:id', 'resolve'),
      {
        ...writeOptions,
        body: strictContentSchema(
          t.Object(
            { outcome: t.Union([t.Literal('uphold'), t.Literal('reverse')]), statement },
            { additionalProperties: false },
          ),
        ),
        response: { 200: withHeaders(receipt, privateHeaders), ...writeFailures },
        detail: {
          operationId: 'moderation_appeal.resolve',
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      ({ params: { id }, actor, body, request, admission, job, session, set }) =>
        operation(
          () =>
            admission.run('normal', job, async () => {
              const result = await resolveAppeal(deps, actor, id, body, context(request, job.deadline));
              session.record(result);
              set.headers['cache-control'] = 'private, no-store';
              return result.value;
            }),
          'forbidden',
        ),
    );
  const listOptions = {
    params,
    query: listQuerySchema,
    response: {
      200: withHeaders(
        t.Object(
          {
            appeals: t.Array(appealReviewSchema, { maxItems: 100 }),
            next: t.Union([t.String(), t.Null()]),
            selectedAppeal: t.Optional(selectedAppealSchema),
            provenance: t.Object(
              {
                actorId: t.String(),
                session: t.Object({ clientId: t.String(), authnEpoch: t.Integer() }, { additionalProperties: false }),
                source: sourceSchema,
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
        privateHeaders,
      ),
      ...readFailures,
    },
  };
  const board = writes.get(
    '/v1/boards/:id/appeals',
    {
      ...listOptions,
      detail: {
        operationId: 'board.appeals',
        'x-exposure': 'public',
        'x-action': 'moderation:read_reports',
        security: [{ bearerAuth: [] }],
      },
    },
    ({ params: { id }, actor, query, admission, job, session, set }) =>
      operation(() =>
        admission.run('normal', job, async () => {
          const result = await listAppeals(deps, { kind: 'board', id }, { actor, deadline: job.deadline }, query);
          session.record(result.anchor);
          if (result.selectedAnchor) session.record(result.selectedAnchor);
          set.headers['cache-control'] = 'private, no-store';
          return result.value;
        }),
      ),
  );
  return board.get(
    '/v1/threads/:id/appeals',
    {
      ...listOptions,
      detail: {
        operationId: 'thread.appeals',
        'x-exposure': 'public',
        'x-action': 'moderation:read_reports',
        security: [{ bearerAuth: [] }],
      },
    },
    ({ params: { id }, actor, query, admission, job, session, set }) =>
      operation(() =>
        admission.run('normal', job, async () => {
          const result = await listAppeals(deps, { kind: 'thread', id }, { actor, deadline: job.deadline }, query);
          session.record(result.anchor);
          if (result.selectedAnchor) session.record(result.selectedAnchor);
          set.headers['cache-control'] = 'private, no-store';
          return result.value;
        }),
      ),
  );
}
