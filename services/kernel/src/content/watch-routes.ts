import { withHeaders } from '@elysia/openapi';
import { t } from 'elysia';
import type { Pool } from 'pg';
import { ProblemError, problemSchema } from '../http/problem.ts';
import { SESSION_HEADER } from '../http/request.ts';
import { AuthenticationError, type Access, type Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { definitionRoutes } from '../semantic/http/definitions.ts';
import { ContentNotFoundError } from './reads.ts';
import { readThreadWatchState, unwatchThread, watchThread } from './watch.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock?: () => Date };
const params = t.Object({ id: t.String() }, { additionalProperties: false });
const sessionHeader = { [SESSION_HEADER]: t.String() };
const response = t.Object({ watching: t.Boolean() }, { additionalProperties: false });
const failures = {
  400: problemSchema('invalid_request'),
  401: problemSchema('authentication_required', 'invalid_credentials'),
  404: problemSchema('not_found'),
  500: problemSchema('internal_error'),
  503: problemSchema('overloaded', 'deadline_exceeded', 'partition_unavailable', 'transaction_retry_exhausted'),
};

function requireAccount(actor: Actor): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
}

function sessionComponent(anchor: { partition: { partitionNo: number }; epoch: number; position: bigint }) {
  return { partition: anchor.partition.partitionNo, epoch: anchor.epoch, position: anchor.position };
}

/** The state belongs only to the caller; no route returns watcher identities or counts. */
export function threadWatchRoutes(app: ReturnType<typeof definitionRoutes>, dependencies: Dependencies) {
  return app
    .get(
      '/v1/threads/:id/watch',
      {
        params,
        response: { 200: withHeaders(response, sessionHeader), ...failures },
        detail: {
          operationId: 'thread.watch_state',
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        requireAccount(actor);
        try {
          const state = await admission.run('normal', job, () =>
            readThreadWatchState(dependencies, actor, id, job.deadline),
          );
          session.record(sessionComponent(state.anchor));
          set.headers['cache-control'] = 'private, no-store';
          return { watching: state.watching };
        } catch (error) {
          if (error instanceof ContentNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .put(
      '/v1/threads/:id/watch',
      {
        params,
        response: { 204: withHeaders(t.Void(), sessionHeader), ...failures },
        detail: {
          operationId: 'thread.watch',
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job, session, set }) => {
        requireAccount(actor);
        try {
          const anchor = await admission.run('normal', job, () => watchThread(dependencies, actor, id, job.deadline));
          session.record(sessionComponent(anchor));
          set.status = 204;
        } catch (error) {
          if (error instanceof ContentNotFoundError) throw new ProblemError('not_found');
          throw error;
        }
      },
    )
    .delete(
      '/v1/threads/:id/watch',
      {
        params,
        response: { 204: withHeaders(t.Void(), sessionHeader), ...failures },
        detail: {
          operationId: 'thread.unwatch',
          'x-exposure': 'public',
          'x-action': 'thread:read',
          security: [{ bearerAuth: [] }],
        },
      },
      async ({ params: { id }, actor, admission, job, set }) => {
        requireAccount(actor);
        await admission.run('normal', job, () => unwatchThread(dependencies, actor, id));
        set.status = 204;
      },
    );
}
