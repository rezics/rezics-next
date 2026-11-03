import { readAuthorErasureAdmission, type AuthorErasureAdmission } from './author-erasure-admission.ts';
import { readEditionSourceIdentity } from './edition-reads.ts';
import { locateThreadPost } from './post-location.ts';
import { editionRoutes } from './edition-routes.ts';
import { listAuthorThreads, listAuthorPosts } from './author-item-reads.ts';
import { listBoardThreads, listRealmBoards, readRealmBoard, type ContentBoardDependencies } from './boards.ts';
import { BoardPinLimitError, setBoardThreadPin } from './board-pin.ts';
import { InvalidGlobalBoardDirectoryCursorError, listGlobalBoards } from './global-board-directory.ts';
import { listSubjectThreads } from './subject-threads.ts';
import { InvalidSitemapCursorError, listSitemapBoards, listSitemapThreads } from './sitemap.ts';
import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { parseItem } from 'structured-headers';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { softDeletePost } from './erase-post.ts';
import { restorePost } from './restore-post.ts';
import { readCurrentRestorationConflict } from './restoration-conflict.ts';
import { postEraseReceiptAccess } from './operations.ts';
import { appealRoutes } from './appeal-routes.ts';
import { moderationRoutes } from './moderation-routes.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { createApp } from '../http/app.ts';
import { customMethod } from '../http/custom-method.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { accessCheck, AuthenticationError, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { subjectReadEligibility } from '../semantic/eligibility.ts';
import { readPartition } from '../partition/partition.ts';
import readSubjectVisibility from '../semantic/read-visibility.sql';
import readSubjectRedirect from '../semantic/read-redirect.sql';
import readContainingThread from './read-containing-post-thread.sql';
import readLiveReview from './live-review-read.sql';
import { createBoard, BoardCreationConflictError, BoardCreationInputError } from './board-create.ts';
import { applyBoardCandidate } from './board-projection.ts';
import { documentRoutes } from './document-routes.ts';
import { sourceFenceRoutes } from './source-fence-routes.ts';
import { mediaModerationRoutes } from './media-moderation-routes.ts';
import {
  ContentForbiddenError,
  ContentNotFoundError as CommandNotFoundError,
  ContentUndisclosedError,
  createPost,
  createThread,
  ReviewConflictError,
  RevisionPreconditionError,
  revisePost,
  type ContentCommandDependencies,
} from './commands.ts';
import { InvalidMediaClaimError, MediaUnavailableError } from './media.ts';
import { DocumentTooLargeError, InvalidDocumentError, MAX_DOCUMENT_BYTES } from './document.ts';
import { mediaImportRoutes } from './media-import-routes.ts';
import { reportRoutes } from './report-routes.ts';
import { isErasedPlaceholder } from './model.ts';
import type { Anchored, AnchoredPosition, ReadContext } from './model.ts';
import { clearReaction, setReaction, type ReactionKind } from './reactions.ts';
import { readThreadWatchState, unwatchThread, watchThread } from './watch.ts';
import { watchRoutes } from './watch-routes.ts';
import type { ContentRuntime } from './runtime.ts';
import { sourceFenceGovernanceRoutes } from './source-fence-governance-routes.ts';
import {
  ContentNotFoundError as ReadNotFoundError,
  listPostRevisions,
  listThreadPosts,
  readPost,
  readThread,
  withReplayedRevision,
  withThreadReadAdmission,
  type ItemView,
  type PostEntry,
  type ThreadView,
  withReactionCounts,
  withViewerReactions,
  type SubjectReactionKind,
} from './reads.ts';
import {
  BoardResponseSchema,
  GlobalBoardDirectoryQuerySchema,
  GlobalBoardDirectoryResponseSchema,
  BoardViewSchema,
  BoardThreadsQuerySchema,
  BoardThreadsResponseSchema,
  BoardThreadPinInputSchema,
  BoardThreadPinResponseSchema,
  SitemapBoardPageSchema,
  SitemapQuerySchema,
  SitemapThreadPageSchema,
  ContentPageQuerySchema,
  PostPageResponseSchema,
  RevisionPageResponseSchema,
  PostInputSchema,
  PostResponseSchema,
  EditionSourceIdentitySchema,
  ReactionInputSchema,
  ReactionResponseSchema,
  SubjectOwnReactionResponseSchema,
  SubjectReactionRedirectResponseSchema,
  SubjectReactionInputSchema,
  SubjectReactionResponseSchema,
  RevisionInputSchema,
  strictContentSchema,
  ThreadInputSchema,
  ThreadResponseSchema,
  SubjectThreadsQuerySchema,
  SubjectThreadsResponseSchema,
  AuthorThreadsQuerySchema,
  AuthorThreadsResponseSchema,
  AuthorPostsQuerySchema,
  AuthorPostsResponseSchema,
} from './schemas.ts';
import { BoardSlowModeError, BoardSlowModeInputError, readBoardSlowMode, setBoardSlowMode } from './board-slow.ts';

