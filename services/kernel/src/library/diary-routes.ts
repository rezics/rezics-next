import { t } from 'elysia';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { DIARY_LIMIT, type DiaryPage } from './diary-model.ts';
import { createDiaryReads } from './diary-reads.ts';

const closed = { additionalProperties: false } as const;
const id = t.String({ format: 'uuid' });
const nullable = t.Union([t.String(), t.Null()]);
const subject = t.Union([t.Object({ id, label: nullable, language: nullable }, closed), t.Null()]);
const diaryPageSchema = t.Unsafe<DiaryPage>(t.Object({
  occurrences: t.Array(t.Object({
    id, subjectId: id, versionSubjectId: t.Union([id, t.Null()]),
    state: t.Union([t.Literal('active'), t.Literal('completed'), t.Literal('abandoned')]),
    revision: t.Integer({ minimum: 1 }),
    recordedStartedAt: t.String(), recordedCompletedAt: nullable,
    reportedDates: t.Object({ availability: t.Literal('unavailable') }, closed),
    subject, versionSubject: subject,
  }, closed), { maxItems: DIARY_LIMIT }),
  order: t.Literal('recorded_started_desc_id_desc'), next: nullable, continuation: nullable, expiresAt: nullable,
}, closed));
const token = t.String({ minLength: 1, maxLength: 2048 });
const failures = {
  400: problemSchema('invalid_request', 'invalid_cursor'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden', 'platform_closed'),
  409: problemSchema('stale_cursor', 'conflict'),
  503: problemSchema('semantic_not_ready', 'dependency_unavailable', 'overloaded', 'partition_unavailable',
    'transaction_retry_exhausted', 'deadline_exceeded'),
};
const detail = (operationId: string) => ({
  operationId,
  'x-action': 'progress_session:list',
  'x-exposure': 'gate:reading_progress',
  security: [{ bearerAuth: [] }],
});

/** Web's existing cross-subject diary consumes these methods and the existing presented session detail. */
export function diaryRoutes(app: ReturnType<typeof definitionRoutes>, deps: {
  pool: Pool; access: () => Access; tokens: KeyRing; clock: KernelClock; routeKey: Uint8Array;
}) {
  const reads = () => createDiaryReads({ ...deps, access: deps.access() });
  return app
    .get('/v1/libraryDiary', {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: DIARY_LIMIT, multipleOf: 1, default: 20 })),
        cursor: t.Optional(token),
      }, closed),
      transform: ({ request, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        const query = new URL(request.url).searchParams;
        for (const name of query.keys())
          if ((name !== 'limit' && name !== 'cursor') || query.getAll(name).length !== 1)
            throw new ProblemError('invalid_request');
      },
      response: { 200: diaryPageSchema, ...failures },
      detail: detail('library_diary.list'),
    }, async ({ actor, query, admission, job, request }) => admission.run('normal', job, async () => {
      if (request.signal.aborted) throw new ProblemError('deadline_exceeded');
      return reads().list(actor, query, job.deadline);
    }))
    .post(customMethod('/v1/libraryDiary', 'cancel'), {
      body: t.Object({ continuation: token }, closed),
      transform: ({ set }) => { set.headers['cache-control'] = 'private, no-store'; },
      response: { 200: t.Object({ cancelled: t.Literal(true) }, closed), ...failures },
      detail: detail('library_diary.cancel'),
    }, async ({ actor, body, admission, job }) =>
      admission.run('normal', job, () => reads().cancel(actor, body.continuation, job.deadline)));
}
