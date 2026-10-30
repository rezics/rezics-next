import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { withConnection } from '../../database/pool.ts';
import { customMethod } from '../../http/custom-method.ts';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import { defineRateLimit } from '../../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, requestDigest, SESSION_HEADER } from '../../http/request.ts';
import type { subjectRoutes } from './subjects.ts';
import { AuthenticationError, type Access, type AccessFactory } from '../../request/access.ts';
import { globalReadEligibility } from '../eligibility.ts';
import { ContextNotFoundError, editorialContextAnchor, publicContextEligibility } from '../context.ts';
import { routeOf } from '../../route/route.ts';
import { MAX_BODY_LIMIT } from '../../http/body.ts';
import type { Resource } from '../../request/access.ts';
import { activateExtension, activeExtension, ExtensionInputError, publishExtension } from '../extensions.ts';
import {
  activateRelease,
  activeRelease,
  DefinitionAccessDeniedError,
  DefinitionInputError,
  DefinitionNotFoundError,
  GLOBAL_CONTEXT,
  publishRelease,
  readRelease,
  StaleEditorialHeadError,
} from '../definitions.ts';

const resource = { route: 0, id: GLOBAL_CONTEXT };
const digestResponse = t.Object({ digest: t.String() }, { additionalProperties: false });
const activeResponse = t.Object({ digest: t.String(), head: t.Integer() }, { additionalProperties: false });
const releaseObject = t.Record(t.String(), t.Any());
const writeHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const unavailable = problemSchema(
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
);
const unavailableCodes = [
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
] as const;
const sessionHeaders = { [SESSION_HEADER]: t.String() };

function definitionProblem(error: unknown): never {
  if (error instanceof ExtensionInputError)
    throw new ProblemError('invalid_request', {
      errors: error.violations.map(({ pointer, code }) => ({ pointer: `/extension${pointer}`, code })),
    });
  if (error instanceof DefinitionInputError)
    throw new ProblemError('invalid_request', {
      errors: error.violations.map(({ pointer, code }) => ({
        pointer: `/release${pointer}`,
        code: code === 'limit' ? 'out_of_range' : 'invalid_format',
      })),
    });
  if (error instanceof DefinitionAccessDeniedError) throw new ProblemError('forbidden');
  if (error instanceof DefinitionNotFoundError || error instanceof ContextNotFoundError)
    throw new ProblemError('not_found');
  if (error instanceof StaleEditorialHeadError) throw new ProblemError('stale_editorial_head');
  throw error;
}

