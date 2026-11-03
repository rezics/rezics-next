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
import type { ProgressIntent, ProgressPresentation, ProgressScalarMeasure, ProgressSession } from './progress-model.ts';
import { MAX_PROGRESS_MEASURES } from './progress.ts';
import { createSessionCommands, ProgressConflictError, ProgressInvalidError } from './sessions.ts';
import { LibraryNotFoundError } from './command-support.ts';
import { createPublishedLogCommands } from './published-logs.ts';
import { libraryStoredVocabularySchema, libraryVocabularyIdSchema } from './profile-schemas.ts';
import { MAX_JOURNAL_REFLECTION_CHARACTERS } from './progress-journal.ts';
import { createConsumptionStatisticsReads, type ConsumptionSummary } from './consumption-statistics.ts';

const MAX_JOURNAL_PATCH_BODY_BYTES = 16_384;

import { basicQuery, embedded, fullView, logFields, sessionFields, viewQuery } from './views.ts';

type Dependencies = { routeKey: Uint8Array; pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock };

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullableString = t.Union([t.String(), t.Null()]);
const revision = t.Integer({ minimum: 1, maximum: 2_147_483_646 });
const journalRevision = t.Integer({ minimum: 0, maximum: 2_147_483_646 });
const journalDate = t.Object(
  {
    year: t.Integer({ minimum: 1, maximum: 9_999 }),
    month: t.Optional(t.Integer({ minimum: 1, maximum: 12 })),
    day: t.Optional(t.Integer({ minimum: 1, maximum: 31 })),
  },
  closed,
);
const nullableJournalDate = t.Union([journalDate, t.Null()]);
const mode = t.Union([t.Literal('scalar_amount'), t.Literal('cursor_position'), t.Literal('completed_units')]);
const unitInput = libraryVocabularyIdSchema;
const state = t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('abandoned')]);
export const progressPresentationSchema = t.Unsafe<ProgressPresentation>(
  t.Object(
    {
      meaning: t.Union([t.Literal('known'), t.Literal('unknown'), t.Literal('unavailable')]),
      unitLabel: t.Optional(t.String()),
      unitLabelLanguage: t.Optional(t.String()),
      unitCountForms: t.Optional(
        t.Object(
          {
            other: t.String(),
            zero: t.Optional(t.String()),
            one: t.Optional(t.String()),
            two: t.Optional(t.String()),
            few: t.Optional(t.String()),
            many: t.Optional(t.String()),
          },
          closed,
        ),
      ),
      dimension: t.Optional(t.String()),
      structure: t.Literal('unverified'),
      recording: t.Union([
        t.Object(
          {
            state: t.Literal('supported'),
            inputRules: t.Object(
              {
                min: t.Optional(t.String()),
                max: t.Optional(t.String()),
                step: t.String(),
                total: t.Union([t.Literal('optional'), t.Literal('required'), t.Literal('forbidden')]),
              },
              closed,
            ),
          },
          closed,
        ),
        t.Object({ state: t.Union([t.Literal('unsupported'), t.Literal('unavailable')]) }, closed),
      ]),
    },
    closed,
  ),
);
export const sessionSchema = t.Object(
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
    measures: t.Optional(
      t.Array(
        t.Object(
          {
            unit: libraryStoredVocabularySchema,
            amount: nullableString,
            total: nullableString,
            presentation: t.Optional(progressPresentationSchema),
          },
          closed,
        ),
        { minItems: 2, maxItems: MAX_PROGRESS_MEASURES },
      ),
    ),
  },
  closed,
);
const presentationFields = { ...sessionFields, presentation: t.Optional(progressPresentationSchema) };
const progressSessionResponse = t.Object({ progressSession: sessionSchema }, closed);
const sessionJournalSchema = t.Object(
  {
    sessionId: id,
    revision: journalRevision,
    startDate: nullableJournalDate,
    finishDate: nullableJournalDate,
    reflection: t.Union([t.String({ maxLength: MAX_JOURNAL_REFLECTION_CHARACTERS }), t.Null()]),
  },
  closed,
);
const sessionJournalResponse = t.Object({ journal: sessionJournalSchema }, closed);
const sessionJournalWriteResponse = t.Object(
  { journal: t.Object({ sessionId: id, revision: journalRevision, changed: t.Boolean() }, closed) },
  closed,
);
const sessionJournalPatchBody = t.Object(
  {
    revision: journalRevision,
    startDate: t.Optional(nullableJournalDate),
    finishDate: t.Optional(nullableJournalDate),
    reflection: t.Optional(t.Union([t.String({ maxLength: MAX_JOURNAL_REFLECTION_CHARACTERS }), t.Null()])),
  },
  closed,
);
const changeIntent = t.Union([
  t.Object({ clear: t.Literal(true) }, closed),
  t.Object({ measureId: libraryStoredVocabularySchema, clear: t.Literal(true) }, closed),
  t.Object({ amount: t.String() }, closed),
  t.Object({ measureId: libraryStoredVocabularySchema, amount: t.String() }, closed),
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
const tombstoneSchema = t.Object({ id, deleted: t.Literal(true) }, closed);
const publishedLogConflicts = problemSchema(
  'published_log_restore_stale',
  'published_log_restore_occupied',
  'published_log_restore_expired',
);
const revisionHeader = {
  'Library-Published-Log-Revision': { schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
} as const;
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
    measureId: t.Optional(unitInput),
    clear: t.Optional(t.Literal(true)),
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

function sessionView(session: ProgressSession, presentations?: ReadonlyMap<string, ProgressPresentation>) {
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
  const measures = session.measures?.map((measure: ProgressScalarMeasure) => ({
    ...measure,
    ...(presentations?.has(measure.unit) ? { presentation: presentations.get(measure.unit)! } : {}),
  }));
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
    ...(measures === undefined ? {} : { measures }),
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
  const statistics = createConsumptionStatisticsReads({ pool });

  return app
    .get(
      '/v1/libraryConsumptionSummary',
      {
        query: t.Object({}, closed),
        transform: ({ request, set }) => {
          set.headers['cache-control'] = 'private, no-store';
          if (new URL(request.url).searchParams.size) throw new ProblemError('invalid_request');
        },
        response: {
          200: t.Unsafe<ConsumptionSummary>(
            t.Object(
              {
                scope: t.Literal('retained_native_sessions'),
                completedOccurrences: t.String({ pattern: '^[0-9]+$' }),
                distinctCompletedSubjects: t.String({ pattern: '^[0-9]+$' }),
                repeatOccurrences: t.String({ pattern: '^[0-9]+$' }),
                completedOccurrencesWithUnknownProfile: t.String({ pattern: '^[0-9]+$' }),
                coverage: t.Object(
                  {
                    nativeSessions: t.Literal('complete'),
                    otherHistory: t.Literal('unavailable'),
                    unitMeaning: t.Literal('not_evaluated'),
                  },
                  closed,
                ),
                currentness: t.Object({ state: t.Literal('snapshot'), revision: t.String() }, closed),
              },
              closed,
            ),
          ),
          400: invalid,
          401: unauthorized,
          403: problemSchema('forbidden', 'platform_closed'),
          503: unavailable,
        },
        detail: detail('library_consumption.summary', 'progress_session:list'),
      },
      async ({ actor, admission, job, request }) => {
        requireAccount(actor);
        return admission.run('normal', job, () => statistics.summary(actor, job.deadline, request.signal));
      },
    )
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
            additionalMeasures: t.Optional(
              t.Array(t.Object({ unit: unitInput, total: t.Optional(nullableString) }, closed), {
                minItems: 1,
                maxItems: MAX_PROGRESS_MEASURES - 1,
              }),
            ),
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
              progressSessions: result.sessions.map((session) => sessionView(session)),
              next: result.next,
            });
          }),
        );
      },
    )
    .get(
      '/v1/progressSessions/:sessionId',
      {
        query: t.Object({ ...viewQuery, presentation: t.Optional(t.Literal('FULL')) }, closed),
        params: t.Object({ sessionId: t.String() }, closed),
        response: {
          200: t.Object({ progressSession: embedded(sessionSchema, presentationFields) }, closed),
          400: invalid,
          401: unauthorized,
          404: notFound,
          409: conflict,
          503: unavailable,
        },
        detail: detail('progress_session.read', 'progress_session:read'),
      },
      async ({ params, query, actor, admission, job, set }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            set.headers['cache-control'] = 'private, no-store';
            if (query.presentation === 'FULL') {
              return sessionCommands().readPresentedSession(
                actor,
                params.sessionId,
                async (session, presentation, disclosure, measurePresentations) => {
                  const value = {
                    ...sessionView(
                      session,
                      new Map(measurePresentations.map((measure) => [measure.unit, measure.presentation])),
                    ),
                    presentation,
                  };
                  if (query.view !== 'FULL') return { progressSession: value };
                  const summary = async (id: string | null, disclosed: boolean) => {
                    if (!id || !disclosed) return null;
                    return (
                      (await fullView(config(), actor, 'FULL', { reference: { subjectId: id } })).reference.subject ??
                      null
                    );
                  };
                  const subject = await summary(session.subjectId, disclosure.subject);
                  const versionSubject =
                    session.versionSubjectId === session.subjectId
                      ? subject
                      : await summary(session.versionSubjectId, disclosure.versionSubject);
                  return { progressSession: { ...value, subject, versionSubject } };
                },
              );
            }
            return fullView(config(), actor, query.view, {
              progressSession: sessionView(await sessionCommands().readSession(actor, params.sessionId)),
            });
          }, 'not_found'),
        ),
    )
    .get(
      '/v1/progressSessions/:sessionId/journal',
      {
        params: t.Object({ sessionId: t.String() }, closed),
        response: {
          200: sessionJournalResponse,
          401: unauthorized,
          404: notFound,
          409: conflict,
          503: unavailable,
        },
        detail: detail('progress_session.journal.read', 'progress_session:read'),
      },
      async ({ params, actor, admission, job, set }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            set.headers['cache-control'] = 'private, no-store';
            return { journal: await sessionCommands().readSessionJournal(actor, params.sessionId) };
          }, 'not_found'),
        ),
    )
    .patch(
      '/v1/progressSessions/:sessionId/journal',
      {
        params: t.Object({ sessionId: t.String() }, closed),
        headers: idempotencyHeaders,
        body: sessionJournalPatchBody,
        response: {
          200: sessionJournalWriteResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: problemSchema('conflict'),
          413: problemSchema('content_too_large'),
          503: unavailable,
        },
        detail: {
          ...detail('progress_session.journal.update', 'progress_session:update'),
          'x-body-limit': MAX_JOURNAL_PATCH_BODY_BYTES,
        },
      },
      async ({ params, body, headers, actor, admission, job, session }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => sessionCommands().patchSessionJournal(actor, params.sessionId, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        return { journal: result.value };
      },
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
        detail: {
          ...detail('published_log.create', 'published_log:create'),
          responses: { 201: { description: 'Snapshot published', headers: revisionHeader } },
        },
      },
      async ({ body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => publishedCommands().publishLog(actor, body, requestKey)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        set.status = 201;
        if (result.revision !== undefined) set.headers['Library-Published-Log-Revision'] = String(result.revision);
        set.headers['cache-control'] = 'private, no-store';
        return { publishedLog: result.value };
      },
    )
    .get(
      '/v1/publishedLogs/:logId',
      {
        query: t.Object(viewQuery, closed),
        params: t.Object({ logId: t.String() }, closed),
        response: {
          200: t.Object({ publishedLog: t.Union([embedded(publishedLogSchema, logFields), tombstoneSchema]) }, closed),
          400: invalid,
          404: notFound,
          503: unavailable,
        },
        detail: {
          ...detail('published_log.read', 'published_log:read', true),
          responses: {
            200: { description: 'Public snapshot or safe tombstone; revision is owner-only', headers: revisionHeader },
          },
        },
      },
      async ({ params, query, actor, admission, job, set }) =>
        admission.run('normal', job, () =>
          mapped(async () => {
            const result = await publishedCommands().readWithRevision(actor, params.logId);
            set.headers['cache-control'] = 'private, no-store';
            if (result.revision !== undefined) set.headers['Library-Published-Log-Revision'] = String(result.revision);
            return fullView(config(), actor, query.view, { publishedLog: result.publishedLog });
          }, 'not_found'),
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
        query: t.Object(
          { revision: t.Optional(t.Numeric({ minimum: 1, maximum: 2147483646, multipleOf: 1 })) },
          closed,
        ),
        response: {
          200: publishedLogResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: publishedLogConflicts,
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: {
          ...detail('published_log.delete', 'published_log:delete'),
          responses: {
            200: {
              description: 'Snapshot retracted; exact old receipts may omit deletion headers',
              headers: {
                'Library-Published-Log-Deletion-Id': { schema: { type: 'string', format: 'uuid' } },
                'Library-Published-Log-Deletion-Revision': { schema: { type: 'string', pattern: '^[1-9][0-9]*$' } },
              },
            },
          },
        },
      },
      async ({ params, query, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const requestKey = idempotencyKeyOf(headers[IDEMPOTENCY_HEADER]);
        const result = await admission.run('normal', job, () =>
          mapped(() => publishedCommands().retractLog(actor, params.logId, requestKey, query.revision)),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        if (result.deletionId !== undefined && result.revision !== undefined) {
          set.headers['Library-Published-Log-Deletion-Id'] = result.deletionId;
          set.headers['Library-Published-Log-Deletion-Revision'] = String(result.revision);
        }
        set.headers['cache-control'] = 'private, no-store';
        return { publishedLog: result.value };
      },
    )
    .post(
      customMethod('/v1/publishedLogs/:logId', 'restore'),
      {
        params: t.Object({ logId: t.String() }, closed),
        headers: idempotencyHeaders,
        body: t.Object({ deletionId: id, revision }, closed),
        response: {
          200: publishedLogResponse,
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: notFound,
          409: publishedLogConflicts,
          422: idempotencyConflict,
          503: unavailable,
        },
        detail: {
          ...detail('published_log.restore', 'published_log:create'),
          responses: {
            200: { description: 'Original snapshot restored', headers: revisionHeader },
          },
        },
      },
      async ({ params, body, headers, actor, admission, job, session, set }) => {
        requireAccount(actor);
        const result = await admission.run('normal', job, () =>
          mapped(() =>
            publishedCommands().restoreLog(actor, params.logId, body, idempotencyKeyOf(headers[IDEMPOTENCY_HEADER])),
          ),
        );
        session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
        if (result.revision !== undefined) set.headers['Library-Published-Log-Revision'] = String(result.revision);
        set.headers['cache-control'] = 'private, no-store';
        return { publishedLog: result.value };
      },
    );
}
