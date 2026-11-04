import { t } from 'elysia';
import type { OperationCatalogue } from '@rezics/operations';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { Access } from '../request/access.ts';
import { languageRanges } from '../semantic/language.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { bindOperation } from '../http/operation-adapter.ts';
import { FeedKindSchema, FeedPageSchema, FeedSelectionIdSchema } from './feed-contract.ts';
import { FEED_CURSOR_BYTES } from './feed-cursor.ts';
import { createFeedReads, type FeedDependencies } from './feed.ts';

export function feedRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: Omit<FeedDependencies, 'access' | 'contentAccess' | 'workClient'> & {
    access: () => Access;
    contentAccess: () => Access;
    workClient: FeedDependencies['workClient'];
    operations: OperationCatalogue;
  },
) {
  const { operations, ...runtimeDependencies } = deps;
  const operation = bindOperation(
    operations,
    'feed_item.list',
    'GET',
    {
      query: {
        reference: 'content.feed.items.query',
        schema: t.Object(
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
      },
      response: {
        reference: 'content.feed.page',
        schema: {
          200: FeedPageSchema,
          400: problemSchema('invalid_request', 'invalid_cursor'),
          401: problemSchema('authentication_required', 'invalid_credentials'),
          403: problemSchema('forbidden', 'platform_closed'),
          404: problemSchema('not_found'),
          409: problemSchema('stale_cursor', 'search_restart_required'),
          422: problemSchema('unsupported_query'),
          503: problemSchema('deadline_exceeded', 'dependency_unavailable', 'overloaded', 'partition_unavailable'),
        },
      },
    },
    (schemas, detail) => ({
      query: schemas.query.schema,
      response: schemas.response.schema,
      detail,
    }),
  );
  return app.get(
    operation.path,
    {
      ...operation.options,
      transform: ({ request, set }) => {
        if (request.headers.has('authorization')) set.headers['cache-control'] = 'private, no-store';
        const parameters = new URL(request.url).searchParams;
        for (const name of parameters.keys())
          if (!['stream', 'limit', 'cursor', 'kind', 'spaceId', 'ratingQuestionId'].includes(name))
            throw new ProblemError('invalid_request');
        for (const name of ['kind', 'spaceId', 'ratingQuestionId'])
          if (parameters.getAll(name).length > 1) throw new ProblemError('invalid_request');
      },
    },
    async ({ actor, query, admission, job, request }) =>
      admission.run('normal', job, async () =>
        createFeedReads({
          ...runtimeDependencies,
          access: runtimeDependencies.access(),
          contentAccess: runtimeDependencies.contentAccess(),
        }).list(actor, query, job.deadline, languageRanges(request.headers.get('accept-language'))),
      ),
  );
}
