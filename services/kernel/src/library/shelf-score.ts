import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem.ts';
import {
  readPersonalScoreQuestion,
  unavailablePersonalScoreCurrentness,
  type PersonalScoreCurrentness,
} from '../rating/personal-score.ts';
import { createLibraryCommandRunner, requireRoute } from './command-support.ts';
import type { ShelfCursorBinding, ShelfDateReader, ShelfEntry } from './shelf-contract.ts';
import { MAX_SHELF_PAGE_SIZE, isShelfEntryState } from './shelf-contract.ts';
import { ShelfReadUnavailableError } from './shelf-reader-unavailable.ts';

type Client = Pick<PoolClient, 'query'>;
export type ShelfScorePreparation = { installation: 'pending' | 'installed'; prepared: number };

/** Caller has already admitted the private owner in the same repeatable-read transaction. */
export async function shelfScoreBinding(
  client: Client,
  route: number,
  accountId: string,
  currentness: PersonalScoreCurrentness = unavailablePersonalScoreCurrentness,
) {
  const question = await readPersonalScoreQuestion(client);
  const { rows } = await client.query<{ generation: string; revision: string; ready: boolean }>(
    'SELECT generation,revision::text,ready FROM library.shelf_score_head WHERE route=$1 AND account_id=$2::uuid',
    [route, accountId],
  );
  const head = rows[0];
  if (!head?.ready)
    throw new ShelfReadUnavailableError(
      'personalScore: POST /v1/libraryShelfScorePreparation until ready=true (100 entries per command)',
    );
  const identity = await currentness(client, { route, accountId, question });
  if (identity.status !== 'current') throw new ShelfReadUnavailableError(identity.reason);
  if (!identity.version || identity.version.length > 256)
    throw new ShelfReadUnavailableError('invalid Content score currentness version');
  const binding: ShelfCursorBinding['query'] = {
    scoreGeneration: head.generation,
    scoreRevision: head.revision,
    scoreIdentity: identity.version,
    questionId: question.id,
    questionMeaning: question.meaning,
    questionRevision: question.revision,
    questionGrain: question.grain,
    questionMinimum: question.minimumUnits,
    questionMaximum: question.maximumUnits,
    questionStep: question.stepUnits,
    questionLifecycle: question.lifecycleState,
    questionLifecycleRevision: question.lifecycleRevision,
  };
  return { question, binding };
}

export function createShelfScorePreparation(deps: { pool: Pool; access: Access; clock?: KernelClock }) {
  const runner = createLibraryCommandRunner(deps);
  return async (actor: Actor, key: string): Promise<ShelfScorePreparation> => {
    if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:list')) throw new ProblemError('forbidden');
    const accountId = actor.accountId;
    const result = await runner.ownAccount(
      actor,
      {
        action: 'library_entry:list',
        kind: 'library.shelf.score.prepare',
        requestKey: key,
        input: {},
      },
      async (tx) => {
        const result = await tx.query<{ ready: boolean; prepared: number }>(
          'SELECT ready,prepared FROM library.prepare_shelf_score($1::integer,$2::uuid)',
          [requireRoute(accountId), accountId],
        );
        const page = result.rows[0]!;
        return {
          value: { installation: page.ready ? ('installed' as const) : ('pending' as const), prepared: page.prepared },
          events: [],
        };
      },
    );
    return result.value;
  };
}

export function validShelfScoreKey(key: string): boolean {
  return key === '' || (/^(0|[1-9][0-9]{0,3})$/.test(key) && Number(key) <= 4096);
}

/** Eight fixed expression indexes, each with a single tuple range. Only K+1 candidates enter the join. */
export function createShelfScoreReader(): ShelfDateReader {
  return {
    async page(client, route, accountId, query, after) {
      if (query.orderBy !== 'personalScore' || !['asc', 'desc'].includes(query.direction))
        throw new TypeError('Invalid shelf score order');
      if (routeOf(accountId) !== route) throw new TypeError('Invalid shelf owner route');
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SHELF_PAGE_SIZE)
        throw new RangeError('Invalid shelf page limit');
      if (query.state !== null && !isShelfEntryState(query.state)) throw new TypeError('Invalid shelf state');
      if (query.typeId !== null && routeOf(query.typeId) !== route) throw new TypeError('Invalid private shelf type');
      if (after !== null && (routeOf(after.subjectId) === null || !validShelfScoreKey(after.key)))
        throw new TypeError('Invalid shelf seek');
      const order = query.direction === 'asc' ? 'COALESCE(units,4097)' : 'COALESCE(-units,1)';
      const parameters: unknown[] = [route, accountId];
      let predicate = 'route=$1::integer AND account_id=$2::uuid';
      if (query.state !== null) {
        parameters.push(query.state);
        predicate += ` AND state=$${parameters.length}::text`;
      }
      if (query.typeId !== null) {
        parameters.push(query.typeId);
        predicate += ` AND type_id=$${parameters.length}::uuid`;
      }
      if (after !== null) {
        parameters.push(
          after.key === ''
            ? query.direction === 'asc'
              ? 4097
              : 1
            : Number(after.key) * (query.direction === 'asc' ? 1 : -1),
        );
        const position = parameters.length;
        parameters.push(after.subjectId);
        predicate += ` AND (${order},subject_id)>($${position}::integer,$${position + 1}::uuid)`;
      }
      parameters.push(query.limit + 1);
      const { rows } = await client.query<Omit<ShelfEntry, 'activeProgressSession'>>(
        `WITH selected AS MATERIALIZED (
           SELECT route,account_id,subject_id,units,${order} AS score_key FROM library.shelf_score
           WHERE ${predicate} ORDER BY ${order},subject_id LIMIT $${parameters.length}::integer
         ) SELECT e.subject_id AS "subjectId",e.incarnation_id AS "incarnationId",e.state,e.revision,
           e.created_at::text AS "createdAt",e.updated_at::text AS "updatedAt",
           e.activity_at::text AS "lastActivityAt",e.finished_at::text AS "finishedAt",s.units AS "personalScore"
           FROM selected s JOIN library.entry e USING(route,account_id,subject_id)
           ORDER BY s.score_key,s.subject_id`,
        parameters,
      );
      if (rows.some((row) => row.lastActivityAt === null))
        throw new ShelfReadUnavailableError('native entry date backfill');
      return { entries: rows.slice(0, query.limit), more: rows.length > query.limit };
    },
  };
}
