import { memoizedValue } from '../memoized.ts';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { ProblemError, problemSchema } from '../http/problem.ts';
import type { Access } from '../request/access.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { readManagedErasureStatus, type ManagedErasureStatus } from './erasure-status-read.ts';
import { ERASURE_PARTICIPANTS } from './erasure.ts';

const closed = { additionalProperties: false } as const;
export function managedErasureStatusSchema() {
  return memoizedValue(managedErasureStatusSchema, () =>
    t.Unsafe<ManagedErasureStatus>(
      t.Object(
        {
          accountId: t.String({ format: 'uuid' }),
          state: t.Union([t.Literal('pending'), t.Literal('retention-outstanding'), t.Literal('complete')]),
          at: t.String({ format: 'date-time' }),
          completedAt: t.Union([t.String({ format: 'date-time' }), t.Null()]),
          pendingParticipants: t.Array(t.Union(ERASURE_PARTICIPANTS[1].map((name) => t.Literal(name))), {
            maxItems: ERASURE_PARTICIPANTS[1].length,
            uniqueItems: true,
          }),
          retentionOutstanding: t.Boolean(),
          lateItems: t.Boolean(),
          effectsFrontier: t.Boolean(),
        },
        closed,
      ),
    ),
  );
}

export function erasureStatusRoutes(
  app: ReturnType<typeof definitionRoutes>,
  deps: { pool: Pool; access: () => Access; clock?: () => Date },
) {
  return app.get(
    '/v1/accounts/:accountId/erasureStatus',
    {
      params: t.Object({ accountId: t.String({ format: 'uuid' }) }, closed),
      response: {
        200: managedErasureStatusSchema(),
        400: problemSchema('invalid_request'),
        401: problemSchema('authentication_required', 'invalid_credentials'),
        403: problemSchema('forbidden', 'platform_closed', 'account_suspended'),
        404: problemSchema('not_found'),
        503: problemSchema(
          'dependency_unavailable',
          'partition_unavailable',
          'deadline_exceeded',
          'overloaded',
          'transaction_retry_exhausted',
        ),
      },
      detail: {
        operationId: 'account.read_erasure_status',
        'x-action': 'account:read_erasure',
        'x-exposure': 'gate:account_erasure',
        security: [{ bearerAuth: [] }],
      },
    },
    async ({ actor, params, job, admission, set }) => {
      set.headers['cache-control'] = 'private, no-store';
      const value = await admission.run('normal', job, () =>
        readManagedErasureStatus({ ...deps, access: deps.access() }, actor, params, { deadline: job.deadline }),
      );
      if (value === null) throw new ProblemError('not_found');
      return value;
    },
  );
}
