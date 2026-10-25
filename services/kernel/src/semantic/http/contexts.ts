import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { definitionRoutes } from './definitions.ts';
import { AuthenticationError, type AccountActor, type Resource } from '../../request/access.ts';
import { routeOf } from '../../route/route.ts';
import { SubjectInputError } from '../item.ts';
import {
  contextTarget,
  ContextAccessDeniedError,
  contextLabels,
  createContext,
  publicContextEligibility,
  readContext,
} from '../context.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import { GLOBAL_CONTEXT } from '../definitions.ts';

const globalContext = Object.freeze({ route: 0, id: GLOBAL_CONTEXT });

const LabelsInput = t.Object({ labels: t.Optional(t.Record(t.String(), t.Any())) }, { additionalProperties: false });
const ContextSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    kind: t.Union([t.Literal('community'), t.Literal('global')]),
    labels: t.Record(t.String(), t.String()),
  },
  { additionalProperties: false },
);
const contextResponse = t.Object({ context: ContextSchema }, { additionalProperties: false });
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const unavailable = problemSchema(
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
);

function contextRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: import('pg').Pool; routeKey: Uint8Array },
) {
  return app
    .post(
      '/v1/contexts',
      {
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: LabelsInput,
        response: {
          201: withHeaders(contextResponse, { [SESSION_HEADER]: t.String(), location: t.String() }),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          operationId: 'context.create',
          'x-action': 'context:create',
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const account: AccountActor = actor;
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const target = contextTarget(dependencies.routeKey, account.accountId, key);
        const authorization = await authorizeCommand(globalContext, () => new ContextAccessDeniedError());
        try {
          // Validate before entering the command; validation is shared with subject labels.
          contextLabels(target.id, body);
          const result = await admission.run('normal', job, () =>
            createContext(dependencies.pool, {
              actor: account,
              target,
              idempotencyKey: key,
              digest: requestDigest('context.create', account, body),
              input: body,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
            }),
          );
          session.record(result.component);
          set.status = 201;
          set.headers.location = `/v1/contexts/${result.context.id}`;
          return { context: result.context };
        } catch (error) {
          if (error instanceof SubjectInputError)
            throw new ProblemError('invalid_request', {
              errors: error.violations.map(({ pointer, code }) => ({ pointer, code })),
            });
          if (error instanceof ContextAccessDeniedError) throw new ProblemError('forbidden');
          throw error;
        }
      },
    )
    .get(
      '/v1/contexts/:id',
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: withHeaders(contextResponse, { [SESSION_HEADER]: t.String() }),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'context.get',
          'x-action': 'context:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job, session }) => {
        const route = routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const resource: Resource = { route, id: params.id };
        resource.eligibility = publicContextEligibility(resource);
        const check = await authorize(resource);
        const result = await admission.run('normal', job, () => readContext(dependencies.pool, params.id, check));
        if (!result) throw new ProblemError('not_found');
        session.record(result.component);
        return { context: result.context };
      },
    );
}

export { contextRoutes };
