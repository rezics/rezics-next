import { t } from 'elysia';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { Access } from '../request/access.ts';
import { languageRanges } from '../semantic/language.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { FeedKindSchema, FeedPageSchema, FeedSelectionIdSchema } from './feed-contract.ts';
import { FEED_CURSOR_BYTES } from './feed-cursor.ts';
import { createFeedReads, type FeedDependencies } from './feed.ts';

export function feedRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<FeedDependencies, 'access' | 'contentAccess' | 'workClient'> & {
    access: () => Access;
    contentAccess: () => Access;
    workClient: FeedDependencies['workClient'];
  },
) {
  return app.get(
    '/v1/feedItems',
    {
      query: t.Object(
        {
          stream: t.Optional(t.Union([t.Literal('home'), t.Literal('following')])),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20, multipleOf: 1, default: 20 })),
          cursor: t.Optional(t.String({ minLength: 1, maxLength: FEED_CURSOR_BYTES })),
          kind: t.Optional(FeedKindSchema),
          spaceId: t.Optional(FeedSelectionIdSchema),
          ratingQuestionId: t.Optional(FeedSelectionIdSchema),
        },
        { additionalProperties: false },
      ),
      transform: ({ request, set }) => {
        if (request.headers.has('authorization')) set.headers['cache-control'] = 'private, no-store';
        const parameters = new URL(request.url).searchParams;
        for (const name of parameters.keys())
          if (!['stream', 'limit', 'cursor', 'kind', 'spaceId', 'ratingQuestionId'].includes(name))
            throw new ProblemError('invalid_request');
        for (const name of ['kind', 'spaceId', 'ratingQuestionId'])
          if (parameters.getAll(name).length > 1) throw new ProblemError('invalid_request');
      },
      response: {
        200: FeedPageSchema,
        400: problemSchema('invalid_request', 'invalid_cursor'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden', 'platform_closed'),
        409: problemSchema('stale_cursor', 'search_restart_required'),
        422: problemSchema('unsupported_query'),
        503: problemSchema('deadline_exceeded', 'dependency_unavailable', 'overloaded', 'partition_unavailable'),
      },
      detail: {
        operationId: 'feed_item.list',
        'x-action': 'feed_item:list',
        'x-exposure': 'public',
        security: [{}, { bearerAuth: [] }],
      },
    },
    async ({ actor, query, admission, job, request }) =>
      admission.run('normal', job, async () =>
        createFeedReads({ ...deps, access: deps.access(), contentAccess: deps.contentAccess() }).list(
          actor,
          query,
          job.deadline,
          languageRanges(request.headers.get('accept-language')),
        ),
      ),
  );
}
