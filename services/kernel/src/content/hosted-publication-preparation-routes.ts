import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { customMethod, defineRateLimit } from '../http/route-metadata.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { contentRequestId } from './adapters/bind.ts';
import type { contentRoutes } from './routes.ts';
import { strictContentSchema } from './schema-validation.ts';
import {
  ContentNotFoundError as CommandNotFoundError,
  ContentForbiddenError,
  RevisionPreconditionError,
} from './commands.ts';
import {
  HostedPublicationStagingConflictError,
  HostedPublicationStagingExpiredError,
  HostedPublicationStagingNotFoundError,
} from './hosted-publication-staging-model.ts';
import {
  HostedVersionReleaseCandidateError,
  HostedVersionReleaseCandidateNotFoundError,
} from './hosted-version-release-candidate-model.ts';
import {
  advanceHostedPublicationPreparation,
  appendHostedPublicationPreparationBatch,
  cancelHostedPublicationPreparation,
  freezeHostedPublicationPreparationSelection,
  readHostedPublicationPreparationProgress,
  sealHostedPublicationPreparation,
  startHostedPublicationPreparation,
  type HostedPublicationPreparationDependencies,
} from './hosted-publication-preparation.ts';
import {
  HostedIdSchema,
  HostedPublicationPreparationAdvanceSchema,
  HostedPublicationPreparationBatchSchema,
  HostedPublicationPreparationEmptySchema,
  HostedPublicationPreparationProgressSchema,
  HostedPublicationPreparationStartSchema,
} from './hosted-publication-preparation-schemas.ts';

const closed = { additionalProperties: false } as const;
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
const params = t.Object({ id: HostedIdSchema }, closed);
const stageParams = t.Object({ id: HostedIdSchema, stageId: HostedIdSchema }, closed);
const authorDetail = {
  'x-exposure': 'public',
  'x-resource-types': ['content.post'],
  'x-action': 'post:revise',
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
};

function failures() {
  return {
    400: problemSchema('invalid_request'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
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
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof CommandNotFoundError ||
      error instanceof HostedPublicationStagingNotFoundError ||
      error instanceof HostedVersionReleaseCandidateNotFoundError
    )
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (
      error instanceof RevisionPreconditionError ||
      error instanceof HostedPublicationStagingConflictError ||
      error instanceof HostedPublicationStagingExpiredError
    )
      throw new ProblemError('precondition_failed');
    if (error instanceof HostedVersionReleaseCandidateError && error.code !== 'invalid-tree')
      throw new ProblemError('precondition_failed');
    throw error;
  }
}

function context(request: Request, deadline: number) {
  return {
    deadline,
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    requestId: contentRequestId(),
  };
}

function record<T>(result: T, session: { record: (value: T) => void }, set: { headers: Record<string, string> }) {
  session.record(result);
  set.headers['cache-control'] = 'private, no-store';
}

/** Adds only the private preparation author API. It is registered by the
 * existing hosted chapter route owner and never changes publication pointers. */
export function hostedPublicationPreparationRoutes(
  app: ReturnType<typeof contentRoutes>,
  deps: HostedPublicationPreparationDependencies,
) {
  app.post(
    customMethod('/v1/hostedCatalogues/:id', 'prepareRelease'),
    {
      params,
      headers,
      body: strictContentSchema(HostedPublicationPreparationStartSchema),
      response: {
        202: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release' },
    },
    async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          startHostedPublicationPreparation(deps, actor, id, body, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      set.status = 202;
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'appendSelectionBatch'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationBatchSchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.append_batch' },
    },
    async ({ actor, params: { id, stageId }, body, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          appendHostedPublicationPreparationBatch(deps, actor, id, stageId, body, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'freezeSelection'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationEmptySchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.freeze' },
    },
    async ({ actor, params: { id, stageId }, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          freezeHostedPublicationPreparationSelection(deps, actor, id, stageId, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'advance'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationAdvanceSchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.advance' },
    },
    async ({ actor, params: { id, stageId }, body, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          advanceHostedPublicationPreparation(deps, actor, id, stageId, body.stepId, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'progress'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationEmptySchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.progress' },
    },
    async ({ actor, params: { id, stageId }, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          readHostedPublicationPreparationProgress(deps, actor, id, stageId, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'cancel'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationEmptySchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.cancel' },
    },
    async ({ actor, params: { id, stageId }, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          cancelHostedPublicationPreparation(deps, actor, id, stageId, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  app.post(
    customMethod('/v1/hostedCatalogues/:id/publicationPreparations/:stageId', 'seal'),
    {
      params: stageParams,
      headers,
      body: strictContentSchema(HostedPublicationPreparationEmptySchema),
      response: {
        200: withHeaders(strictContentSchema(HostedPublicationPreparationProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: { ...authorDetail, operationId: 'hosted_catalogue.prepare_release.seal' },
    },
    async ({ actor, params: { id, stageId }, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const result = await operation(() =>
        admission.run('normal', job, () =>
          sealHostedPublicationPreparation(deps, actor, id, stageId, context(request, job.deadline)),
        ),
      );
      record(result, session, set);
      return result.value;
    },
  );

  return app;
}
