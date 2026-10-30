import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { definitionRoutes } from './definitions.ts';
import { AuthenticationError, type AccountActor, type Resource } from '../../request/access.ts';
import { customMethod } from '../../http/custom-method.ts';
import { changeContextLifecycle, ContextLifecycleConflictError } from '../context-lifecycle.ts';
import { ContextNotFoundError } from '../context.ts';
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
import { parentCreationAuthorization } from '../../access/index.ts';
import { GrantDeniedError } from '../../access/grant-commands.ts';
import { authoritativeTimeValue } from '../../command/command.ts';
import { activeRelease } from '../definitions.ts';
import type { Access } from '../../request/access.ts';
import { globalContextAnchor } from '../context.ts';
import readCreatedContext from './contexts-read-creation.sql';

const LabelsInput = t.Object(
  {
    labels: t.Optional(t.Record(t.String(), t.Any())),
    settings: t.Optional(t.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' })),
  },
  { additionalProperties: false },
);
const ContextSchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    kind: t.Union([t.Literal('community'), t.Literal('global')]),
    labels: t.Record(t.String(), t.String()),
    settings: t.Union([t.Object({ id: t.String(), release: t.String() }, { additionalProperties: false }), t.Null()]),
    defaults: t.Record(t.String(), t.Union([t.Literal('inherit'), t.Literal('suppress')])),
  },
  { additionalProperties: false },
);
const contextResponse = t.Object({ context: ContextSchema }, { additionalProperties: false });
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');

const emptyBody = t.Object({}, { additionalProperties: false });
const lifecycleResponse = t.Object(
  {
    context: t.Object(
      {
        id: t.String({ format: 'uuid' }),
        state: t.Union([t.Literal('deleted'), t.Literal('active')]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const lifecycleResponses = {
  200: withHeaders(lifecycleResponse, { [SESSION_HEADER]: t.String() }),
  400: problemSchema('invalid_request'),
  401: unauthorized,
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  409: problemSchema('conflict'),
  422: problemSchema('idempotency_conflict'),
  503: problemSchema('overloaded', 'partition_unavailable', 'transaction_retry_exhausted', 'deadline_exceeded'),
};
function lifecycleProblem(error: unknown): never {
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  if (error instanceof ContextNotFoundError) throw new ProblemError('not_found');
  if (error instanceof ContextLifecycleConflictError) throw new ProblemError('conflict');
  throw error;
}

function contextRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: { pool: import('pg').Pool; routeKey: Uint8Array; access: () => Access; clock: () => Date },
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
          503: problemSchema(
            'semantic_not_ready',
            'overloaded',
            'partition_unavailable',
            'transaction_retry_exhausted',
            'deadline_exceeded',
          ),
        },
        detail: {
          operationId: 'context.create',
          'x-exposure': 'public',
          'x-action': 'context:create',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const account: AccountActor = actor;
        const active = await activeRelease(dependencies.pool);
        if (!active) throw new ProblemError('semantic_not_ready');
        const settingsId = body.settings;
        const settingsDefinition = settingsId === undefined ? undefined : active.release.contexts?.[settingsId];
        if (settingsId !== undefined && !Object.hasOwn(active.release.contexts ?? {}, settingsId))
          throw new ProblemError('invalid_request', { errors: [{ pointer: '/settings', code: 'unsupported' }] });
        const settings = settingsId === undefined ? null : { id: settingsId, release: active.digest };
        const defaults = settingsDefinition?.defaults ?? {};
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const target = contextTarget(dependencies.routeKey, account.accountId, key);
        try {
          const authorization = parentCreationAuthorization({
            access: dependencies.access(),
            actor: account,
            action: 'context:create',
            parent: globalContextAnchor,
            context: {
              pool: dependencies.pool,
              deadline: job.deadline,
              resource: target,
              creation: {
                async validate(client, resource, time) {
                  authoritativeTimeValue(time);
                  const found = await readCreatedContext.run(client, {
                    route: resource.route,
                    context_id: resource.id,
                  });
                  return found !== null;
                },
              },
            },
          });
          // Validate before entering the command; validation is shared with subject labels.
          contextLabels(target.id, body);
          const result = await admission.run('normal', job, () =>
            createContext(dependencies.pool, {
              actor: account,
              target,
              idempotencyKey: key,
              digest: requestDigest('context.create', account, body),
              input: body,
              settings,
              defaults,
              authorization,
              deadline: job.deadline,
              clock: dependencies.clock,
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
          if (error instanceof ContextAccessDeniedError || error instanceof GrantDeniedError)
            throw new ProblemError('forbidden');
          throw error;
        }
      },
    )
    .delete(
      '/v1/contexts/:id',
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: t.Optional(emptyBody),
        response: lifecycleResponses,
        detail: {
          operationId: 'context.delete',
          'x-exposure': 'public',
          'x-action': 'context:delete',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            changeContextLifecycle(dependencies.pool, {
              context: params.id,
              state: 'deleted',
              actor,
              access: dependencies.access(),
              idempotencyKey: key,
              digest: requestDigest('context.delete', actor, { params, body: {} }),
              deadline: job.deadline,
              clock: dependencies.clock,
            }),
          );
          session.record(result.component);
          return { context: result.context };
        } catch (error) {
          return lifecycleProblem(error);
        }
      },
    )
    .post(
      customMethod('/v1/contexts/:id', 'restore'),
      {
        params: t.Object({ id: t.String() }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
        body: emptyBody,
        response: lifecycleResponses,
        detail: {
          operationId: 'context.restore',
          'x-exposure': 'public',
          'x-action': 'context:restore',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, headers, actor, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        try {
          const result = await admission.run('normal', job, () =>
            changeContextLifecycle(dependencies.pool, {
              context: params.id,
              state: 'active',
              actor,
              access: dependencies.access(),
              idempotencyKey: key,
              digest: requestDigest('context.restore', actor, { params, body: {} }),
              deadline: job.deadline,
              clock: dependencies.clock,
            }),
          );
          session.record(result.component);
          return { context: result.context };
        } catch (error) {
          return lifecycleProblem(error);
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
          'x-exposure': 'public',
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
