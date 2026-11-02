import { t } from 'elysia';
import type { Pool } from 'pg';
import { admitGroup } from '../access/gates/admission.ts';
import type { KernelClock } from '../clock.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createContinueReads } from './continue-reads.ts';
import { sessionSchema } from './progress-routes.ts';
import type { SearchService } from '../search/service-scope.ts';
import { SubjectSummarySchema } from '../semantic/http/summaries.ts';
import { languageRanges } from '../semantic/language.ts';

const closed = { additionalProperties: false } as const;
const nullableString = t.Union([t.String(), t.Null()]);

export const continuePageSchema = t.Object(
  {
    subjects: t.Array(
      t.Object(
        {
          subjectId: t.String({ format: 'uuid' }),
          state: nullableString,
          lastActivityAt: t.String(),
          activeProgressSession: t.Union([sessionSchema, t.Null()]),
          subject: t.Optional(t.Union([SubjectSummarySchema, t.Null()])),
        },
        closed,
      ),
    ),
    next: nullableString,
  },
  closed,
);

/** Pure Continue transport, using the same native owner/source runtime as common Collections. */
export function continueRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: {
    pool: Pool;
    access: () => Access;
    clock: KernelClock;
    tokens: KeyRing;
    routeKey?: Uint8Array;
    search?: SearchService;
  },
) {
  let reads: ReturnType<typeof createContinueReads> | undefined;
  return app.get(
    '/v1/libraryContinue',
    {
      query: t.Object(
        {
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
          cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
          view: t.Optional(t.Union([t.Literal('BASIC'), t.Literal('FULL')])),
          spaceId: t.Optional(t.String({ format: 'uuid' })),
        },
        closed,
      ),
      transform: ({ request, set }) => {
        set.headers['cache-control'] = 'private, no-store';
        // Check the original URL before query coercion can discard unknown fields.
        for (const name of new URL(request.url).searchParams.keys())
          if (name !== 'limit' && name !== 'cursor' && name !== 'view' && name !== 'spaceId')
            throw new ProblemError('invalid_request');
        if (new URL(request.url).searchParams.getAll('spaceId').length > 1)
          throw new ProblemError('invalid_request');
      },
      response: {
        200: continuePageSchema,
        400: problemSchema('invalid_request', 'invalid_cursor'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden', 'platform_closed'),
        409: problemSchema('stale_cursor'),
        503: problemSchema(
          'semantic_not_ready',
          'dependency_unavailable',
          'overloaded',
          'partition_unavailable',
          'transaction_retry_exhausted',
          'deadline_exceeded',
        ),
      },
      detail: {
        operationId: 'library_continue.list',
        'x-action': 'library_entry:list',
        'x-exposure': 'gate:personal_library',
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, query, admission, job, request }) => {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      if (!actor.scopes.includes('library_entry:list') || !actor.scopes.includes('progress_session:list'))
        throw new ProblemError('forbidden', {
          headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
        });
      return admission.run('normal', job, async () => {
        await admitGroup({
          ...deps,
          actor,
          group: 'reading_progress',
          clientAction: 'progress_session:list',
          deadline: job.deadline,
        });
        reads ??= createContinueReads({ ...deps, access: deps.access() });
        return reads.list(
          actor,
          query,
          job.deadline,
          query.view === 'FULL' ? languageRanges(request.headers.get('accept-language')) : [],
        );
      });
    },
  );
}