export type Dependencies = ContentCommandDependencies & ContentBoardDependencies & ContentRuntime;
const params = t.Object({ id: t.String() }, { additionalProperties: false });
const readFailures = {
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
const writeFailures = {
  ...readFailures,
  403: problemSchema('forbidden'),
  429: problemSchema('rate_limited', 'board_slow_mode', {
    retryAt: t.Optional(t.String({ format: 'date-time' })),
    intervalSeconds: t.Optional(t.Integer({ minimum: 1, maximum: 86400 })),
  }),
  503: problemSchema(
    'overloaded',
    'deadline_exceeded',
    'partition_unavailable',
    'transaction_retry_exhausted',
    'dependency_unavailable',
    'rate_limit_unavailable',
  ),
  413: problemSchema('content_too_large'),
  422: problemSchema('idempotency_conflict', 'too_many_events'),
};
const SITEMAP_DESCRIPTION = (kind: 'boards' | 'threads') =>
  `Keyset feed of the public ${kind} for sitemaps, the same for every caller: it lists exactly what an anonymous ` +
  `reader can open, whatever bearer the request carries. Each page examines at most 4 × \`limit\` candidate rows, so it ` +
  `may return fewer than \`limit\` items, even none, with a non-null \`next\`. Follow \`next\` until it is ` +
  `\`null\`. \`lastModified\` is the last significant change of what the page shows; a post edit or removal does ` +
  `not advance it.`;
const sessionHeader = { [SESSION_HEADER]: t.String() };
const commandHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const reviseHeaders = t.Object(
  { [IDEMPOTENCY_HEADER]: t.String(), 'if-match': t.Optional(t.String()) },
  { additionalProperties: true },
);
const readSecurity = [{ bearerAuth: [] }, {}];
const writeSecurity = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const subjectReactionKinds: ReadonlySet<string> = new Set(['like', 'love', 'laugh', 'insightful', 'sad']);
const reactionInput = strictContentSchema(ReactionInputSchema);
const reactionResponse = strictContentSchema(ReactionResponseSchema);
const subjectReactionInput = strictContentSchema(SubjectReactionInputSchema);
const subjectReactionResponse = strictContentSchema(SubjectReactionResponseSchema);
const subjectOwnReactionResponse = strictContentSchema(SubjectOwnReactionResponseSchema);
const threadInput = strictContentSchema(ThreadInputSchema);
const postInput = strictContentSchema(PostInputSchema);
const revisionInput = strictContentSchema(RevisionInputSchema);
const threadResponse = strictContentSchema(ThreadResponseSchema);
const postResponse = strictContentSchema(PostResponseSchema);
const boardResponse = strictContentSchema(BoardResponseSchema);
const slowModeInput = t.Object(
  { intervalSeconds: t.Integer({ minimum: 0, maximum: 86400 }) },
  { additionalProperties: false },
);
const slowModeResponse = t.Object(
  {
    intervalSeconds: t.Integer({ minimum: 0, maximum: 86400 }),
    retryAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
    exempt: t.Boolean(),
  },
  { additionalProperties: false },
);
const globalBoardDirectoryQuery = strictContentSchema(GlobalBoardDirectoryQuerySchema);
const globalBoardDirectoryResponse = strictContentSchema(GlobalBoardDirectoryResponseSchema);
const realmBoardsQuery = t.Object(
  {
    cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
    limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
  },
  { additionalProperties: false },
);
const realmBoardsResponse = t.Object(
  { items: t.Array(BoardViewSchema, { maxItems: 100 }), next: t.Union([t.String(), t.Null()]) },
  { additionalProperties: false },
);
const boardCreateInput = t.Object(
  {
    conceptId: t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' }),
    title: t.String({ minLength: 1, maxLength: 1024 }),
    visibility: t.Union([t.Literal('published'), t.Literal('protected'), t.Literal('draft')]),
    purpose: t.Optional(t.Union([t.Literal('discussion'), t.Literal('reviews')])),
  },
  { additionalProperties: false },
);
const boardCreateBody = strictContentSchema(boardCreateInput);
const globalBoardCreateBody = strictContentSchema(
  t.Object(
    {
      ...boardCreateInput.properties,
      visibility: t.Union([t.Literal('published'), t.Literal('protected')]),
      purpose: t.Union([t.Literal('discussion'), t.Literal('reviews')]),
    },
    { additionalProperties: false },
  ),
);
const boardThreadsQuery = strictContentSchema(BoardThreadsQuerySchema);
const boardThreadsResponse = strictContentSchema(BoardThreadsResponseSchema);
const boardThreadPinInput = strictContentSchema(BoardThreadPinInputSchema);
const boardThreadPinResponse = strictContentSchema(BoardThreadPinResponseSchema);
const sitemapQuery = strictContentSchema(SitemapQuerySchema);
const sitemapBoardPage = strictContentSchema(SitemapBoardPageSchema);
const sitemapThreadPage = strictContentSchema(SitemapThreadPageSchema);
const sitemapFailures = { ...readFailures, 400: problemSchema('invalid_request', 'invalid_cursor') };
const subjectThreadsQuery = strictContentSchema(SubjectThreadsQuerySchema);
const subjectThreadsResponse = strictContentSchema(SubjectThreadsResponseSchema);
const authorThreadsQuery = strictContentSchema(AuthorThreadsQuerySchema);
const authorThreadsResponse = strictContentSchema(AuthorThreadsResponseSchema);
const authorPostsQuery = strictContentSchema(AuthorPostsQuerySchema);
const authorPostsResponse = strictContentSchema(AuthorPostsResponseSchema);
const postPageResponse = strictContentSchema(PostPageResponseSchema);
const revisionPageResponse = strictContentSchema(RevisionPageResponseSchema);

/** Bound byte consumption before JSON parsing or entering a command. */
async function parseContentBody(
  { request, contentType }: { request: Request; contentType: string },
  oversized: WeakSet<Request>,
) {
  if (contentType !== 'application/json' || !request.body) throw new ProblemError('invalid_request');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        oversized.add(request);
        return {};
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ProblemError('invalid_request');
  }
}

