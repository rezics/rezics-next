import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import { bundledRelease } from '@rezics/definitions/bundled';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/contract/errors.ts';
import type { KernelClock } from '../clock.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER } from '@rezics/operations/protocol';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { AuthenticationError } from '../request/authentication-error.ts';
import type { Access, Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  HOSTED_READING_POSITION_BLOCK_MAX,
  HOSTED_READING_POSITION_OFFSET_MAX,
  type HostedReadingPort,
} from './contract/hosted-reading.ts';
import {
  createHostedReadingCommands,
  createHostedReadingReads,
  validateHostedReadingClear,
  validateHostedReadingSave,
} from './hosted-reading.ts';
import { requireHostedReadingPort } from './hosted-reading-bind.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const revision = t.String({ pattern: '^[1-9][0-9]{0,18}$' });
const position = t.Object(
  {
    blockId: t.String({ minLength: 1, maxLength: HOSTED_READING_POSITION_BLOCK_MAX }),
    offset: t.Integer({ minimum: 0, maximum: HOSTED_READING_POSITION_OFFSET_MAX }),
  },
  closed,
);
const address = {
  catalogueId: id,
  publicationRevisionId: id,
  occurrenceId: id,
  targetRevisionId: id,
  targetSha256: digest,
  documentPosition: t.Union([position, t.Null()]),
};
const target = t.Object({ threadId: id, postId: id, revisionId: id, sha256: digest }, closed);
const document = t.Object(
  {
    encoding: t.Literal('base64'),
    canonicalBytes: t.String(),
    sha256: digest,
    authorId: id,
    licence: t.String({ minLength: 1, maxLength: 128 }),
  },
  closed,
);
const resume = t.Union([
  t.Object(
    {
      availability: t.Literal('available'),
      occurrenceId: id,
      parentId: t.Union([id, t.Null()]),
      position: t.Integer({ minimum: 0, maximum: 511 }),
      kind: t.Literal('chapter'),
      title: t.String({ minLength: 1, maxLength: 256 }),
      target,
      document,
    },
    closed,
  ),
  t.Object(
    {
      availability: t.Literal('unavailable'),
      occurrenceId: id,
      kind: t.Union([t.Literal('chapter'), t.Literal('part'), t.Literal('unknown')]),
    },
    closed,
  ),
]);

function getResponse() {
  return memoizedValue(getResponse, () =>
    t.Union([
      t.Object({ state: t.Literal('none'), subjectId: id }, closed),
      t.Object(
        {
          state: t.Literal('saved'),
          subjectId: id,
          revision,
          address: t.Object(address, closed),
          resume,
        },
        closed,
      ),
    ]),
  );
}

function saveResponse() {
  return memoizedValue(saveResponse, () =>
    t.Object(
      {
        subjectId: id,
        revision,
        address: t.Object(address, closed),
      },
      closed,
    ),
  );
}

function clearResponse() {
  return memoizedValue(clearResponse, () => t.Object({ subjectId: id, cleared: t.Literal(true) }, closed));
}

function unauthorized() {
  return memoizedValue(unauthorized, () => problemSchema('authentication_required', 'invalid_credentials'));
}
function forbidden() {
  return memoizedValue(forbidden, () => problemSchema('forbidden'));
}
function invalid() {
  return memoizedValue(invalid, () => problemSchema('invalid_request'));
}
function conflict() {
  return memoizedValue(conflict, () => problemSchema('conflict'));
}
function notFound() {
  return memoizedValue(notFound, () => problemSchema('not_found'));
}
function unavailable() {
  return memoizedValue(unavailable, () =>
    problemSchema(
      'overloaded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'deadline_exceeded',
      'dependency_unavailable',
    ),
  );
}
function idempotencyHeaders() {
  return memoizedValue(idempotencyHeaders, () =>
    t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) }),
  );
}

