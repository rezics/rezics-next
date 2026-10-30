import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { requireBuiltinQueryRuntime } from './builtin-runtime.ts';
import type { ContinueActiveSession } from './continue-source.ts';

export type ContinueSubject = Readonly<{
  subjectId: string;
  state: string | null;
  lastActivityAt: string;
  activeProgressSession: ContinueActiveSession | null;
}>;
export type ContinuePage = { subjects: ContinueSubject[]; next: string | null };

/** Pure default reader. Admission precedes native owner/cursor reads; GET never starts retained work. */
export function createContinueReads(deps: { pool: Pool; tokens: KeyRing; clock?: KernelClock }) {
  return {
    async list(actor: Actor, query: { limit?: number; cursor?: string }, deadline: number): Promise<ContinuePage> {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      if (!actor.scopes.includes('library_entry:list') || !actor.scopes.includes('progress_session:list'))
        throw new ProblemError('forbidden', { headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' } });
      const limit = query.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
      const route = routeOf(actor.accountId);
      if (route === null) throw new ProblemError('forbidden');
      return withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const owner = await readAccount(client, route, actor.accountId);
          if (
            !owner ||
            owner.kind !== 'actor' ||
            owner.state !== 'active' ||
            owner.fenced ||
            !Number.isSafeInteger(actor.authnEpoch) ||
            actor.authnEpoch < 1 ||
            owner.minimumAuthnEpoch > BigInt(actor.authnEpoch)
          )
            throw new ProblemError('forbidden');
          if (query.cursor !== undefined) {
            if (query.cursor.length === 0 || query.cursor.length > 4096) throw new ProblemError('invalid_cursor');
            const cursor = await decodeListCursor(
              deps.tokens,
              {
                route: 'GET /v1/libraryContinue',
                viewer: actor.accountId,
                query: { limit, source: 'owner-active-state-session' },
              },
              query.cursor,
              (deps.clock ?? systemClock)(),
            );
            if (!cursor.ok) throw new ProblemError('invalid_cursor');
            // No mapping point, fabricated epoch or native source version can replace
            // the shared source-scoped query basis needed to authorize this continuation.
            requireBuiltinQueryRuntime();
          }
          const presence = (
            await client.query<{ entry: boolean; session: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2) AS entry,
              EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND state='active') AS session`,
              [route, actor.accountId],
            )
          ).rows[0]!;
          if (presence.entry || presence.session) requireBuiltinQueryRuntime();
          // Native absence, not missing index metadata, proves this genuine empty union.
          await client.query('COMMIT');
          return { subjects: [], next: null };
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
  };
}