async function contentOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BoardSlowModeInputError) throw new ProblemError('invalid_request');
    if (error instanceof BoardSlowModeError)
      throw new ProblemError('board_slow_mode', {
        effectStatus: 'not_applied',
        extensions: { retryAt: error.retryAt, intervalSeconds: error.intervalSeconds },
        headers: { 'retry-after': new Date(Math.ceil(Date.parse(error.retryAt) / 1000) * 1000).toUTCString() },
      });
    if (error instanceof ContentUndisclosedError)
      throw new ProblemError('not_found', { effectStatus: 'not_applicable' });
    if (error instanceof DocumentTooLargeError) throw new ProblemError('content_too_large');
    if (error instanceof InvalidDocumentError) throw new ProblemError('invalid_request');
    if (error instanceof InvalidMediaClaimError) throw new ProblemError('invalid_request');
    if (error instanceof MediaUnavailableError) throw new ProblemError('media_unavailable');
    if (error instanceof CommandNotFoundError || error instanceof ReadNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (error instanceof InvalidSitemapCursorError) throw new ProblemError('invalid_cursor');
    if (error instanceof InvalidGlobalBoardDirectoryCursorError) throw new ProblemError('invalid_cursor');
    if (error instanceof BoardCreationInputError) throw new ProblemError('invalid_request');
    if (error instanceof BoardCreationConflictError) throw new ProblemError('conflict');
    if (error instanceof BoardPinLimitError) throw new ProblemError('conflict');
    if (error instanceof ReviewConflictError) throw new ProblemError('conflict');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    if (
      error instanceof TypeError &&
      (error.message === 'Invalid content cursor' || error.message === 'Invalid reaction kind')
    )
      throw new ProblemError('invalid_request');
    throw error;
  }
}

function expectedRevision(header: string | null): string | null {
  if (header === null) return null;
  let value: unknown;
  try {
    [value] = parseItem(header);
  } catch {
    throw new ProblemError('invalid_request');
  }
  if (typeof value !== 'string' || routeOf(value) === null) throw new ProblemError('invalid_request');
  return value;
}

function existingId(id: string): number {
  const route = routeOf(id);
  if (route === null) throw new ProblemError('not_found');
  return route;
}

function requestContext(request: Request, deadline: number) {
  return {
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    deadline,
    requestId: Bun.randomUUIDv7(),
  };
}

function sessionComponent(anchor: AnchoredPosition) {
  return { partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position };
}

