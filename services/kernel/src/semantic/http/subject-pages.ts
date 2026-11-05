import { t } from 'elysia';
import { ProblemError, problemSchema } from '../../http/problem.ts';
import type { subjectRoutes } from './subjects.ts';
import { PageCursorError } from '../page.ts';
import { GLOBAL_CONTEXT } from '../definitions.ts';
import { globalReadEligibility } from '../eligibility.ts';
import { withReadTransaction } from '../read.ts';
import type { Pool } from 'pg';
import type { SubjectPageFeed } from '../subject-page-feed.ts';

const response = t.Object(
  {
    subjectPages: t.Array(
      t.Object(
        {
          id: t.String({ format: 'uuid' }),
          target: t.Optional(
            t.Union([
              t.Object(
                { family: t.Literal('subject'), subjectId: t.String({ format: 'uuid' }) },
                { additionalProperties: false },
              ),
              t.Object(
                { family: t.Literal('account'), accountId: t.String({ format: 'uuid' }), canonicalPath: t.String() },
                { additionalProperties: false },
              ),
            ]),
          ),
          views: t.Optional(t.Array(t.String())),
          originalLanguage: t.Optional(t.String()),
          lastModified: t.Optional(t.String({ format: 'date-time', pattern: 'Z$' })),
          labels: t.Array(t.Object({ language: t.String(), value: t.String() }, { additionalProperties: false })),
        },
        { additionalProperties: false },
      ),
    ),
    next: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: false },
);

export function subjectPageRoutes(
  app: ReturnType<typeof subjectRoutes>,
  dependencies: { pool: Pool; feed(): SubjectPageFeed },
) {
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
        403: problemSchema('forbidden'),
        503: problemSchema('partition_unavailable', 'overloaded', 'deadline_exceeded'),
      },
      detail: {
        operationId: 'subject_pages.list',
        'x-exposure': 'public',
        'x-action': 'subject:read',
        security: [{ bearerAuth: [] }, {}],
      },
    },
    async ({ query, authorize }) => {
      const check = await authorize({
        route: 0,
        id: GLOBAL_CONTEXT,
        eligibility: globalReadEligibility('subject:read'),
      });
      const allowed = await withReadTransaction(dependencies.pool, check);
      if (!allowed) throw new ProblemError('forbidden');
      try {
        return await dependencies.feed().page(query);
      } catch (error) {
        if (error instanceof PageCursorError) throw new ProblemError('invalid_request');
        throw error;
      }
    },
  );
}
