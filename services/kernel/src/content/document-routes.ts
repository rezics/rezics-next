import { withHeaders } from '@elysia/openapi';
import { DocumentSnapshotSchema } from '@rezics/document';
import { BatchReferenceSchema, SourceSchema } from '@rezics/definitions/bulk';
import { t } from 'elysia';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { defineRateLimit } from '../http/rate-limit.ts';
import { IDEMPOTENCY_HEADER, idempotencyKeyOf, SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError } from '../request/access.ts';
import type { mediaImportRoutes } from './media-import-routes.ts';
import { strictContentSchema } from './schemas.ts';
import { readDocument, type DocumentReadDependencies, type DocumentView } from './document-read.ts';
import { eraseAuthoredField } from './authored-fields.ts';
import { ContentNotFoundError } from './commands.ts';
import { routeOf } from '../route/route.ts';

export type PublicDocumentView =
  | Omit<Extract<DocumentView, { origin: 'import' }>, 'origin'>
  | Extract<DocumentView, { origin: 'account' }>;

const eraseFailures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  403: problemSchema('forbidden'),
  404: problemSchema('not_found'),
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
};
const sessionHeader = { [SESSION_HEADER]: t.String() };
const writeRate = defineRateLimit({ family: 'write', units: 1 });

export function publicDocument(document: DocumentView): PublicDocumentView {
  if (document.origin === 'account') return document;
  const { origin: _origin, ...imported } = document;
  return imported;
}

const metadata = {
  id: t.String({ format: 'uuid' }),
  subjectId: t.String({ format: 'uuid' }),
  candidateId: t.String({ format: 'uuid' }),
  revision: t.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  source: t.Object(
    {
      ...SourceSchema.properties,
      field_group: t.Literal('summary'),
      references: t.Array(BatchReferenceSchema, { maxItems: 128 }),
    },
    { additionalProperties: false },
  ),
  rights: t.Object(
    { license: t.String(), obligations: t.Array(t.String()), attribution: t.String() },
    { additionalProperties: false },
  ),
  language: t.String(),
  digest: t.String({ pattern: '^[0-9a-f]{64}$' }),
};
const authoredMetadata = {
  id: metadata.id,
  subjectId: metadata.subjectId,
  candidateId: metadata.candidateId,
  revision: metadata.revision,
  origin: t.Literal('account'),
  author: t.String({ format: 'uuid' }),
  licence: t.String(),
  language: metadata.language,
  digest: metadata.digest,
};
export const PublicDocumentViewSchema = t.Unsafe<PublicDocumentView>(
  t.Union([
    t.Object(
      { ...metadata, availability: t.Literal('available'), body: DocumentSnapshotSchema },
      { additionalProperties: false },
    ),
    t.Object({ ...metadata, availability: t.Literal('erased'), body: t.Null() }, { additionalProperties: false }),
    t.Object(
      { ...authoredMetadata, availability: t.Literal('available'), body: DocumentSnapshotSchema },
      { additionalProperties: false },
    ),
  ]),
);
const response = t.Object({ document: PublicDocumentViewSchema }, { additionalProperties: false });

export function documentRoutes(app: ReturnType<typeof mediaImportRoutes>, dependencies: DocumentReadDependencies) {
  return app
    .onRequest(({ request, set }) => {
      if (/^\/v1\/documents\/[^/]+$/.test(new URL(request.url).pathname))
        set.headers['cache-control'] = 'private, no-store';
    })
    .get(
      '/v1/documents/:id',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        query: t.Object({}, { additionalProperties: false }),
        headers: t.Object({ [SESSION_HEADER]: t.Optional(t.String()) }, { additionalProperties: true }),
        response: {
          200: withHeaders(strictContentSchema(response), {
            [SESSION_HEADER]: t.String(),
            'cache-control': t.String(),
          }),
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
        },
        detail: {
          operationId: 'document.get',
          'x-exposure': 'public',
          'x-action': 'subject:read',
          security: [{ bearerAuth: [] }, {}],
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        return admission.run('normal', job, async () => {
          const result = await readDocument(dependencies, id, { actor, deadline: job.deadline });
          if (!result) throw new ProblemError('not_found');
          for (const anchor of result.anchors)
            session.record({ partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position });
          return { document: publicDocument(result.document) };
        });
      },
    )
    .delete(
      '/v1/documents/:id',
      {
        params: t.Object({ id: t.String() }, { additionalProperties: false }),
        headers: t.Object({ [IDEMPOTENCY_HEADER]: t.String() }, { additionalProperties: true }),
        response: { 204: withHeaders(t.Void(), sessionHeader), ...eraseFailures },
        detail: {
          operationId: 'document.erase',
          'x-exposure': 'public',
          'x-action': 'document:erase',
          'x-rate-limit': writeRate,
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, request, admission, job, session, set }) => {
        if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
        if (routeOf(id) === null) throw new ProblemError('not_found');
        try {
          const result = await admission.run('normal', job, () =>
            eraseAuthoredField(dependencies, actor, id, {
              idempotencyKey: idempotencyKeyOf(request.headers.get(IDEMPOTENCY_HEADER)),
              deadline: job.deadline,
              requestId: Bun.randomUUIDv7(),
            }),
          );
          if (!result) throw new ProblemError('not_found');
          session.record(result);
          set.status = 204;
        } catch (error) {
          if (error instanceof ContentNotFoundError || error instanceof GrantDeniedError)
            throw new ProblemError('not_found');
          throw error;
        }
      },
    );
}