export function contentRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  const oversized = new WeakSet<Request>();
  const parseBody = (context: { request: Request; contentType: string }) => parseContentBody(context, oversized);
  const rejectOversized = ({ request }: { request: Request }) => {
    // Elysia wraps parser exceptions as 400. Raise the shared problem in the transform stage,
    // before schema validation, authorization, receipts or command effects.
    if (oversized.delete(request)) throw new ProblemError('content_too_large');
  };
  // This is an internal route+ID point lookup, never disclosure or authorization.
  // The read/command port checks the full current chain before returning any bytes.
  async function containingThread(postId: string, context: ReadContext): Promise<string> {
    const route = existingId(postId);
    if (Date.now() >= context.deadline) throw new ProblemError('deadline_exceeded');
    const row = await withConnection(dependencies.pool, (client) =>
      readContainingThread.run(client, { route, id: postId }),
    );
    if (!row) throw new ProblemError('not_found');
    return row.thread_id;
  }

  async function exactPost(
    threadId: string,
    postId: string,
    context: ReadContext,
    revisionId: string,
    replayedRevisionId?: string,
  ): Promise<Anchored<ItemView>>;
  async function exactPost(threadId: string, postId: string, context: ReadContext): Promise<Anchored<PostEntry>>;
  async function exactPost(
    threadId: string,
    postId: string,
    context: ReadContext,
    revisionId?: string,
    replayedRevisionId?: string,
  ): Promise<Anchored<PostEntry>> {
    if (revisionId !== undefined && existingId(revisionId) !== existingId(postId)) throw new ProblemError('not_found');
    if (replayedRevisionId !== undefined && existingId(replayedRevisionId) !== existingId(postId))
      throw new ProblemError('not_found');
    const read = () => readPost(dependencies, threadId, postId, context, revisionId);
    const result =
      replayedRevisionId === undefined ? await read() : await withReplayedRevision(replayedRevisionId, read);
    if (!result.value) throw new ProblemError('not_found');
    if (revisionId !== undefined && isErasedPlaceholder(result.value))
      throw new Error('An exact post read returned an erased placeholder');
    return { value: result.value, anchor: result.anchor };
  }

  // Protected preflight rejects anonymous callers before validating tuple inputs.
  app.onTransform(({ request }) => {
    if (
      !request.headers.has('authorization') &&
      request.method === 'GET' &&
      new URL(request.url).pathname === customMethod('/v1/sourceFences', 'check')
    )
      throw new AuthenticationError(401, 'Bearer');
  });

  const routes = watchRoutes(
    editionRoutes(
      appealRoutes(
        moderationRoutes(
          reportRoutes(
            documentRoutes(
              mediaImportRoutes(
                mediaModerationRoutes(
                  sourceFenceGovernanceRoutes(sourceFenceRoutes(app, dependencies), dependencies),
                  dependencies,
                ),
                dependencies,
              ),
              dependencies,
            ),
            dependencies,
          ),
          dependencies,
        ),
        dependencies,
      ),
      dependencies,
    ),
    dependencies,
  )
    .get(
      '/v1/boards/:id/slowMode',
      {
        params,
        response: { 200: withHeaders(slowModeResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'board.get_slow_mode',
          'x-action': 'board:read',
          'x-exposure': 'public',
          'x-resource-types': ['content.board'],
          security: readSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            if (!(await readRealmBoard(dependencies, id, context)).value) throw new ProblemError('not_found');
            const value = await readBoardSlowMode(dependencies, actor, id, job.deadline);
            const final = await readRealmBoard(dependencies, id, context);
            if (!final.value) throw new ProblemError('not_found');
            session.record(sessionComponent(final.anchor));
            return value;
          }),
        );
      },
    )
    .put(
      '/v1/boards/:id/slowMode',
      {
        params,
        headers: commandHeaders,
        body: strictContentSchema(slowModeInput),
        response: { 200: withHeaders(slowModeInput, sessionHeader), ...writeFailures },
        detail: {
          operationId: 'board.set_slow_mode',
          'x-action': 'moderation:takedown',
          'x-exposure': 'public',
          'x-resource-types': ['content.board'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        existingId(id);
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await setBoardSlowMode(
              dependencies,
              actor,
              id,
              body.intervalSeconds,
              requestContext(request, job.deadline),
            );
            session.record({ partition: result.partition, epoch: result.epoch, position: result.position });
            return result.value;
          }),
        );
      },
    )
    .get(
      '/v1/boards',
      {
        query: globalBoardDirectoryQuery,
        response: {
          200: withHeaders(globalBoardDirectoryResponse, sessionHeader),
          ...readFailures,
          400: problemSchema('invalid_request', 'invalid_cursor'),
        },
        detail: {
          operationId: 'board.list_global',
          'x-exposure': 'public',
          'x-action': 'board:read',
          security: readSecurity,
          description:
            'Currently public Global boards, independently checked as anonymous for every caller. ' +
            'Examines at most 4 × limit native candidates in (route, board id) order; default limit 20, maximum 100. ' +
            'Sparse or empty pages can have next; follow it until null. Realm boards use the Realm collection.',
        },
      },
      async ({ query, admission, job, session }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listGlobalBoards(
              dependencies,
              { deadline: job.deadline },
              {
                ...(query.purpose === undefined ? {} : { purpose: query.purpose }),
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
              },
            );
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            return { boards: page.boards, next: page.next };
          }),
        ),
    )
    .post(
      '/v1/boards',
      {
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: commandHeaders,
        body: globalBoardCreateBody,
        response: {
          201: withHeaders(boardResponse, { ...sessionHeader, location: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'board.create_global',
          'x-authority-resource-types': ['semantic.context'],
          'x-authority-resource-id': '00000000-0000-8000-8000-000000000000',
          'x-exposure': 'public',
          'x-action': 'board:create',
          'x-resource-types': ['content.board'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await createBoard(dependencies, actor, { realmId: null, ...body }, context);
            const board = await readRealmBoard(dependencies, result.value.boardId, {
              actor,
              deadline: job.deadline,
            });
            if (!board.value) throw new ProblemError('not_found');
            session.record(result);
            session.record(sessionComponent(board.anchor));
            set.status = 201;
            set.headers.location = `/v1/boards/${result.value.boardId}`;
            return { board: board.value };
          }),
        );
      },
    )
    .post(
      '/v1/realms/:realmId/boards',
      {
        params: t.Object({ realmId: t.String() }, { additionalProperties: false }),
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: commandHeaders,
        body: boardCreateBody,
        response: {
          201: withHeaders(boardResponse, { ...sessionHeader, location: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict'),
        },
        detail: {
          operationId: 'board.create',
          'x-authority-resource-types': ['community.realm'],
          'x-exposure': 'public',
          'x-action': 'board:create',
          'x-resource-types': ['content.board'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { realmId }, actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existingId(realmId);
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await createBoard(dependencies, actor, { realmId, ...body }, context);
            const board = await readRealmBoard(dependencies, result.value.boardId, {
              actor,
              deadline: job.deadline,
            });
            if (!board.value) throw new ProblemError('not_found');
            session.record(result);
            session.record(sessionComponent(board.anchor));
            set.status = 201;
            set.headers.location = `/v1/boards/${result.value.boardId}`;
            return { board: board.value };
          }),
        );
      },
    )
    .get(
      '/v1/realms/:realmId/boards',
      {
        params: t.Object({ realmId: t.String() }, { additionalProperties: false }),
        query: realmBoardsQuery,
        response: { 200: withHeaders(realmBoardsResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'board.list',
          'x-exposure': 'public',
          'x-action': 'realm:read',
          security: readSecurity,
        },
      },
      async ({ params: { realmId }, query, actor, admission, job, session }) => {
        existingId(realmId);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listRealmBoards(dependencies, realmId, { actor, deadline: job.deadline }, query);
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            return { items: [...page.items], next: page.next };
          }),
        );
      },
    )
    .post(
      '/v1/threads',
      {
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: commandHeaders,
        body: threadInput,
        response: {
          201: withHeaders(threadResponse, { ...sessionHeader, location: t.String() }),
          ...writeFailures,
          409: problemSchema('conflict', 'media_unavailable', {
            existingThreadId: t.Optional(t.String({ format: 'uuid' })),
          }),
        },
        detail: {
          operationId: 'thread.create',
          description: 'Create a published, draft, or protected thread and opening post.',
          'x-authority-resource-types': ['content.board'],
          'x-exposure': 'public',
          'x-action': 'thread:create',
          'x-resource-types': ['content.thread', 'content.post'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            let result: Awaited<ReturnType<typeof createThread>>;
            try {
              result = await createThread(dependencies, actor, body, context);
            } catch (error) {
              if (!(error instanceof ReviewConflictError)) throw error;
              const row = await withConnection(dependencies.pool, (client) =>
                readLiveReview.run(client, {
                  route: routeOf(actor.accountId)!,
                  board_id: body.boardId,
                  author_id: actor.accountId,
                  subject_id: body.subjectIds[0]!,
                }),
              );
              throw new ProblemError('conflict', {
                ...(row ? { extensions: { existingThreadId: row.thread_id } } : {}),
              });
            }
            const readContext = { actor, deadline: job.deadline };
            const thread = await readThread(dependencies, result.value.threadId, readContext);
            if (!thread.value) throw new ProblemError('not_found');
            // A replay returns the stored outcome. Projecting again would commit a
            // candidate event from the later read watermark.
            if (!result.replayed) {
              await applyBoardCandidate(dependencies.pool, {
                id: thread.value.id,
                boardId: thread.value.boardId,
                createdAt: thread.value.createdAt,
                epoch: thread.anchor.epoch,
                position: thread.anchor.position,
              });
            }
            const post = await exactPost(
              result.value.threadId,
              result.value.itemId,
              readContext,
              result.value.revisionId,
              result.replayed ? result.value.revisionId : undefined,
            );
            session.record(result);
            session.record(sessionComponent(thread.anchor));
            session.record(sessionComponent(post.anchor));
            set.status = 201;
            set.headers.location = `/v1/threads/${result.value.threadId}`;
            return {
              thread: {
                ...thread.value,
                licence: post.value.licence,
                subjectIds: post.value.subjectIds,
                boardId: post.value.boardId,
                firstPost: post.value,
              },
            };
          }),
        );
      },
    )
    .get(
      '/v1/threads/:id',
      {
        params,
        response: { 200: withHeaders(threadResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'thread.get',
          'x-resource-types': ['content.thread'],
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            let authorErasure: AuthorErasureAdmission | undefined;
            const context = { actor, deadline: job.deadline };
            const read = () => readThread(dependencies, id, context);
            const result = await (actor.kind === 'account'
              ? withThreadReadAdmission(async () => {
                  authorErasure = await readAuthorErasureAdmission(dependencies, id, { ...context, actor });
                }, read)
              : read());
            if (!result.value) throw new ProblemError('not_found');
            session.record(sessionComponent(result.anchor));
            const [thread] = await withViewerReactions(dependencies, actor, [result.value], job.deadline);
            if (!thread) throw new ProblemError('not_found');
            const counted = await withReactionCounts(dependencies, [thread], job.deadline);
            const shown = counted.items[0];
            if (!shown) throw new ProblemError('not_found');
            if (actor.kind === 'account') set.headers['cache-control'] = 'private, no-store';
            return { thread: shown, reactionsAsOf: counted.reactionsAsOf, ...(authorErasure ? { authorErasure } : {}) };
          }),
        );
      },
    )
    .post(
      '/v1/threads/:id/posts',
      {
        params,
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: commandHeaders,
        body: postInput,
        response: {
          201: withHeaders(postResponse, sessionHeader),
          ...writeFailures,
          409: problemSchema('media_unavailable'),
        },
        detail: {
          operationId: 'post.create',
          description: 'Create a published, draft, or protected post within an existing thread.',
          'x-authority-resource-types': ['content.thread'],
          'x-exposure': 'public',
          'x-action': 'post:create',
          'x-resource-types': ['content.post'],
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existingId(id);
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await createPost(dependencies, actor, { ...body, threadId: id }, context);
            const post = await exactPost(
              result.value.threadId,
              result.value.itemId,
              { actor, deadline: job.deadline },
              result.value.revisionId,
              result.replayed ? result.value.revisionId : undefined,
            );
            session.record(result);
            session.record(sessionComponent(post.anchor));
            set.status = 201;
            return { post: post.value };
          }),
        );
      },
    )
    .get(
      '/v1/threads/:id/posts',
      {
        params,
        query: ContentPageQuerySchema,
        response: { 200: withHeaders(postPageResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'post.list',
          'x-resource-types': ['content.thread'],
          'x-exposure': 'public',
          'x-action': 'post:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, query, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listThreadPosts(
              dependencies,
              id,
              { actor, deadline: job.deadline },
              query.cursor,
              query.limit ?? 20,
            );
            session.record(sessionComponent(page.anchor));
            const posts = await withViewerReactions(dependencies, actor, page.entries, job.deadline);
            const counted = await withReactionCounts(dependencies, posts, job.deadline);
            return { posts: [...counted.items], next: page.nextCursor, reactionsAsOf: counted.reactionsAsOf };
          }),
        );
      },
    )
    .get(
      '/v1/threads/:id/posts/:postId/location',
      {
        params: t.Object({ id: t.String(), postId: t.String() }, { additionalProperties: false }),
        response: {
          200: withHeaders(
            t.Object({ cursor: t.Union([t.String(), t.Null()]) }, { additionalProperties: false }),
            sessionHeader,
          ),
          ...readFailures,
        },
        detail: { operationId: 'post.locate', 'x-exposure': 'public', 'x-action': 'post:read', security: readSecurity },
      },
      async ({ params: { id, postId }, actor, admission, job, session, set }) => {
        existingId(id);
        existingId(postId);
        set.headers['cache-control'] = 'private, no-store';
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const location = await locateThreadPost(dependencies, id, postId, { actor, deadline: job.deadline });
            session.record(sessionComponent(location.anchor));
            return location.value;
          }),
        );
      },
    )
    .get(
      '/v1/posts/:id',
      {
        params,
        response: {
          200: withHeaders(postResponse, { ...sessionHeader, etag: t.Optional(t.String()) }),
          ...readFailures,
        },
        detail: {
          operationId: 'post.get',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            const post = await exactPost(await containingThread(id, context), id, context);
            session.record(sessionComponent(post.anchor));
            if (!isErasedPlaceholder(post.value)) set.headers.etag = JSON.stringify(post.value.revisionId);
            const [personal] = await withViewerReactions(dependencies, actor, [post.value], job.deadline);
            if (!personal) throw new ProblemError('not_found');
            const counted = await withReactionCounts(dependencies, [personal], job.deadline);
            const shown = counted.items[0];
            if (!shown) throw new ProblemError('not_found');
            if (actor.kind === 'account') set.headers['cache-control'] = 'private, no-store';
            return { post: shown };
          }),
        ),
    )
    .post(
      customMethod('/v1/posts/:id', 'restore'),
      {
        params,
        headers: commandHeaders,
        response: {
          204: withHeaders(t.Void(), sessionHeader),
          409: problemSchema('conflict', { existingThreadId: t.Optional(t.String({ format: 'uuid' })) }),
          ...writeFailures,
        },
        detail: {
          operationId: 'post.restore',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:erase',
          'x-replay-authorization': 'self-account-read',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        await contentOperation(async () => {
          const result = await admission.run('normal', job, async () => {
            try {
              return await restorePost(dependencies, actor, id, requestContext(request, job.deadline));
            } catch (error) {
              if (!(error instanceof ReviewConflictError)) throw error;
              const reference = await readCurrentRestorationConflict(dependencies, id, {
                actor,
                deadline: job.deadline,
              });
              throw new ProblemError('conflict', { ...(reference ? { extensions: reference } : {}) });
            }
          });
          session.record(result);
          set.status = 204;
        });
      },
    )
    .delete(
      '/v1/posts/:id',
      {
        params,
        headers: commandHeaders,
        response: { 204: withHeaders(t.Void(), sessionHeader), ...writeFailures },
        detail: {
          operationId: 'post.erase',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:erase',
          'x-replay-authorization': 'self-account-read',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existingId(id);
        const context = requestContext(request, job.deadline);
        try {
          const result = await admission.run('normal', job, () =>
            softDeletePost(
              { ...dependencies, access: postEraseReceiptAccess(dependencies.access, true) },
              actor,
              { postId: id, reason: 'Author deletion' },
              context,
            ),
          );
          session.record(result);
          set.status = 204;
        } catch (error) {
          if (error instanceof GrantDeniedError) throw new ProblemError('forbidden');
          throw error;
        }
      },
    )
    .post(
      '/v1/posts/:id/revisions',
      {
        params,
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: reviseHeaders,
        body: revisionInput,
        response: {
          200: withHeaders(postResponse, sessionHeader),
          ...writeFailures,
          409: problemSchema('media_unavailable'),
          412: problemSchema('precondition_failed'),
        },
        detail: {
          operationId: 'post.revise',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:revise',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const readContext = { actor, deadline: job.deadline };
            const threadId = await containingThread(id, readContext);
            const result = await revisePost(
              dependencies,
              actor,
              {
                ...body,
                threadId,
                itemId: id,
                expectedRevisionId: expectedRevision(request.headers.get('if-match')),
              },
              context,
            );
            const post = await exactPost(
              result.value.threadId,
              result.value.itemId,
              readContext,
              result.value.revisionId,
              result.replayed ? result.value.revisionId : undefined,
            );
            session.record(result);
            session.record(sessionComponent(post.anchor));
            return { post: post.value };
          }),
        );
      },
    )
    .get(
      '/v1/posts/:id/revisions',
      {
        params,
        query: ContentPageQuerySchema,
        response: { 200: withHeaders(revisionPageResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'post.history',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, query, actor, admission, job, session }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            const threadId = await containingThread(id, context);
            const page = await listPostRevisions(dependencies, threadId, id, context, query.cursor, query.limit ?? 20);
            const posts = [];
            for (const revision of page.entries) posts.push(await exactPost(threadId, id, context, revision.id));
            session.record(sessionComponent(page.anchor));
            for (const post of posts) session.record(sessionComponent(post.anchor));
            return { revisions: posts.map((post) => post.value), next: page.nextCursor };
          }),
        ),
    )
    .get(
      '/v1/posts/:id/revisions/:revisionId',
      {
        params: t.Object({ id: t.String(), revisionId: t.String() }, { additionalProperties: false }),
        // This route historically admitted arbitrary query keys. Only the opt-in is constrained.
        query: t.Object({ editionIdentity: t.Optional(t.Literal('true')) }, { additionalProperties: true }),
        response: {
          200: withHeaders(
            strictContentSchema(
              t.Object(
                { ...PostResponseSchema.properties, editionIdentity: t.Optional(EditionSourceIdentitySchema) },
                { additionalProperties: false },
              ),
            ),
            { ...sessionHeader, 'cache-control': t.Optional(t.String()) },
          ),
          ...readFailures,
        },
        detail: {
          operationId: 'post.revision',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'post:read',
          security: readSecurity,
        },
      },
      async ({ params: { id, revisionId }, query, actor, admission, job, session, set }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            if (query.editionIdentity === 'true') {
              set.headers['cache-control'] = 'private, no-store';
              const result = await readEditionSourceIdentity(dependencies, { postId: id, revisionId }, context);
              session.record(sessionComponent(result.anchor));
              return result.value;
            }
            const post = await exactPost(await containingThread(id, context), id, context, revisionId);
            session.record(sessionComponent(post.anchor));
            return { post: post.value };
          }),
        ),
    )
    .get(
      '/v1/boards/:id/threads',
      {
        params,
        query: BoardThreadsQuerySchema,
        transform: ({ query }) => {
          // Board query failures expose the same generic problem as invalid cursors.
          if ('issues' in boardThreadsQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: withHeaders(boardThreadsResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'board_threads.list',
          'x-resource-types': ['content.board'],
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, query, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listBoardThreads(dependencies, id, { actor, deadline: job.deadline }, query);
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            // Board pages hydrate through discloseThreads, which supplies removed slots.
            return {
              pinnedThreads: [...page.pinnedThreads] as ThreadView[],
              threads: [...page.entries] as ThreadView[],
              next: page.nextCursor,
              rankRefreshedAt: page.rankRefreshedAt,
            };
          }),
        );
      },
    )
    .post(
      '/v1/boards/:id/threads/:threadId/pin',
      {
        params: t.Object({ id: t.String(), threadId: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        parse: [parseBody, 'json'],
        body: boardThreadPinInput,
        response: {
          200: withHeaders(boardThreadPinResponse, sessionHeader),
          409: problemSchema('conflict'),
          ...writeFailures,
        },
        detail: {
          operationId: 'board_thread.set_pin',
          'x-resource-types': ['content.board', 'content.thread'],
          'x-exposure': 'public',
          'x-action': 'moderation:takedown',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id, threadId }, actor, body, request, admission, job, session }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existingId(id);
        existingId(threadId);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await setBoardThreadPin(
              dependencies,
              actor,
              { boardId: id, threadId, pinned: body.pinned },
              requestContext(request, job.deadline),
            );
            session.record(result);
            return result.value;
          }),
        );
      },
    )
    .get(
      '/v1/accounts/:accountId/threads',
      {
        params: t.Object({ accountId: t.String() }, { additionalProperties: false }),
        query: authorThreadsQuery,
        response: { 200: withHeaders(authorThreadsResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'author_threads.list',
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: readSecurity,
        },
      },
      async ({ params: { accountId }, query, actor, admission, job, session }) => {
        existingId(accountId);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listAuthorThreads(
              dependencies,
              accountId,
              { actor, deadline: job.deadline },
              {
                kind: query.kind ?? 'discussion',
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
              },
            );
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            return { threads: [...page.entries], next: page.nextCursor };
          }),
        );
      },
    )
    .get(
      '/v1/accounts/:accountId/posts',
      {
        params: t.Object({ accountId: t.String() }, { additionalProperties: false }),
        query: authorPostsQuery,
        response: { 200: withHeaders(authorPostsResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'author_posts.list',
          'x-exposure': 'public',
          'x-action': 'post:read',
          security: readSecurity,
        },
      },
      async ({ params: { accountId }, query, actor, admission, job, session }) => {
        existingId(accountId);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listAuthorPosts(
              dependencies,
              accountId,
              { actor, deadline: job.deadline },
              {
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
              },
            );
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            return { posts: [...page.entries], next: page.nextCursor };
          }),
        );
      },
    )
    .get(
      '/v1/subjects/:id/threads',
      {
        params,
        query: subjectThreadsQuery,
        response: { 200: withHeaders(subjectThreadsResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'subject_threads.list',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, query, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const page = await listSubjectThreads(
              dependencies,
              id,
              { actor, deadline: job.deadline },
              {
                place: query.place,
                kind: query.kind,
                ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
                ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
              },
            );
            session.record(sessionComponent(page.anchor));
            for (const anchor of page.anchors) session.record(sessionComponent(anchor));
            return { threads: [...page.entries], next: page.nextCursor };
          }),
        );
      },
    )
    .get(
      '/v1/sitemap/boards',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: sitemapBoardPage, ...sitemapFailures },
        detail: {
          operationId: 'sitemap_boards.list',
          description: SITEMAP_DESCRIPTION('boards'),
          'x-exposure': 'public',
          'x-action': 'board:read',
          security: readSecurity,
        },
      },
      async ({ query, admission, job }) =>
        contentOperation(() =>
          admission.run('normal', job, () => listSitemapBoards(dependencies, job.deadline, query)),
        ),
    )
    .get(
      '/v1/sitemap/threads',
      {
        query: SitemapQuerySchema,
        transform: ({ query }) => {
          if ('issues' in sitemapQuery['~standard'].validate(query)) throw new ProblemError('invalid_request');
        },
        response: { 200: sitemapThreadPage, ...sitemapFailures },
        detail: {
          operationId: 'sitemap_threads.list',
          description: SITEMAP_DESCRIPTION('threads'),
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: readSecurity,
        },
      },
      async ({ query, admission, job }) =>
        contentOperation(() =>
          admission.run('normal', job, () => listSitemapThreads(dependencies, job.deadline, query)),
        ),
    )
    .get(
      '/v1/boards/:id',
      {
        params,
        response: { 200: withHeaders(boardResponse, sessionHeader), ...readFailures },
        detail: {
          operationId: 'board.get',
          'x-resource-types': ['content.board'],
          'x-exposure': 'public',
          'x-action': 'board:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await readRealmBoard(dependencies, id, { actor, deadline: job.deadline });
            if (!result.value) throw new ProblemError('not_found');
            session.record(sessionComponent(result.anchor));
            return { board: result.value };
          }),
        );
      },
    )
    .put(
      '/v1/threads/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        body: reactionInput,
        response: { 200: reactionResponse, ...writeFailures },
        detail: {
          operationId: 'thread.set_reaction',
          'x-resource-types': ['content.thread'],
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        await writeReaction(dependencies, actor, 'thread', id, body.kind, request, admission, job, session);
        return { kind: body.kind };
      },
    )
    .delete(
      '/v1/threads/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        response: { 204: t.Void(), ...writeFailures },
        detail: {
          operationId: 'thread.clear_reaction',
          'x-resource-types': ['content.thread'],
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        await writeReaction(dependencies, actor, 'thread', id, null, request, admission, job, session);
        set.status = 204;
      },
    )
    .put(
      '/v1/posts/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        body: reactionInput,
        response: { 200: reactionResponse, ...writeFailures },
        detail: {
          operationId: 'post.set_reaction',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        await writeReaction(dependencies, actor, 'post', id, body.kind, request, admission, job, session);
        return { kind: body.kind };
      },
    )
    .delete(
      '/v1/posts/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        response: { 204: t.Void(), ...writeFailures },
        detail: {
          operationId: 'post.clear_reaction',
          'x-resource-types': ['content.post'],
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        await writeReaction(dependencies, actor, 'post', id, null, request, admission, job, session);
        set.status = 204;
      },
    );

  return routes
    .get(
      '/v1/threads/:id/watch',
      {
        params,
        response: {
          200: withHeaders(t.Object({ watching: t.Boolean() }, { additionalProperties: false }), sessionHeader),
          ...readFailures,
        },
        detail: {
          operationId: 'thread.watch_state',
          'x-exposure': 'public',
          'x-action': 'thread:watch',
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        try {
          const state = await admission.run('normal', job, () =>
            readThreadWatchState(dependencies, actor, id, job.deadline),
          );
          session.record(sessionComponent(state.anchor));
          set.headers['cache-control'] = 'private, no-store';
          return { watching: state.watching };
        } catch (error) {
          if (error instanceof ReadNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .put(
      '/v1/threads/:id/watch',
      {
        params,
        response: { 204: withHeaders(t.Void(), sessionHeader), ...readFailures },
        detail: {
          operationId: 'thread.watch',
          'x-exposure': 'public',
          'x-action': 'thread:watch',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        try {
          const anchor = await admission.run('normal', job, () => watchThread(dependencies, actor, id, job.deadline));
          session.record(sessionComponent(anchor));
          set.status = 204;
        } catch (error) {
          if (error instanceof ReadNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .delete(
      '/v1/threads/:id/watch',
      {
        params,
        response: { 204: t.Void(), ...readFailures },
        detail: {
          operationId: 'thread.unwatch',
          'x-exposure': 'public',
          'x-action': 'thread:watch',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        await admission.run('normal', job, () => unwatchThread(dependencies, actor, id));
        set.status = 204;
      },
    );
}

export function subjectReactionRoutes(routes: ReturnType<typeof createApp>, dependencies: Dependencies) {
  return routes
    .put(
      '/v1/subjects/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        body: subjectReactionInput,
        response: { 200: subjectReactionResponse, ...writeFailures },
        detail: {
          operationId: 'subject.set_reaction',
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, body, request, admission, job, session }) => {
        await writeReaction(dependencies, actor, 'subject', id, body.kind, request, admission, job, session);
        return { kind: body.kind };
      },
    )
    .delete(
      '/v1/subjects/:id/reaction',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: commandHeaders,
        response: { 204: t.Void(), ...writeFailures },
        detail: {
          operationId: 'subject.clear_reaction',
          'x-exposure': 'public',
          'x-action': 'reaction:set',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        await writeReaction(dependencies, actor, 'subject', id, null, request, admission, job, session);
        set.status = 204;
      },
    )
    .get(
      '/v1/subjects/:id/reaction',
      {
        params,
        response: {
          200: withHeaders(subjectOwnReactionResponse, sessionHeader),
          308: withHeaders(SubjectReactionRedirectResponseSchema, { location: t.String() }),
          ...readFailures,
        },
        detail: {
          operationId: 'subject.get_own_reaction',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: readSecurity,
        },
      },
      async ({ params: { id }, actor, admission, job, session, set, request }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        existingId(id);
        const route = routeOf(id);
        if (route === null) throw new ProblemError('not_found');
        const resource = { route, id };
        const check = await accessCheck(
          dependencies.access,
          actor,
          'subject:read',
          { ...resource, eligibility: subjectReadEligibility(resource) },
          { pool: dependencies.pool, deadline: job.deadline },
        );
        const state = await admission.run('normal', job, () =>
          within(job.deadline, () =>
            withConnection(dependencies.pool, async (connection) => {
              const client = deadlineClient(connection, job.deadline);
              try {
                await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
                const partition = await readPartition(client, partitionOf(route));
                const subject = await readSubjectVisibility.run(client, { route, subject_id: id });
                if (!partition || !subject || subject.visibility !== 'visible' || !(await check(client))) {
                  await client.query('COMMIT');
                  return null;
                }
                const redirect = await readSubjectRedirect.run(client, { route, subject_id: id });
                await client.query('COMMIT');
                return { partition, redirect: redirect?.target ?? null };
              } catch (error) {
                try {
                  await connection.query('ROLLBACK');
                } catch (rollbackError) {
                  discardConnection(connection, rollbackError as Error);
                }
                throw error;
              }
            }),
          ),
        );
        if (!state) throw new ProblemError('not_found');
        if (state.redirect) {
          set.status = 308;
          set.headers.location = `/v1/subjects/${state.redirect}/reaction${new URL(request.url).search}`;
          return { redirect: { from: id, to: state.redirect } };
        }
        session.record({
          partition: state.partition.partitionNo,
          epoch: state.partition.epoch,
          position: state.partition.position,
        });
        const viewer = await admission.run('normal', job, () =>
          withViewerReactions(
            { pool: dependencies.pool, access: dependencies.access, tokens: dependencies.tokens },
            actor,
            [{ id }],
            job.deadline,
          ),
        );
        const kind = viewer[0]?.viewerReaction ?? null;
        if (kind !== null && !subjectReactionKinds.has(kind)) throw new TypeError('Invalid subject reaction kind');
        set.headers['cache-control'] = 'no-cache';
        return { kind: kind as SubjectReactionKind | null };
      },
    );
}

async function writeReaction(
  dependencies: Dependencies,
  actor: Actor,
  targetKind: 'thread' | 'post' | 'subject',
  targetId: string,
  kind: ReactionKind | null,
  request: Request,
  admission: { run: (lane: 'normal', job: { deadline: number }, work: () => Promise<unknown>) => Promise<unknown> },
  job: { deadline: number },
  session: { record: (component: { partition: number; epoch: number; position: bigint }) => void },
) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  existingId(targetId);
  const context = requestContext(request, job.deadline);
  const deps = {
    pool: dependencies.pool,
    access: dependencies.access,
    ...(dependencies.realmParticipation === undefined ? {} : { realmParticipation: dependencies.realmParticipation }),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
  };
  const target = { targetKind, targetId };
  await contentOperation(() =>
    admission.run('normal', job, async () => {
      const result =
        kind === null
          ? await clearReaction(deps, actor, target, context)
          : await setReaction(deps, actor, { ...target, kind }, context);
      if (result) session.record(result);
    }),
  );
}
