import { t } from 'elysia';
import type { Pool } from 'pg';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ProgressIntent, ProgressSession } from './progress-model.ts';
import { createSessionCommands, ProgressConflictError, ProgressInvalidError } from './sessions.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { createPublishedLogCommands } from './published-logs.ts';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from './profile-schemas.ts';

import { basicQuery, embedded, fullView, logFields, sessionFields, viewQuery } from './views.ts';

type Dependencies = { pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock };

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableString = t.Union([t.String(), t.Null()]);
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
const mode = t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]);
const unitInput = libraryVocabularyIdSchema;
const state = t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('abandoned')]);
const sessionSchema = t.Object(
  {
    id,
    subjectId: id,
    versionSubjectId: t.Union([id, t.Null()]),
    mode,
    unit: libraryStoredVocabularySchema,
    total: nullableString,
    amount: nullableString,
    locator: nullableString,
    position: nullableString,
    completedUnitCount: t.Integer({ minimum: 0, maximum: 20_000 }),
    state,
    revision,
    startedAt: t.String(),
    completedAt: nullableString,
  },
  closed,
);
const progressSessionResponse = t.Object({ progressSession: sessionSchema }, closed);
const changeIntent = t.Union([
  t.Object({ amount: t.String() }, closed),
  t.Object({ locator: t.String(), position: t.String() }, closed),
  t.Object({ add: t.Array(t.String()), remove: t.Optional(t.Array(t.String())) }, closed),
  t.Object({ remove: t.Array(t.String()) }, closed),
]);
const changeSchema = t.Object(
  {
    id: t.String(),
    revision,
    intent: changeIntent,
    createdAt: t.String(),
  },
  closed,
);
const changePageResponse = t.Object({ changes: t.Array(changeSchema), next: nullableString }, closed);
const unitPageResponse = t.Object({ completedUnits: t.Array(t.String()), next: nullableString }, closed);
const publishedLogSchema = t.Object(
  {
    id,
    accountId: id,
    subjectId: id,
    sessionState: state,
    startedAt: t.String(),
    completedAt: nullableString,
    note: nullableString,
    publishedAt: t.String(),
  },
  closed,
);
const publishedLogResponse = t.Object({ publishedLog: publishedLogSchema }, closed);
const idempotencyHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String({ minLength: 3, maxLength: 1024 }) });
const invalid = problemSchema('invalid_request', 'invalid_cursor');
const unauthorized = problemSchema('authentication_required', 'invalid_credentials');
const conflict = problemSchema('conflict', 'stale_cursor');
const idempotencyConflict = problemSchema('idempotency_conflict');
const profileConflict = problemSchema('idempotency_conflict', 'unsupported_library_profile');
const forbidden = problemSchema('forbidden');
const notFound = problemSchema('not_found');
const unavailable = problemSchema(
  'overloaded',
  'partition_unavailable',
  'transaction_retry_exhausted',
  'deadline_exceeded',
  'dependency_unavailable',
);
const bearer = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const pageQuery = {
  ...viewQuery,
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
  cursor: t.Optional(t.String({ maxLength: 4096 })),
};
const recordBody = t.Object(
  {
    revision,
    amount: t.Optional(t.String()),
    locator: t.Optional(t.String()),
    position: t.Optional(t.String()),
    add: t.Optional(t.Array(t.String(), { maxItems: 100 })),
    remove: t.Optional(t.Array(t.String(), { maxItems: 100 })),
  },
  closed,
);
const transitionBody = t.Object({ revision }, closed);

function detail(operationId: string, action: string, anonymous = false) {
  return {
    operationId,
    'x-exposure': 'gate:reading_progress',
    'x-action': action,
    security: anonymous ? [...bearer, {}] : bearer,
    ...(/:(?:create|update|delete)$/.test(action) ? { 'x-rate-limit': writeRate } : {}),
  };
}

function sessionView(session: ProgressSession) {
  const {
    id,
    subjectId,
    versionSubjectId,
    mode,
    unit,
    total,
    amount,
    locator,
    position,
    completedUnitCount,
    state,
    revision,
    startedAt,
    completedAt,
  } = session;
  return {
    id,
    subjectId,
    versionSubjectId,
    mode,
    unit,
    total,
    amount,
    locator,
    position,
    completedUnitCount,
    state,
    revision,
    startedAt,
    completedAt,
  };
}

