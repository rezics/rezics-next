import { t } from 'elysia';
import { withHeaders } from '@elysia/openapi';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import {
  acknowledgeNotice,
  assertCurrentInboxViewer,
  countUnreadNotices,
  InboxViewerUnavailableError,
  InvalidInboxCursorError,
  listNoticeInbox,
  markNoticesSeen,
} from './notice-inbox.ts';
import { strictContentSchema } from './schemas.ts';

type Dependencies = {
  pool: import('pg').Pool;
  access: Access;
  tokens: KeyRing;
  routeKey: Uint8Array;
  clock?: () => Date;
};
const params = t.Object({ accountId: t.String() }, { additionalProperties: false });
const noticeParams = t.Object({ accountId: t.String(), noticeId: t.String() }, { additionalProperties: false });
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
  ),
};
const sessionHeader = { [SESSION_HEADER]: t.String() };
const item = t.Object({
  id: t.String(),
  kind: t.Union([
    t.Literal('reply'),
    t.Literal('mention'),
    t.Literal('thread_watch'),
    t.Literal('board_activity'),
    t.Literal('moderation_decision'),
  ]),
  createdAt: t.String(),
  actorId: t.Union([t.String(), t.Null()]),
  threadId: t.Union([t.String(), t.Null()]),
  postId: t.Union([t.String(), t.Null()]),
  decisionId: t.Union([t.String(), t.Null()]),
  reportId: t.Union([t.String(), t.Null()]),
  actor: t.Union([
    t.Object(
      {
        state: t.Literal('available'),
        accountId: t.String(),
        displayName: t.String(),
        handle: t.Union([t.String(), t.Null()]),
        avatarUrl: t.Union([t.String(), t.Null()]),
        automated: t.Boolean(),
      },
      { additionalProperties: false },
    ),
    t.Object(
      { state: t.Literal('withheld'), displayName: t.Literal('Former or unavailable account'), handle: t.Null(), avatarUrl: t.Null() },
      { additionalProperties: false },
    ),
    t.Object(
      { state: t.Literal('system'), displayName: t.Literal('Moderation team'), handle: t.Null(), avatarUrl: t.Null() },
      { additionalProperties: false },
    ),
  ]),
  target: t.Object(
    {
      state: t.Union([t.Literal('available'), t.Literal('withheld')]),
      threadId: t.Union([t.String(), t.Null()]),
      postId: t.Union([t.String(), t.Null()]),
      boardId: t.Union([t.String(), t.Null()]),
      threadTitle: t.Union([t.String(), t.Null()]),
      boardTitle: t.Union([t.String(), t.Null()]),
    },
    { additionalProperties: false },
  ),
  summary: t.String(),
  actions: t.Object(
    {
      open: t.Union([
        t.Object({ kind: t.Literal('board'), boardId: t.String() }, { additionalProperties: false }),
        t.Object({ kind: t.Literal('thread'), threadId: t.String() }, { additionalProperties: false }),
        t.Object(
          { kind: t.Literal('thread_post'), threadId: t.String(), postId: t.String() },
          { additionalProperties: false },
        ),
        t.Object({ kind: t.Literal('moderation_decision'), decisionId: t.String() }, { additionalProperties: false }),
        t.Object({ kind: t.Literal('report_outcome'), reportId: t.String() }, { additionalProperties: false }),
        t.Null(),
      ]),
      markSeen: t.Object({ method: t.Literal('POST'), path: t.String() }, { additionalProperties: false }),
    },
    { additionalProperties: false },
  ),
  unread: t.Boolean(),
});
const countResponse = t.Object({
  count: t.Integer({ minimum: 0, maximum: 100 }),
  capped: t.Boolean(),
  basis: t.Union([t.Literal('current-visible-unread'), t.Literal('current-visible-lower-bound')]),
  witness: t.Object({ kind: t.Literal('current-disclosure'), at: t.String({ format: 'date-time' }) }),
});
const seenBody = strictContentSchema(t.Object({ through: t.String() }, { additionalProperties: false }));
const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const listFailures = { ...failures, 400: problemSchema('invalid_request', 'invalid_cursor') };

function requireViewer(actor: { kind: string; accountId?: string }, accountId: string): void {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (actor.accountId !== accountId) throw new ProblemError('not_found');
  if (routeOf(accountId) === null) throw new ProblemError('not_found');
}

