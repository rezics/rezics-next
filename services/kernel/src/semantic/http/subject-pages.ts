import { t } from 'elysia';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import type { createApp } from '../../http/app.ts';

const response = t.Object(
  {
    subjectPages: t.Array(
      t.Object(
        {
          id: t.String({ format: 'uuid' }),
          lastModified: t.String({ format: 'date-time', pattern: 'Z$' }),
          labels: t.Array(t.Object({ language: t.String(), value: t.String() }, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: false },
);

export function subjectPageRoutes(app: ReturnType<typeof createApp>) {
  return app.get(
    '/v1/subject-pages',
    {
      query: t.Object({
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 1000, multipleOf: 1, default: 20 })),
      }),
      response: {
        200: response,
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        503: problemSchema('semantic_not_ready', 'overloaded', 'deadline_exceeded'),
      },
      detail: {
        operationId: 'subject_pages.list',
        'x-exposure': 'public',
        'x-action': 'subject:read',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    () => {
      throw new ProblemError('semantic_not_ready');
    },
  );
}
