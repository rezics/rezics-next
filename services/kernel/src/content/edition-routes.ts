import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { customMethod } from '../http/custom-method.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import type { appealRoutes } from './appeal-routes.ts';
import { ContentNotFoundError as CommandNotFoundError, RevisionPreconditionError } from './commands.ts';
import { ContentNotFoundError } from './reads.ts';
import {
  createContentEdition,
  publishContentEdition,
  unpublishContentEdition,
  type EditionCommandDependencies,
} from './edition-commands.ts';
import { readContentEdition, readContentEditionRevision } from './edition-reads.ts';
import {
  ContentEditionInputSchema,
  ContentEditionSchema,
  ContentEditionRevisionSchema,
  ContentEditionCommandSchema,
  strictContentSchema,
} from './schemas.ts';

const params = t.Object({ id: t.String() }, { additionalProperties: false });
const headers = t.Object(
  { [IDEMPOTENCY_HEADER]: t.String(), 'if-match': t.Optional(t.String()) },
  { additionalProperties: true },
);
const cacheHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
const command = strictContentSchema(ContentEditionCommandSchema);
const empty = strictContentSchema(t.Object({}, { additionalProperties: false }));
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
  412: problemSchema('precondition_failed'),
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
};
async function operation<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ContentNotFoundError || error instanceof CommandNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    throw error;
  }
}
function expected(request: Request): string {
  const match = /^"([1-9][0-9]*)"$/.exec(request.headers.get('if-match') ?? '');
  if (!match || match[1]!.length > 19) throw new ProblemError('precondition_failed');
  return match[1]!;
}

/** Public catalogue declarations retain authenticated native admission and private delivery. */
export function editionRoutes(app: ReturnType<typeof appealRoutes>, deps: EditionCommandDependencies) {
  app.wrap((handle) => async (request) => {
    const response = await handle(request);
    if (new URL(request.url).pathname.startsWith('/v1/contentEditions'))
      response.headers.set('cache-control', 'private, no-store');
    return response;
  });
  return app
    .post(
      '/v1/contentEditions',
      {
        headers,
        body: strictContentSchema(ContentEditionInputSchema),
        response: { 201: withHeaders(command, cacheHeaders), ...failures },
        detail: {
          operationId: 'content_edition.create',
          'x-exposure': 'public',
          'x-action': 'post:revise',
          'x-resource-types': ['content.edition'],
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const result = await operation(() =>
          admission.run('normal', job, () =>
            createContentEdition(deps, actor, body, {
              idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
              deadline: job.deadline,
            }),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/contentEditions/:id', 'publish'),
      {
        params,
        headers,
        body: empty,
        response: { 200: withHeaders(command, cacheHeaders), ...failures },
        detail: {
          operationId: 'content_edition.publish',
          'x-exposure': 'public',
          'x-action': 'edition:sell',
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, params: { id }, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const version = expected(request);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            publishContentEdition(deps, actor, id, version, {
              idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
              deadline: job.deadline,
            }),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return { editionId: result.value.editionId, editionRevision: result.value.editionRevision };
      },
    )
    .post(
      customMethod('/v1/contentEditions/:id', 'unpublish'),
      {
        params,
        headers,
        body: empty,
        response: { 200: withHeaders(command, cacheHeaders), ...failures },
        detail: {
          operationId: 'content_edition.unpublish',
          'x-exposure': 'public',
          'x-action': 'edition:unpublish',
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, params: { id }, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const version = expected(request);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            unpublishContentEdition(deps, actor, id, version, {
              idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
              deadline: job.deadline,
            }),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return { editionId: result.value.editionId, editionRevision: result.value.editionRevision };
      },
    )
    .get(
      '/v1/contentEditions/:id',
      {
        params,
        response: { 200: withHeaders(strictContentSchema(ContentEditionSchema), cacheHeaders), ...failures },
        detail: {
          operationId: 'content_edition.get',
          'x-exposure': 'public',
          'x-action': 'edition:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, params: { id }, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () => readContentEdition(deps, id, { actor, deadline: job.deadline })),
        );
        session.record({
          partition: result.anchor.partition.partitionNo,
          epoch: result.anchor.epoch,
          position: result.anchor.position,
        });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/contentEditions/:id/revision',
      {
        params,
        response: { 200: withHeaders(strictContentSchema(ContentEditionRevisionSchema), cacheHeaders), ...failures },
        detail: {
          operationId: 'content_edition.get_revision',
          'x-exposure': 'public',
          'x-action': 'edition:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ actor, params: { id }, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () => readContentEditionRevision(deps, id, { actor, deadline: job.deadline })),
        );
        session.record({
          partition: result.anchor.partition.partitionNo,
          epoch: result.anchor.epoch,
          position: result.anchor.position,
        });
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    );
}