function changeView(change: { sessionId: string; changeNo: number; intent: unknown; recordedAt: string }) {
  return {
    id: `${change.sessionId}:${change.changeNo}`,
    revision: change.changeNo,
    intent: change.intent as ProgressIntent,
    createdAt: change.recordedAt,
  };
}

function requireAccount(actor: Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}

function mapError(error: unknown, denied: 'forbidden' | 'not_found' = 'forbidden'): never {
  if (error instanceof ProgressInvalidError) throw new ProblemError('invalid_request');
  if (error instanceof ProgressConflictError) throw new ProblemError('conflict');
  if (error instanceof LibraryNotFoundError) throw new ProblemError('not_found');
  if (error instanceof GrantDeniedError) throw new ProblemError(denied);
  throw error;
}

async function mapped<T>(run: () => Promise<T>, denied: 'forbidden' | 'not_found' = 'forbidden'): Promise<T> {
  try {
    return await run();
  } catch (error) {
    mapError(error, denied);
  }
}

/** HTTP transport for private progress sessions and their public published snapshots. */
export function progressRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const config = () => ({ ...dependencies, access: dependencies.access() });
  const { pool, tokens, clock } = dependencies;
  let sessions: ReturnType<typeof createSessionCommands> | undefined;
  let published: ReturnType<typeof createPublishedLogCommands> | undefined;
  const sessionCommands = () =>
    (sessions ??= createSessionCommands({ pool, access: dependencies.access(), tokens, clock }));
  const publishedCommands = () =>
    (published ??= createPublishedLogCommands({ pool, access: dependencies.access(), tokens, clock }));

  return app
    .post(
      '/v1/progressSessions',
      {
        headers: idempotencyHeaders,
        body: t.Object(
          {
            subjectId: t.String(),
            versionSubjectId: t.Optional(t.Union([t.String(), t.Null()])),
            mode,
            unit: unitInput,
            total: t.Optional(nullableString),
          },
          closed,
        ),
        response: {
          201: progressSessionResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: profileConflict,
          503: unavailable,
        },
        detail: detail('progress_session.create', 'progress_session:create'),
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => sessionCommands().startSession(actor, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { progressSession: sessionView(result.value) };
      },
    )
    .get(
      '/v1/progressSessions',
      {
        query: t.Object({ subjectId: t.String(), ...pageQuery }, closed),
        response: {
          200: t.Object(
            { progressSessions: t.Array(embedded(sessionSchema, sessionFields)), next: nullableString },
            closed,
          ),
          400: invalid,
          401: unauthorized,
          403: forbidden,
          409: conflict,
          404: notFound,
          503: unavailable,
        },
        detail: detail('progress_session.list', 'progress_session:list'),
      },
      async ({ query, actor, admission, job }) => {
        requireAccount(actor);
        return admission.run('normal', job, () =>
          mapped(async () => {
            // One shared subject plus up to 99 distinct versions stays within 100 anchored reads.
            const page = basicQuery(query);
            const options = query.view === 'FULL' ? { ...page, limit: Math.min(page.limit ?? 20, 99) } : page;
            const result = await sessionCommands().listSessions(actor, query.subjectId, options);
            return fullView(config(), actor, query.view, {
              progressSessions: result.sessions.map(sessionView),
              next: result.next,
            });
          }),
        );
      },
    )
    .get(
      '/v1/progressSessions/:sessionId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ sessionId: t.String() }, closed),
        response: {
          200: t.Object({ progressSession: embedded(sessionSchema, sessionFields) }, closed),
          400: invalid,
          401: unauthorized,
          404: notFound,
          503: unavailable,
        },
        detail: detail('progress_session.read', 'progress_session:read'),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          mapped(
            async () =>
              fullView(config(), actor, query.view, {
                progressSession: sessionView(await sessionCommands().readSession(actor, params.sessionId)),
              }),
            'not_found',
          ),
        ),
    )
    .post(
      customMethod('/v1/progressSessions/:sessionId', 'record'),
      {
        params: t.Object({ sessionId: t.String() }, closed),
        headers: idempotencyHeaders,
        body: recordBody,
        response: {
          200: progressSessionResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: problemSchema('conflict'),
          422: profileConflict,
          503: unavailable,
        },
        detail: detail('progress_session.record', 'progress_session:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => sessionCommands().recordProgress(actor, params.sessionId, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { progressSession: sessionView(result.value) };
      },
    )
    .post(
      customMethod('/v1/progressSessions/:sessionId', 'complete'),
      {
        params: t.Object({ sessionId: t.String() }, closed),
        headers: idempotencyHeaders,
        body: transitionBody,
        response: {
          200: progressSessionResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: problemSchema('conflict'),
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: detail('progress_session.complete', 'progress_session:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => sessionCommands().completeSession(actor, params.sessionId, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { progressSession: sessionView(result.value) };
      },
    )
    .post(
      customMethod('/v1/progressSessions/:sessionId', 'abandon'),
      {
        params: t.Object({ sessionId: t.String() }, closed),
        headers: idempotencyHeaders,
        body: transitionBody,
        response: {
          200: progressSessionResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: problemSchema('conflict'),
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: detail('progress_session.abandon', 'progress_session:update'),
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => sessionCommands().abandonSession(actor, params.sessionId, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { progressSession: sessionView(result.value) };
      },
    )
    .get(
      '/v1/progressSessions/:sessionId/completedUnits',
      {
        params: t.Object({ sessionId: t.String() }, closed),
        query: t.Object(pageQuery, closed),
        response: { 200: unitPageResponse, 400: invalid, 404: notFound, 409: conflict, 503: unavailable },
        detail: detail('progress_session.units', 'progress_session:read'),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            const result = await sessionCommands().listUnits(actor, params.sessionId, basicQuery(query));
            return { completedUnits: result.units.map((unit) => unit.unitId), next: result.next };
          }, 'not_found'),
        ),
    )
    .get(
      '/v1/progressSessions/:sessionId/changes',
      {
        params: t.Object({ sessionId: t.String() }, closed),
        query: t.Object(pageQuery, closed),
        response: { 200: changePageResponse, 400: invalid, 404: notFound, 409: conflict, 503: unavailable },
        detail: detail('progress_session.changes', 'progress_session:read'),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            const result = await sessionCommands().listChanges(actor, params.sessionId, basicQuery(query));
            return { changes: result.changes.map(changeView), next: result.next };
          }, 'not_found'),
        ),
    )
    .post(
      '/v1/publishedLogs',
      {
        headers: idempotencyHeaders,
        body: t.Object(
          { sessionId: t.String(), note: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])) },
          closed,
        ),
        response: {
          201: publishedLogResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: detail('published_log.create', 'published_log:create'),
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => publishedCommands().publishLog(actor, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        return { publishedLog: result.value };
      },
    )
    .get(
      '/v1/publishedLogs/:logId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ logId: t.String() }, closed),
        response: {
          200: t.Object({ publishedLog: embedded(publishedLogSchema, logFields) }, closed),
          400: invalid,
          404: notFound,
          503: unavailable,
        },
        detail: detail('published_log.read', 'published_log:read', true),
      },
      async ({ params, query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          mapped(
            async () =>
              fullView(config(), actor, query.view, {
                publishedLog: await publishedCommands().readPublishedLog(actor, params.logId),
              }),
            'not_found',
          ),
        ),
    )
    .get(
      '/v1/publishedLogs',
      {
        query: t.Object({ accountId: t.String(), ...pageQuery }, closed),
        response: {
          200: t.Object(
            { publishedLogs: t.Array(embedded(publishedLogSchema, logFields)), next: nullableString },
            closed,
          ),
          400: invalid,
          404: notFound,
          409: conflict,
          503: unavailable,
        },
        detail: detail('published_log.list', 'published_log:read', true),
      },
      async ({ query, actor, admission, job }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            const page = basicQuery(query);
            return fullView(config(), actor, query.view, await publishedCommands().listPublishedLogs(actor, page));
          }),
        ),
    )
    .delete(
      '/v1/publishedLogs/:logId',
      {
        params: t.Object({ logId: t.String() }, closed),
        headers: idempotencyHeaders,
        response: {
          200: publishedLogResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: detail('published_log.delete', 'published_log:delete'),
      },
      async ({ params, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => publishedCommands().retractLog(actor, params.logId, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { publishedLog: result.value };
      },
    );
}
