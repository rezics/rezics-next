import { contentRequestId } from './adapters/bind.ts';
import { memoizedValue } from '../memoized.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import type { editionRoutes } from './edition-routes.ts';
import { readBoardWatchState, setBoardWatch } from './board-watch.ts';
import { readBoardWatchPage } from './board-watch-page.ts';
import { listWatches, removeWatch } from './watch-management.ts';
import { ContentNotFoundError } from './reads.ts';
import { WatchManagementKindSchema, WatchManagementPageSchema, strictContentSchema } from './schemas.ts';
import type { WatchDependencies } from './watch-authority.ts';

const closed = { additionalProperties: false };
const revision = t.Integer({ minimum: 0, maximum: 2147483646 });
const state = t.Object({ watching: t.Boolean(), revision }, closed);
const advice = t.Union([t.Literal('available'), t.Literal('denied'), t.Literal('not-applicable')]);
const page = t.Object(
  {
    boardId: t.String(),
    accountId: t.String(),
    viewer: t.Object({ state: t.Literal('current'), watching: t.Boolean(), revision }, closed),
    actions: t.Object({ watch: advice, unwatch: advice }, closed),
    source: t.Object({ epoch: t.Integer(), position: t.String() }, closed),
  },
  closed,
);
function sessionHeader() {
  return memoizedValue(sessionHeader, () => ({ [SESSION_HEADER]: t.String() }));
}
function headers() {
  return memoizedValue(headers, () => t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }));
}
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    409: problemSchema('conflict'),
    422: problemSchema('idempotency_conflict', 'too_many_events'),
    429: problemSchema('rate_limited'),
    500: problemSchema('internal_error'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
    ),
  }));
}
const readDetail = { 'x-exposure': 'public', 'x-action': 'account:read', security: [{ bearerAuth: [] }] };
function writeDetail() {
  return memoizedValue(writeDetail, () => ({
    'x-exposure': 'public',
    'x-action': 'account:update',
    'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
    security: [{ bearerAuth: [] }],
  }));
}

/** Native Content methods consumed by board controls and Settings. No alternate board list exists. */
export function watchRoutes(app: ReturnType<typeof editionRoutes>, deps: WatchDependencies) {
  return app
    .get(
      '/v1/boards/:id/watch/page',
      {
        params: t.Object({ id: t.String() }, closed),
        response: { 200: withHeaders(page, sessionHeader()), ...failures() },
        detail: { ...readDetail, operationId: 'board.watch_page' },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        try {
          const result = await admission.run('normal', job, () => readBoardWatchPage(deps, actor, id, job.deadline));
          session.record({
            partition: result.anchor.partition.partitionNo,
            epoch: result.anchor.epoch,
            position: result.anchor.position,
          });
          return result.value;
        } catch (error) {
          if (error instanceof ContentNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .get(
      '/v1/boards/:id/watch',
      {
        params: t.Object({ id: t.String() }, closed),
        response: { 200: withHeaders(state, sessionHeader()), ...failures() },
        detail: { ...readDetail, operationId: 'board.watch_state' },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        try {
          const result = await admission.run('normal', job, () => readBoardWatchState(deps, actor, id, job.deadline));
          session.record({
            partition: result.anchor.partition.partitionNo,
            epoch: result.anchor.epoch,
            position: result.anchor.position,
          });
          set.headers['cache-control'] = 'private, no-store';
          return { watching: result.watching, revision: result.revision };
        } catch (error) {
          if (error instanceof ContentNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .put(
      '/v1/boards/:id/watch',
      {
        params: t.Object({ id: t.String() }, closed),
        headers: headers(),
        body: strictContentSchema(t.Object({ watching: t.Boolean(), expectedRevision: revision }, closed)),
        response: { 200: withHeaders(state, sessionHeader()), ...failures() },
        detail: { ...writeDetail(), operationId: 'board.set_watch' },
      },
      async ({ params: { id }, body, headers: requestHeaders, actor, admission, job, session, set }) => {
        try {
          const result = await admission.run('normal', job, () =>
            setBoardWatch(
              deps,
              actor,
              { boardId: id, ...body },
              {
                idempotencyKey: idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]),
                deadline: job.deadline,
                requestId: contentRequestId(),
              },
            ),
          );
          session.record(result);
          set.headers['cache-control'] = 'private, no-store';
          return result.value;
        } catch (error) {
          if (error instanceof ContentNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .get(
      '/v1/accounts/:accountId/watches',
      {
        params: t.Object({ accountId: t.String() }, closed),
        query: t.Object(
          {
            kind: WatchManagementKindSchema,
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1 })),
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
          },
          closed,
        ),
        response: {
          200: withHeaders(WatchManagementPageSchema, sessionHeader()),
          ...failures(),
        },
        detail: { ...readDetail, operationId: 'watch.list' },
      },
      async ({ params: { accountId }, query, actor, admission, job, set }) => {
        const result = await admission.run('normal', job, () =>
          listWatches(deps, actor, accountId, query, job.deadline),
        );
        set.headers['cache-control'] = 'private, no-store';
        return result;
      },
    )
    .delete(
      '/v1/accounts/:accountId/watches/:watchId',
      {
        params: t.Object({ accountId: t.String(), watchId: t.String() }, closed),
        headers: headers(),
        query: t.Object({ kind: WatchManagementKindSchema }, closed),
        body: strictContentSchema(t.Object({ expectedRevision: revision }, closed)),
        response: { 200: withHeaders(t.Object({ removed: t.Boolean() }, closed), sessionHeader()), ...failures() },
        detail: { ...writeDetail(), operationId: 'watch.remove' },
      },
      async ({
        params: { accountId, watchId },
        query,
        body,
        headers: requestHeaders,
        actor,
        admission,
        job,
        session,
        set,
      }) => {
        const result = await admission.run('normal', job, () =>
          removeWatch(
            deps,
            actor,
            accountId,
            { kind: query.kind, watchId, expectedRevision: body.expectedRevision },
            {
              idempotencyKey: idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]),
              deadline: job.deadline,
              requestId: contentRequestId(),
            },
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    );
}