/** Mounts the account-private notification API on the content kernel. */
export function noticeRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  return app
    .get(
      '/v1/accounts/:accountId/notifications',
      {
        params,
        query: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })),
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: withHeaders(t.Object({ items: t.Array(item), next: t.Union([t.String(), t.Null()]) }), sessionHeader),
          ...listFailures,
        },
        detail: {
          operationId: 'notifications.list',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { accountId }, query, actor, admission, job }) => {
        requireViewer(actor, accountId);
        try {
          return await admission.run('normal', job, () =>
            listNoticeInbox(
              {
                pool: dependencies.pool,
                tokens: dependencies.tokens,
                access: dependencies.access,
                routeKey: dependencies.routeKey,
                actor,
                deadline: job.deadline,
                ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
              },
              accountId,
              { limit: query.limit ?? 20, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
            ),
          );
        } catch (error) {
          if (error instanceof InvalidInboxCursorError) throw new ProblemError('invalid_cursor');
          if (error instanceof InboxViewerUnavailableError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .get(
      '/v1/accounts/:accountId/notifications/count',
      {
        params,
        response: { 200: withHeaders(countResponse, sessionHeader), ...failures },
        detail: {
          operationId: 'notifications.count',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { accountId }, actor, admission, job }) => {
        requireViewer(actor, accountId);
        try {
          return await admission.run('normal', job, () =>
            countUnreadNotices(
              {
                pool: dependencies.pool,
                tokens: dependencies.tokens,
                access: dependencies.access,
                routeKey: dependencies.routeKey,
                actor,
                deadline: job.deadline,
                ...(dependencies.clock === undefined ? {} : { now: dependencies.clock }),
              },
              accountId,
            ),
          );
        } catch (error) {
          if (error instanceof InboxViewerUnavailableError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .post(
      customMethod('/v1/accounts/:accountId/notifications', 'markSeen'),
      {
        params,
        headers,
        body: seenBody,
        response: {
          204: withHeaders(t.Void(), sessionHeader),
          ...failures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          422: problemSchema('idempotency_conflict', 'too_many_events'),
        },
        detail: {
          operationId: 'notifications.mark_seen',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { accountId }, body, headers: requestHeaders, actor, admission, job, set }) => {
        requireViewer(actor, accountId);
        idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]);
        try {
          await admission.run('normal', job, async () => {
            await assertCurrentInboxViewer(
              {
                pool: dependencies.pool,
                access: dependencies.access,
                tokens: dependencies.tokens,
                routeKey: dependencies.routeKey,
                actor,
                deadline: job.deadline,
              },
              accountId,
            );
            await markNoticesSeen(dependencies.pool, accountId, body.through, dependencies.clock?.());
          });
        } catch (error) {
          if (error instanceof RangeError) throw new ProblemError('not_found');
          if (error instanceof InboxViewerUnavailableError) throw new ProblemError('not_found');
          throw error;
        }
        set.status = 204;
      },
    )
    .post(
      customMethod('/v1/accounts/:accountId/notifications/:noticeId', 'markSeen'),
      {
        params: noticeParams,
        headers,
        response: {
          204: withHeaders(t.Void(), sessionHeader),
          ...failures,
          403: problemSchema('forbidden'),
          429: problemSchema('rate_limited'),
          422: problemSchema('idempotency_conflict', 'too_many_events'),
        },
        detail: {
          operationId: 'notifications.mark_one_seen',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { accountId, noticeId }, headers: requestHeaders, actor, admission, job, set }) => {
        requireViewer(actor, accountId);
        idempotencyKeyOf(requestHeaders[IDEMPOTENCY_HEADER]);
        try {
          await admission.run('normal', job, async () => {
            await assertCurrentInboxViewer(
              {
                pool: dependencies.pool,
                access: dependencies.access,
                tokens: dependencies.tokens,
                routeKey: dependencies.routeKey,
                actor,
                deadline: job.deadline,
              },
              accountId,
            );
            await acknowledgeNotice(dependencies.pool, accountId, noticeId, dependencies.clock?.());
          });
        } catch (error) {
          if (error instanceof RangeError) throw new ProblemError('not_found');
          if (error instanceof InboxViewerUnavailableError) throw new ProblemError('not_found');
          throw error;
        }
        set.status = 204;
      },
    );
}