export function definitionRoutes(
  app: ReturnType<typeof subjectRoutes>,
  { pool, access, clock }: { pool: Pool; access?: Access | AccessFactory; clock: () => Date },
) {
  // A direct Access override without prepare owns its full decision and cannot evaluate domain floors.
  const includeEligibility = !access || typeof access === 'function' || typeof access.prepare === 'function';
  return app
    .post(
      '/v1/definitions/releases',
      {
        headers: writeHeaders,
        body: t.Object({ release: releaseObject }, { additionalProperties: false }),
        response: {
          200: withHeaders(digestResponse, sessionHeaders),
          201: withHeaders(digestResponse, sessionHeaders),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          operationId: 'definitions.publish',
          'x-exposure': 'gate:definition_publication',
          'x-action': 'definitions:publish',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          'x-body-limit': MAX_BODY_LIMIT,
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(resource, () => new DefinitionAccessDeniedError());
        try {
          const result = await admission.run('normal', job, () =>
            publishRelease(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('definitions.publish', actor, { params: {}, body }),
              release: body.release,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          set.status = result.created ? 201 : 200;
          return { digest: result.digest };
        } catch (error) {
          return definitionProblem(error);
        }
      },
    )
    .get(
      '/v1/definitions/releases/:digest',
      {
        params: t.Object({ digest: t.String() }),
        response: {
          200: withHeaders(t.Object({ digest: t.String(), release: releaseObject }, { additionalProperties: false }), {
            etag: t.String(),
            'cache-control': t.String(),
          }),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'definitions.read_release',
          'x-exposure': 'public',
          'x-action': 'definitions:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job, set }) => {
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('definitions:read') } : {}),
        });
        const release = await admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          // A release composed for one Context is not a published release.
          return readRelease(pool, params.digest, { composed: false });
        });
        if (!release) throw new ProblemError('not_found');
        set.headers.etag = `"${params.digest}"`;
        set.headers['cache-control'] = 'public, max-age=31536000, immutable';
        return { digest: params.digest, release: release as unknown as Record<string, unknown> };
      },
    )
    .get(
      '/v1/definitions/active',
      {
        response: {
          200: activeResponse,
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'definitions.read_active',
          'x-exposure': 'public',
          'x-action': 'definitions:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ authorize, admission, job }) => {
        const check = await authorize({
          ...resource,
          ...(includeEligibility ? { eligibility: globalReadEligibility('definitions:read') } : {}),
        });
        const active = await admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          return activeRelease(pool);
        });
        if (!active) throw new ProblemError('not_found');
        return { digest: active.digest, head: active.head };
      },
    )
    .post(
      customMethod('/v1/definitions/releases/:digest', 'activate'),
      {
        params: t.Object({ digest: t.String() }),
        headers: writeHeaders,
        body: t.Object(
          { expected_head: t.Union([t.Integer({ minimum: 1, maximum: 2147483646 }), t.Null()]) },
          { additionalProperties: false },
        ),
        response: {
          200: withHeaders(activeResponse, sessionHeaders),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          operationId: 'definitions.activate',
          'x-exposure': 'gate:definition_publication',
          'x-action': 'definitions:activate',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const authorization = await authorizeCommand(resource, () => new DefinitionAccessDeniedError());
        try {
          const result = await admission.run('normal', job, () =>
            activateRelease(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('definitions.activate', actor, { params, body }),
              releaseDigest: params.digest,
              expectedHead: body.expected_head,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return { digest: result.digest, head: result.head };
        } catch (error) {
          return definitionProblem(error);
        }
      },
    )
    .post(
      '/v1/contexts/:id/definitions/extensions',
      {
        params: t.Object({ id: t.String() }),
        headers: writeHeaders,
        body: t.Object({ extension: releaseObject }, { additionalProperties: false }),
        response: {
          200: withHeaders(digestResponse, sessionHeaders),
          201: withHeaders(digestResponse, sessionHeaders),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          422: problemSchema('idempotency_conflict'),
          503: problemSchema('semantic_not_ready', ...unavailableCodes),
        },
        detail: {
          operationId: 'definitions.publish_extension',
          'x-exposure': 'gate:definition_publication',
          'x-action': 'definitions:publish',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (params.id !== GLOBAL_CONTEXT && route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const context = { route: params.id === GLOBAL_CONTEXT ? 0 : route!, id: params.id };
        const nativeAuthorization = await authorizeCommand(context, () => new DefinitionAccessDeniedError());
        const anchor = editorialContextAnchor(params.id);
        const authorization = {
          ...nativeAuthorization,
          async authorize(
            tx: import('../../command/command.ts').CommandTransaction,
            attempt: import('../../command/command.ts').CommandAttempt,
            evidence: unknown,
          ) {
            await anchor.validate(tx, attempt.time);
            return nativeAuthorization.authorize(tx, attempt, evidence);
          },
        };
        try {
          const result = await admission.run('normal', job, () =>
            publishExtension(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('definitions.publish_extension', actor, { params, body }),
              context: params.id,
              extension: body.extension,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          set.status = result.created ? 201 : 200;
          return { digest: result.digest };
        } catch (error) {
          return definitionProblem(error);
        }
      },
    )
    .post(
      customMethod('/v1/contexts/:id/definitions/extensions/:digest', 'activate'),
      {
        params: t.Object({ id: t.String(), digest: t.String() }),
        headers: writeHeaders,
        body: t.Object(
          { expected_head: t.Union([t.Integer({ minimum: 1, maximum: 2147483646 }), t.Null()]) },
          { additionalProperties: false },
        ),
        response: {
          200: withHeaders(activeResponse, sessionHeaders),
          400: problemSchema('invalid_request'),
          401: unauthorized,
          403: problemSchema('forbidden'),
          404: problemSchema('not_found'),
          409: problemSchema('stale_editorial_head'),
          422: problemSchema('idempotency_conflict'),
          503: unavailable,
        },
        detail: {
          operationId: 'definitions.activate_extension',
          'x-exposure': 'gate:definition_publication',
          'x-action': 'definitions:activate',
          'x-resource-types': ['semantic.context'],
          'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params, body, headers, actor, authorizeCommand, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const route = routeOf(params.id);
        if (params.id !== GLOBAL_CONTEXT && route === null) throw new ProblemError('not_found');
        const key = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const context = { route: params.id === GLOBAL_CONTEXT ? 0 : route!, id: params.id };
        const nativeAuthorization = await authorizeCommand(context, () => new DefinitionAccessDeniedError());
        const anchor = editorialContextAnchor(params.id);
        const authorization = {
          ...nativeAuthorization,
          async authorize(
            tx: import('../../command/command.ts').CommandTransaction,
            attempt: import('../../command/command.ts').CommandAttempt,
            evidence: unknown,
          ) {
            await anchor.validate(tx, attempt.time);
            return nativeAuthorization.authorize(tx, attempt, evidence);
          },
        };
        try {
          const result = await admission.run('normal', job, () =>
            activateExtension(pool, {
              actor,
              idempotencyKey: key,
              digest: requestDigest('definitions.activate_extension', actor, { params, body }),
              context: params.id,
              extensionDigest: params.digest,
              expectedHead: body.expected_head,
              authorize: authorization.check,
              authorization,
              deadline: job.deadline,
              clock,
            }),
          );
          session.record(result.component);
          return { digest: result.digest, head: result.head };
        } catch (error) {
          return definitionProblem(error);
        }
      },
    )
    .get(
      '/v1/contexts/:id/definitions',
      {
        params: t.Object({ id: t.String() }),
        response: {
          200: t.Object(
            {
              context: t.String(),
              digest: t.Union([t.String(), t.Null()]),
              head: t.Integer(),
              extension: t.Union([releaseObject, t.Null()]),
            },
            { additionalProperties: false },
          ),
          401: unauthorized,
          404: problemSchema('not_found'),
          503: problemSchema('overloaded', 'deadline_exceeded'),
        },
        detail: {
          operationId: 'definitions.read_context',
          'x-exposure': 'public',
          'x-action': 'context:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params, authorize, admission, job }) => {
        const route = params.id === GLOBAL_CONTEXT ? 0 : routeOf(params.id);
        if (route === null) throw new ProblemError('not_found');
        const context: Resource = { route, id: params.id };
        context.eligibility = publicContextEligibility(context);
        const check = await authorize(context);
        const active = await admission.run('normal', job, async () => {
          if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('not_found');
          try {
            return await activeExtension(pool, params.id);
          } catch (error) {
            return definitionProblem(error);
          }
        });
        return {
          context: params.id,
          digest: active?.digest ?? null,
          head: active?.head ?? 0,
          extension: (active?.extension as unknown as Record<string, unknown> | undefined) ?? null,
        };
      },
    );
}
