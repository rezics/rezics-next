import { t } from 'elysia';
import type { Pool } from 'pg';
import type { OperationCatalogue } from '@rezics/operations';
import { admitGroup } from '../access/gates/admission.ts';
import type { KernelClock } from '../clock.ts';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { bindOperation } from '../http/operation-adapter.ts';
import { AuthenticationError, type Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createContinueReads } from './continue-reads.ts';
import { continuePageSchema } from './transport-contract.ts';
import type { SearchService } from '../search/service-scope.ts';
import { languageRanges } from '../semantic/language.ts';

const closed = { additionalProperties: false } as const;

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
    operations: OperationCatalogue;
  },
) {
  const { operations, ...runtimeDependencies } = deps;
  let reads: ReturnType<typeof createContinueReads> | undefined;
  const operation = bindOperation(
    operations,
    'library_continue.list',
    'GET',
    {
      query: {
        reference: 'library.continue.query',
        schema: t.Object(
          {
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1, default: 20 })),
            cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
            view: t.Optional(t.Union([t.Literal('BASIC'), t.Literal('FULL')])),
            spaceId: t.Optional(t.String({ format: 'uuid' })),
          },
          closed,
        ),
      },
      response: {
        reference: 'library.continue.page',
        schema: {
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
        set.headers['cache-control'] = 'private, no-store';
        // Check the original URL before query coercion can discard unknown fields.
        for (const name of new URL(request.url).searchParams.keys())
          if (name !== 'limit' && name !== 'cursor' && name !== 'view' && name !== 'spaceId')
            throw new ProblemError('invalid_request');
        if (new URL(request.url).searchParams.getAll('spaceId').length > 1) throw new ProblemError('invalid_request');
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
          ...runtimeDependencies,
          actor,
          group: 'reading_progress',
          clientAction: 'progress_session:list',
          deadline: job.deadline,
        });
        reads ??= createContinueReads({ ...runtimeDependencies, access: runtimeDependencies.access() });
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
