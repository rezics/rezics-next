import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { AuthenticationError, type Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor } from '../tokens/list-cursor.ts';
import { systemClock } from '../clock.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { readContinueOwnerPage } from './continue-query.ts';
import type { ContinueActiveSession } from './continue-source.ts';
import type { SubjectSummary } from '../semantic/summaries.ts';
import { openSpaceSubjectPopulation } from '../content/feed-subject-scope.ts';

export type ContinueSubject = Readonly<{
  subjectId: string;
  state: string | null;
  lastActivityAt: string;
  activeProgressSession: ContinueActiveSession | null;
  subject?: SubjectSummary | null;
}>;
export type ContinuePage = { subjects: ContinueSubject[]; next: string | null };

/** Pure default reader. Admission precedes native owner/cursor reads; GET never starts retained work. */
export function createContinueReads(
  deps: Omit<OwnerQueryDependencies, 'access'> & {
    tokens: KeyRing;
    access?: OwnerQueryDependencies['access'];
  },
) {
  return {
    async list(
      actor: Actor,
      query: { limit?: number; cursor?: string; view?: 'BASIC' | 'FULL'; spaceId?: string; kind?: string },
      deadline: number,
      languages: readonly string[] = [],
    ): Promise<ContinuePage> {
      if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
      if (!actor.scopes.includes('library_entry:list') || !actor.scopes.includes('progress_session:list'))
        throw new ProblemError('forbidden', {
          headers: { 'www-authenticate': 'Bearer error="insufficient_scope"' },
        });
      const limit = query.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
      if (query.view !== undefined && query.view !== 'BASIC' && query.view !== 'FULL')
        throw new ProblemError('invalid_request');
      if (query.spaceId !== undefined && (typeof query.spaceId !== 'string' || routeOf(query.spaceId) === null))
        throw new ProblemError('invalid_request', { errors: [{ pointer: '/spaceId', code: 'invalid_format' }] });
      if (query.kind !== undefined && (typeof query.kind !== 'string' || query.kind.length === 0 || query.kind.length > 128))
        throw new ProblemError('invalid_request', { errors: [{ pointer: '/kind', code: 'invalid_format' }] });
      const accountActor = actor;
      const route = routeOf(accountActor.accountId);
      if (route === null) throw new ProblemError('forbidden');
      let spacePopulation: Awaited<ReturnType<typeof openSpaceSubjectPopulation>> | undefined;
      if (query.spaceId !== undefined) {
        if (!deps.access)
          throw new ProblemError('dependency_unavailable', {
            detail: 'Continue requires the current Access binding.',
          });
        spacePopulation = await openSpaceSubjectPopulation(
          {
            pool: deps.pool,
            access: deps.access,
            contentAccess: deps.access,
            tokens: deps.tokens,
            ...(deps.clock ? { clock: deps.clock } : {}),
          },
          actor,
          query.spaceId,
          deadline,
          (deps.clock ?? systemClock)().toISOString(),
        );
      }
      async function snapshot<T>(read: (client: ReturnType<typeof deadlineClient>) => Promise<T>) {
        return withConnection(deps.pool, async (connection) => {
          const client = deadlineClient(connection, deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const owner = await readAccount(client, route!, accountActor.accountId);
            if (
              !owner ||
              owner.kind !== 'actor' ||
              owner.state !== 'active' ||
              owner.fenced ||
              !Number.isSafeInteger(accountActor.authnEpoch) ||
              accountActor.authnEpoch < 1 ||
              owner.minimumAuthnEpoch > BigInt(accountActor.authnEpoch)
            )
              throw new ProblemError('forbidden');
            const result = await read(client);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
      }
      const presence = await snapshot(
        async (client) =>
          (
            await client.query<{ entry: boolean; session: boolean }>(
              `SELECT EXISTS(SELECT 1 FROM library.entry WHERE route=$1 AND account_id=$2) AS entry,
          EXISTS(SELECT 1 FROM library.progress_session WHERE route=$1 AND account_id=$2 AND state='active') AS session`,
              [route, accountActor.accountId],
            )
          ).rows[0]!,
      );
      if (query.cursor !== undefined && (query.cursor.length === 0 || query.cursor.length > 4096))
        throw new ProblemError('invalid_cursor');
      // Native absence is a complete empty union. A continuation still needs the actual Source/cursor basis.
      if (!presence.entry && !presence.session && query.cursor === undefined) {
        await spacePopulation?.finish();
        return { subjects: [], next: null };
      }
      if (query.cursor !== undefined) {
        const decoded = await decodeListCursor(
          deps.tokens,
          {
            route: 'GET /v1/libraryContinue',
            viewer: accountActor.accountId,
            query: { limit, source: 'owner-active-state-session' },
          },
          query.cursor,
          (deps.clock ?? systemClock)(),
        );
        if (!decoded.ok) throw new ProblemError('invalid_cursor');
      }
      if (!deps.access)
        throw new ProblemError('dependency_unavailable', {
          detail: 'Continue requires the current Access binding.',
        });
      return readContinueOwnerPage(
        { ...deps, access: deps.access },
        {
          actor,
          limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.view === undefined ? {} : { view: query.view }),
          ...(query.view === 'FULL' ? { languages } : {}),
          ...(spacePopulation ? { spacePopulation } : {}),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
          deadline,
          snapshot,
          readVersion: () =>
            snapshot(async (client) => {
              const head = (
                await client.query<{ generation: string }>(
                  'SELECT generation::text AS generation FROM library.fact_source_head WHERE route=$1 AND account_id=$2',
                  [route, accountActor.accountId],
                )
              ).rows[0];
              if (!head) throw new ProblemError('semantic_not_ready');
              return head.generation;
            }),
        },
      );
    },
  };
}
