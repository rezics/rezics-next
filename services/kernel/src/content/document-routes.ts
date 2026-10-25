import { withHeaders } from '@elysia/openapi';
import { DocumentSnapshotSchema } from '@rezics/document';
import { BatchReferenceSchema, SourceSchema } from '@rezics/definitions/bulk';
import { t } from 'elysia';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { SESSION_HEADER } from '../http/request.ts';
import type { mediaImportRoutes } from './media-import-routes.ts';
import { strictContentSchema } from './schemas.ts';
import { readDocument, type DocumentReadDependencies, type DocumentView } from './document-read.ts';

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
const response = t.Unsafe<{ document: DocumentView }>(
  t.Object(
    {
      document: t.Union([
        t.Object(
          { ...metadata, availability: t.Literal('available'), body: DocumentSnapshotSchema },
          { additionalProperties: false },
        ),
        t.Object({ ...metadata, availability: t.Literal('erased'), body: t.Null() }, { additionalProperties: false }),
      ]),
    },
    { additionalProperties: false },
  ),
);

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
          return { document: result.document };
        });
      },
    );
}
