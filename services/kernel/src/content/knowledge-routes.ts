import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import { IDEMPOTENCY_HEADER, SESSION_HEADER } from '@rezics/operations/protocol';
import { memoizedValue } from '../memoized.ts';
import { AuthenticationError } from '../access/contract/authentication.ts';
import { GrantDeniedError } from '../access/contract/index.ts';
import { ProblemError } from '../http/problem-error.ts';
import { problemSchema } from '../http/problem-schema.ts';
import { customMethod, defineRateLimit } from '../http/route-metadata.ts';
import { idempotencyKeyOf } from '../http/idempotency-key.ts';
import { contentRequestId } from './adapters/bind.ts';
import type { hostedChapterRoutes } from './hosted-chapters-routes.ts';
import { strictContentSchema } from './schema-validation.ts';
import { ContentForbiddenError, RevisionPreconditionError } from './commands.ts';
import { ContentNotFoundError as ReadNotFoundError } from './reads.ts';
import { DocumentTooLargeError, InvalidDocumentError } from './document.ts';
import {
  KnowledgeInvalidCursorError,
  KnowledgeInvalidInputError,
  KnowledgeNotFoundError,
  KnowledgeStaleCursorError,
  type KnowledgeDependencies,
} from './knowledge-model.ts';
import type { AnchoredPosition } from './model.ts';
import {
  createKnowledgeDocument,
  createKnowledgeNotebook,
  reviseKnowledgeDocument,
  setKnowledgePublication,
} from './knowledge-commands.ts';
import {
  readKnowledgeOutline,
  readKnowledgeOwnedNotebooks,
  readKnowledgePrivateDocument,
  readKnowledgePublicDocument,
} from './knowledge-reads.ts';
import {
  KnowledgeCommandResponseSchema,
  KnowledgeDocumentCreateSchema,
  KnowledgeDocumentReviseSchema,
  KnowledgeExactReadQuerySchema,
  KnowledgeIdSchema,
  KnowledgeNotebookCreateSchema,
  KnowledgeOutlinePageQuerySchema,
  KnowledgeOutlineSchema,
  KnowledgeOwnedNotebooksSchema,
  KnowledgePageQuerySchema,
  KnowledgePrivateDocumentSchema,
  KnowledgePublicationSchema,
  KnowledgePublicDocumentSchema,
} from './knowledge-schemas.ts';

const headers = t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true });
const responseHeaders = { [SESSION_HEADER]: t.String(), 'cache-control': t.String() };
function idParams() {
  return memoizedValue(idParams, () => t.Object({ id: KnowledgeIdSchema }, { additionalProperties: false }));
}
function privateParams() {
  return memoizedValue(privateParams, () =>
    t.Object(
      { accountId: KnowledgeIdSchema, notebookId: KnowledgeIdSchema, documentId: KnowledgeIdSchema },
      { additionalProperties: false },
    ),
  );
}
function accountParams() {
  return memoizedValue(accountParams, () =>
    t.Object({ accountId: KnowledgeIdSchema }, { additionalProperties: false }),
  );
}
function notebookParams() {
  return memoizedValue(notebookParams, () =>
    t.Object({ accountId: KnowledgeIdSchema, notebookId: KnowledgeIdSchema }, { additionalProperties: false }),
  );
}
const readSecurity: Record<string, string[]>[] = [{}, { bearerAuth: [] }];
const writeSecurity = [{ bearerAuth: [] }];
const writeRate = () => defineRateLimit({ family: 'write', units: 1 });
const sessionComponent = (anchor: AnchoredPosition) => ({
  partition: anchor.partition.partitionNo,
  epoch: anchor.epoch,
  position: anchor.position,
});
function failures() {
  return memoizedValue(failures, () => ({
    400: problemSchema('invalid_request', 'invalid_cursor'),
    401: problemSchema('authentication_required', 'invalid_credentials'),
    403: problemSchema('forbidden', 'platform_closed'),
    404: problemSchema('not_found'),
    412: problemSchema('precondition_failed'),
    409: problemSchema('stale_cursor'),
    413: problemSchema('content_too_large'),
    422: problemSchema('idempotency_conflict', 'too_many_events'),
    429: problemSchema('rate_limited'),
    500: problemSchema('internal_error'),
    503: problemSchema(
      'overloaded',
      'deadline_exceeded',
      'partition_unavailable',
      'transaction_retry_exhausted',
      'dependency_unavailable',
      'rate_limit_unavailable',
    ),
  }));
}

async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof KnowledgeNotFoundError || error instanceof ReadNotFoundError)
      throw new ProblemError('not_found');
    if (error instanceof KnowledgeInvalidInputError || error instanceof InvalidDocumentError)
      throw new ProblemError('invalid_request');
    if (error instanceof KnowledgeInvalidCursorError) throw new ProblemError('invalid_cursor');
    if (error instanceof KnowledgeStaleCursorError) throw new ProblemError('stale_cursor');
    if (error instanceof DocumentTooLargeError) throw new ProblemError('content_too_large');
    if (error instanceof ContentForbiddenError || error instanceof GrantDeniedError)
      throw new ProblemError('forbidden');
    if (error instanceof RevisionPreconditionError) throw new ProblemError('precondition_failed');
    throw error;
  }
}

function commandContext(request: Request, deadline: number) {
  return {
    deadline,
    idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
    requestId: contentRequestId(),
  };
}

