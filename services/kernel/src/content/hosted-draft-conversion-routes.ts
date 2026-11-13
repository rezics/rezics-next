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
import type { knowledgeRoutes } from './knowledge-routes.ts';
import { strictContentSchema } from './schema-validation.ts';
import {
  ContentNotFoundError as CommandNotFoundError,
  ContentForbiddenError,
  RevisionPreconditionError,
} from './commands.ts';
import { ContentNotFoundError } from './reads.ts';
import { runHostedDraftConversionStep, type HostedDraftConversionInput } from './hosted-draft-conversion.ts';
import { HostedDraftConversionProgressSchema, HostedDraftConversionSchema } from './hosted-draft-conversion-schemas.ts';
import {
  HostedMigrationInputIncompleteError,
  HostedMigrationInputUnavailableError,
  InvalidHostedMigrationInputError,
} from './hosted-migration-input-model.ts';
import { HostedVersionBuilderError } from './hosted-version-builder-model.ts';
import { HostedVersionDraftActivationError } from './hosted-version-draft-activation-model.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';

const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
const params = t.Object(
  {
    id: t.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);

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
      error instanceof ContentNotFoundError ||
      error instanceof CommandNotFoundError ||
      error instanceof HostedMigrationInputUnavailableError ||
      (error instanceof HostedVersionDraftActivationError && error.code === 'unavailable-source')
    ) {
      throw new ProblemError('not_found');
    }
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (
      error instanceof RevisionPreconditionError ||
      error instanceof HostedMigrationInputIncompleteError ||
      (error instanceof HostedVersionBuilderError &&
        ['source-mismatch', 'stale-source', 'stale-frontier'].includes(error.code)) ||
      (error instanceof HostedVersionDraftActivationError && error.code === 'stale-source')
    ) {
      throw new ProblemError('precondition_failed');
    }
    if (
      error instanceof InvalidHostedMigrationInputError ||
      error instanceof HostedVersionBuilderError ||
      error instanceof HostedVersionDraftActivationError
    ) {
      throw new ProblemError('invalid_request');
    }
    throw error;
  }
}

/** Mount the resumable author conversion beside the installed ordered point routes. */
export function hostedDraftConversionRoutes(
  app: ReturnType<typeof knowledgeRoutes>,
  dependencies: HostedCommandDependencies,
) {
  return app.post(
    customMethod('/v1/hostedCatalogues/:id', 'convertDraft'),
    {
      params,
      headers,
      body: strictContentSchema(HostedDraftConversionSchema),
      response: {
        200: withHeaders(strictContentSchema(HostedDraftConversionProgressSchema), responseHeaders),
        ...failures(),
      },
      detail: {
        'x-exposure': 'public',
        'x-resource-types': ['content.post'],
        'x-action': 'post:revise',
        'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
        operationId: 'hosted_catalogue.convert_draft',
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      const context = {
        deadline: job.deadline,
        idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
        requestId: contentRequestId(),
      };
      const result = await operation(() =>
        admission.run('normal', job, () =>
          runHostedDraftConversionStep(dependencies, actor, id, body as HostedDraftConversionInput, context),
        ),
      );
      for (const command of result.commands) session.record(command);
      set.headers['cache-control'] = 'private, no-store';
      return result.progress;
    },
  );
}
