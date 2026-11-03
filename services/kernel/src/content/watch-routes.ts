import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import type { editionRoutes } from './edition-routes.ts';
import { readBoardWatchState, setBoardWatch } from './board-watch.ts';
import { listWatches, removeWatch } from './watch-management.ts';
import { ContentNotFoundError } from './reads.ts';
import { strictContentSchema } from './schemas.ts';
import type { WatchDependencies } from './watch-authority.ts';

const closed = { additionalProperties: false };
const selection = t.Union([t.Literal('thread'), t.Literal('board')]);
const revision = t.Integer({ minimum: 0, maximum: 2147483646 });
const state = t.Object({ watching: t.Boolean(), revision }, closed);
const sessionHeader = { [SESSION_HEADER]: t.String() };
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const failures = {
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
};
const identity = { id: t.String(), kind: selection, revision, createdAt: t.String() };
const item = t.Union([
  t.Object(
    { ...identity, state: t.Literal('available'), resourceId: t.String(), title: t.Union([t.String(), t.Null()]) },
    closed,
  ),
  t.Object({ ...identity, state: t.Literal('unavailable') }, closed),
]);
const readDetail = { 'x-exposure': 'public', 'x-action': 'account:read', security: [{ bearerAuth: [] }] };
const writeDetail = {
  'x-exposure': 'public',
  'x-action': 'account:update',
  'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
  security: [{ bearerAuth: [] }],
};

/** Native Content methods consumed by board controls and Settings. No alternate board list exists. */
export function watchRoutes(app: ReturnType<typeof editionRoutes>, deps: WatchDependencies) {
  return app
    .get(
      '/v1/boards/:id/watch',
      {
        params: t.Object({ id: t.String() }, closed),
        response: { 200: withHeaders(state, sessionHeader), ...failures },
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
        headers,
        body: strictContentSchema(t.Object({ watching: t.Boolean(), expectedRevision: revision }, closed)),
        response: { 200: withHeaders(state, sessionHeader), ...failures },
        detail: { ...writeDetail, operationId: 'board.set_watch' },
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
                requestId: Bun.randomUUIDv7(),
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
            kind: selection,
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1 })),
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
          },
          closed,
        ),
        response: {
          200: withHeaders(
            t.Object({ items: t.Array(item), next: t.Union([t.String(), t.Null()]) }, closed),
            sessionHeader,
          ),
          ...failures,
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
        headers,
        query: t.Object({ kind: selection }, closed),
        body: strictContentSchema(t.Object({ expectedRevision: revision }, closed)),
        response: { 200: withHeaders(t.Object({ removed: t.Boolean() }, closed), sessionHeader), ...failures },
        detail: { ...writeDetail, operationId: 'watch.remove' },
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
              requestId: Bun.randomUUIDv7(),
            },
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    );
}