function requireAccount(actor: import('../request/access.ts').Actor) {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  return actor;
}

/** Native private authoring and exact public document reads. Search candidates never grant current disclosure. */
export function knowledgeRoutes(app: ReturnType<typeof hostedChapterRoutes>, deps: KnowledgeDependencies) {
  app.wrap((handle) => async (request) => {
    const response = await handle(request);
    const path = new URL(request.url).pathname;
    if (path.startsWith('/v1/knowledge/') || /^\/v1\/accounts\/[^/]+\/knowledge(?:\/|$)/.test(path))
      response.headers.set('cache-control', 'private, no-store');
    return response;
  });

  return app
    .get(
      '/v1/accounts/:accountId/knowledge/notebooks',
      {
        params: accountParams(),
        query: strictContentSchema(KnowledgePageQuerySchema),
        response: {
          200: withHeaders(strictContentSchema(KnowledgeOwnedNotebooksSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_notebook.owned_list',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: writeSecurity,
        },
      },
      async ({ params: { accountId }, query, actor, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            readKnowledgeOwnedNotebooks(deps, accountId, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors) session.record(sessionComponent(anchor));
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/accounts/:accountId/knowledge/notebooks/:notebookId/outline',
      {
        params: notebookParams(),
        query: strictContentSchema(KnowledgeOutlinePageQuerySchema),
        response: {
          200: withHeaders(strictContentSchema(KnowledgeOutlineSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_notebook.outline',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: writeSecurity,
        },
      },
      async ({ params: { accountId, notebookId }, query, actor, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            readKnowledgeOutline(deps, accountId, notebookId, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors) session.record(sessionComponent(anchor));
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/knowledge/documents/:id',
      {
        params: idParams(),
        query: strictContentSchema(KnowledgeExactReadQuerySchema),
        response: {
          200: withHeaders(strictContentSchema(KnowledgePublicDocumentSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_document.public_read',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          'x-resource-types': ['semantic.subject'],
          security: readSecurity,
        },
      },
      async ({ params: { id }, query, actor, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            readKnowledgePublicDocument(deps, id, query, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors) session.record(sessionComponent(anchor));
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .get(
      '/v1/accounts/:accountId/knowledge/notebooks/:notebookId/documents/:documentId',
      {
        params: privateParams(),
        query: strictContentSchema(t.Object({}, { additionalProperties: false })),
        response: {
          200: withHeaders(strictContentSchema(KnowledgePrivateDocumentSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_document.private_read',
          'x-exposure': 'public',
          'x-action': 'account:read',
          security: writeSecurity,
        },
      },
      async ({ params: { accountId, notebookId, documentId }, actor, admission, job, session, set }) => {
        const result = await operation(() =>
          admission.run('normal', job, () =>
            readKnowledgePrivateDocument(deps, accountId, notebookId, documentId, { actor, deadline: job.deadline }),
          ),
        );
        for (const anchor of result.anchors) session.record(sessionComponent(anchor));
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      '/v1/knowledge/notebooks',
      {
        headers,
        body: strictContentSchema(KnowledgeNotebookCreateSchema),
        response: {
          201: withHeaders(strictContentSchema(KnowledgeCommandResponseSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_notebook.create',
          'x-exposure': 'public',
          'x-action': 'account:update',
          'x-rate-limit': writeRate(),
          security: writeSecurity,
        },
      },
      async ({ actor, body, request, admission, job, session, set }) => {
        requireAccount(actor);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            createKnowledgeNotebook(deps, actor, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      '/v1/knowledge/notebooks/:id/documents',
      {
        params: idParams(),
        headers,
        body: strictContentSchema(KnowledgeDocumentCreateSchema),
        response: {
          201: withHeaders(strictContentSchema(KnowledgeCommandResponseSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_document.create',
          'x-exposure': 'public',
          'x-action': 'account:update',
          'x-rate-limit': writeRate(),
          security: writeSecurity,
        },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        requireAccount(actor);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            createKnowledgeDocument(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.status = 201;
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/knowledge/documents/:id/revisions', 'revise'),
      {
        params: idParams(),
        headers,
        body: strictContentSchema(KnowledgeDocumentReviseSchema),
        response: {
          200: withHeaders(strictContentSchema(KnowledgeCommandResponseSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_document.revise',
          'x-exposure': 'public',
          'x-action': 'account:update',
          'x-rate-limit': writeRate(),
          security: writeSecurity,
        },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        requireAccount(actor);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            reviseKnowledgeDocument(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    )
    .post(
      customMethod('/v1/knowledge/documents/:id/publication', 'select'),
      {
        params: idParams(),
        headers,
        body: strictContentSchema(KnowledgePublicationSchema),
        response: {
          200: withHeaders(strictContentSchema(KnowledgeCommandResponseSchema), responseHeaders),
          ...failures(),
        },
        detail: {
          operationId: 'knowledge_document.select_publication',
          'x-exposure': 'public',
          'x-action': 'account:update',
          'x-rate-limit': writeRate(),
          security: writeSecurity,
        },
      },
      async ({ actor, params: { id }, body, request, admission, job, session, set }) => {
        requireAccount(actor);
        const result = await operation(() =>
          admission.run('normal', job, () =>
            setKnowledgePublication(deps, actor, id, body, commandContext(request, job.deadline)),
          ),
        );
        session.record(result);
        set.headers['cache-control'] = 'private, no-store';
        return result.value;
      },
    );
}