function detail(operationId: string, actionName: string, isWrite = false) {
  return {
    operationId,
    'x-exposure': 'gate:reading_progress',
    'x-action': actionName,
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': Object.keys(bundledRelease.types),
    security: [{ bearerAuth: [] }],
    ...(isWrite ? { 'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }) } : {}),
  };
}

function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}

function mapCommandError(error: unknown): never {
  if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
  throw error;
}

export type HostedReadingRouteDependencies = {
  pool: Pool;
  access: () => Access;
  clock?: KernelClock;
  content?: HostedReadingPort;
};

export function hostedReadingRoutes(
  app: ReturnType<typeof definitionRoutes>,
  dependencies: HostedReadingRouteDependencies,
) {
  const content = () => dependencies.content ?? requireHostedReadingPort();
  const reads = () =>
    createHostedReadingReads({
      pool: dependencies.pool,
      access: dependencies.access(),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      content: content(),
    });
  const commands = () =>
    createHostedReadingCommands({
      pool: dependencies.pool,
      access: dependencies.access(),
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      content: content(),
    });
  return app
    .get(
      '/v1/libraryHostedReading',
      {
        query: t.Object({ subjectId: id }, closed),
        transform: ({ request, set }) => {
          set.headers['cache-control'] = 'private, no-store';
          const query = new URL(request.url).searchParams;
          if ([...query.keys()].some((key) => key !== 'subjectId') || query.getAll('subjectId').length !== 1)
            throw new ProblemError('invalid_request');
        },
        response: {
          200: getResponse(),
          400: invalid(),
          401: unauthorized(),
          403: forbidden(),
          503: unavailable(),
        },
        detail: detail('hosted_reading.get', 'progress_session:list'),
      },
      async ({ actor, admission, job, query, request }) => {
        const owner = requireAccount(actor);
        return admission.run('normal', job, () => reads().get(owner, query.subjectId, job.deadline, request.signal));
      },
    )
    .put(
      '/v1/libraryHostedReading',
      {
        headers: idempotencyHeaders(),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
        body: t.Object(
          {
            subjectId: id,
            catalogueId: id,
            publicationRevisionId: id,
            occurrenceId: id,
            targetRevisionId: id,
            targetSha256: digest,
            documentPosition: t.Optional(t.Union([position, t.Null()])),
            expectedRevision: t.Union([revision, t.Null()]),
          },
          closed,
        ),
        response: {
          200: saveResponse(),
          400: invalid(),
          401: unauthorized(),
          403: forbidden(),
          404: notFound(),
          409: conflict(),
          422: problemSchema('idempotency_conflict'),
          410: problemSchema('command_result_erased'),
          503: unavailable(),
        },
        detail: detail('hosted_reading.save', 'progress_session:update', true),
      },
      async ({ actor, admission, job, body, headers }) => {
        const owner = requireAccount(actor);
        return admission.run('normal', job, async () => {
          try {
            const result = await commands().save(
              owner,
              validateHostedReadingSave(body),
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
              job.deadline,
            );
            return result.value;
          } catch (error) {
            mapCommandError(error);
          }
        });
      },
    )
    .post(
      customMethod('/v1/libraryHostedReading', 'clear'),
      {
        headers: idempotencyHeaders(),
        transform: ({ set }) => {
          set.headers['cache-control'] = 'private, no-store';
        },
        body: t.Object({ subjectId: id, expectedRevision: revision }, closed),
        response: {
          200: clearResponse(),
          400: invalid(),
          401: unauthorized(),
          403: forbidden(),
          409: conflict(),
          422: problemSchema('idempotency_conflict'),
          410: problemSchema('command_result_erased'),
          503: unavailable(),
        },
        detail: detail('hosted_reading.clear', 'progress_session:update', true),
      },
      async ({ actor, admission, job, body, headers }) => {
        const owner = requireAccount(actor);
        return admission.run('normal', job, async () => {
          try {
            const result = await commands().clear(
              owner,
              validateHostedReadingClear(body),
              idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]),
            );
            return result.value;
          } catch (error) {
            mapCommandError(error);
          }
        });
      },
    );
}
