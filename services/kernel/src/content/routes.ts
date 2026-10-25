import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { withConnection } from '../database/pool.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { sourceFenceRoutes } from './source-fence-routes.ts';
import {
  ContentForbiddenError,
  ContentNotFoundError as CommandNotFoundError,
  createPost,
  createThread,
  revisePost,
  type ContentCommandDependencies,
} from './commands.ts';
import { DocumentTooLargeError, InvalidDocumentError, MAX_DOCUMENT_BYTES } from './document.ts';
import type { AnchoredPosition, ReadContext } from './model.ts';
import type { ContentRuntime } from './runtime.ts';
import { sourceFenceGovernanceRoutes } from './source-fence-governance-routes.ts';
import {
  ContentNotFoundError as ReadNotFoundError,
  listPostRevisions,
  listThreadPosts,
  readBoard,
  readPost,
  readThread,
  type ContentReadDependencies,
} from './reads.ts';
import {
  BoardResponseSchema,
  ContentPageQuerySchema,
  PostPageResponseSchema,
  RevisionPageResponseSchema,
  PostInputSchema,
  PostResponseSchema,
  RevisionInputSchema,
  strictContentSchema,
  ThreadInputSchema,
  ThreadResponseSchema,
} from './schemas.ts';

export type Dependencies = ContentCommandDependencies & ContentReadDependencies & ContentRuntime;
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
  429: problemSchema('rate_limited'),
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
const sessionHeader = { [SESSION_HEADER]: t.String() };
const commandHeaders = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const readSecurity = [{ bearerAuth: [] }, {}];
const writeSecurity = [{ bearerAuth: [] }];
const writeRate = defineRateLimit({ family: 'write', units: 1 });
const threadInput = strictContentSchema(ThreadInputSchema);
const postInput = strictContentSchema(PostInputSchema);
const revisionInput = strictContentSchema(RevisionInputSchema);
const threadResponse = strictContentSchema(ThreadResponseSchema);
const postResponse = strictContentSchema(PostResponseSchema);
const boardResponse = strictContentSchema(BoardResponseSchema);
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
    if (error instanceof DocumentTooLargeError) throw new ProblemError('content_too_large');
    if (error instanceof InvalidDocumentError) throw new ProblemError('invalid_request');
    if (error instanceof CommandNotFoundError || error instanceof ReadNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof ContentForbiddenError) throw new ProblemError('forbidden');
    if (error instanceof TypeError && error.message === 'Invalid content cursor')
      throw new ProblemError('invalid_request');
    throw error;
  }
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
    const result = await withConnection(dependencies.pool, (client) =>
      client.query<{ thread_id: string }>('SELECT thread_id FROM content.post WHERE route = $1 AND post_id = $2', [
        route,
        postId,
      ]),
    );
    if (!result.rows[0]) throw new ProblemError('not_found');
    return result.rows[0].thread_id;
  }

  async function exactPost(threadId: string, postId: string, context: ReadContext, revisionId?: string) {
    if (revisionId !== undefined && existingId(revisionId) !== existingId(postId)) throw new ProblemError('not_found');
    const result = await readPost(dependencies, threadId, postId, context, revisionId);
    if (!result.value) throw new ProblemError('not_found');
    return { value: result.value, anchor: result.anchor };
  }

  return sourceFenceGovernanceRoutes(sourceFenceRoutes(app, dependencies), dependencies)
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
        },
        detail: {
          operationId: 'thread.create',
          'x-action': 'thread:create',
          'x-rate-limit': writeRate,
          security: writeSecurity,
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        const context = requestContext(request, job.deadline);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await createThread(dependencies, actor, body, context);
            const readContext = { actor, deadline: job.deadline };
            const thread = await readThread(dependencies, result.value.threadId, readContext);
            if (!thread.value) throw new ProblemError('not_found');
            const post = await exactPost(
              result.value.threadId,
              result.value.itemId,
              readContext,
              result.value.revisionId,
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
        detail: { operationId: 'thread.get', 'x-action': 'thread:read', security: readSecurity },
      },
      async ({ params: { id }, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await readThread(dependencies, id, { actor, deadline: job.deadline });
            if (!result.value) throw new ProblemError('not_found');
            session.record(sessionComponent(result.anchor));
            return { thread: result.value };
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
        response: { 201: withHeaders(postResponse, sessionHeader), ...writeFailures },
        detail: {
          operationId: 'post.create',
          'x-action': 'post:create',
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
        detail: { operationId: 'post.list', 'x-action': 'post:read', security: readSecurity },
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
            return { posts: [...page.entries], next: page.nextCursor };
          }),
        );
      },
    )
    .get(
      '/v1/posts/:id',
      {
        params,
        response: { 200: withHeaders(postResponse, sessionHeader), ...readFailures },
        detail: { operationId: 'post.get', 'x-action': 'post:read', security: readSecurity },
      },
      async ({ params: { id }, actor, admission, job, session }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            const post = await exactPost(await containingThread(id, context), id, context);
            session.record(sessionComponent(post.anchor));
            return { post: post.value };
          }),
        ),
    )
    .post(
      '/v1/posts/:id/revisions',
      {
        params,
        parse: [parseBody, 'json'],
        transform: rejectOversized,
        headers: commandHeaders,
        body: revisionInput,
        response: { 200: withHeaders(postResponse, sessionHeader), ...writeFailures },
        detail: {
          operationId: 'post.revise',
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
            const result = await revisePost(dependencies, actor, { ...body, threadId, itemId: id }, context);
            const post = await exactPost(
              result.value.threadId,
              result.value.itemId,
              readContext,
              result.value.revisionId,
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
        detail: { operationId: 'post.history', 'x-action': 'post:read', security: readSecurity },
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
        response: { 200: withHeaders(postResponse, sessionHeader), ...readFailures },
        detail: { operationId: 'post.revision', 'x-action': 'post:read', security: readSecurity },
      },
      async ({ params: { id, revisionId }, actor, admission, job, session }) =>
        contentOperation(() =>
          admission.run('normal', job, async () => {
            const context = { actor, deadline: job.deadline };
            const post = await exactPost(await containingThread(id, context), id, context, revisionId);
            session.record(sessionComponent(post.anchor));
            return { post: post.value };
          }),
        ),
    )
    .get(
      '/v1/boards/:id',
      {
        params,
        response: { 200: withHeaders(boardResponse, sessionHeader), ...readFailures },
        detail: { operationId: 'board.get', 'x-action': 'board:read', security: readSecurity },
      },
      async ({ params: { id }, actor, admission, job, session }) => {
        existingId(id);
        return contentOperation(() =>
          admission.run('normal', job, async () => {
            const result = await readBoard(dependencies, id, { actor, deadline: job.deadline });
            if (!result.value) throw new ProblemError('not_found');
            session.record(sessionComponent(result.anchor));
            return { board: result.value };
          }),
        );
      },
    );
}
