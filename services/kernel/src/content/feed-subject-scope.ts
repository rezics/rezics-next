import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { deadlineClient, within } from '../access/authenticate.ts';
import { CommandUnavailableError } from '../access/unavailable.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { openFollowingSpace } from './feed-space.ts';

type Dependencies = Parameters<typeof openFollowingSpace>[0];
type Client = Pick<PoolClient, 'query'>;
type RealmPopulation = Readonly<{
  realmId: string;
  headRevisionId: string;
  discoveryEpoch: string;
  publicationGeneration: string;
}>;
export type SpaceSubjectObservation = Readonly<{
  spaceId: string;
  spaceHeadRevisionId: string;
  partitionEpoch: number;
  realm: RealmPopulation | null;
}>;
export type SpaceSubjectPrefix = Readonly<{
  subjects: readonly Readonly<{ subjectId: string; publicationId: string }>[];
  coveredThrough: string | null;
  exhausted: boolean;
  /** Includes the unconsumed lookahead; reserve limit+1 before dispatch. */
  examined: number;
  observation: SpaceSubjectObservation;
}>;

/** Original native membership scope, independent of returned Search hits.
 * This complete structural population is an input to the public catalogue Source
 * and the owner's eligible-progress intersection. It supplies neither Subject
 * disclosure nor public-catalogue/owner readiness on its own.
 */
export async function openSpaceSubjectPopulation(
  deps: Dependencies,
  actor: Actor,
  spaceId: string,
  deadline: number,
  at: string,
  expected?: SpaceSubjectObservation,
) {
  expected = expected === undefined ? undefined : structuredClone(expected);
  const selected = await openFollowingSpace(deps, actor, spaceId, deadline, at);
  const route = routeOf(spaceId)!;
  const partitionNo = partitionOf(route);
  async function snapshot<T>(read: (client: Client, observation: SpaceSubjectObservation) => Promise<T>) {
    return within(deadline, () =>
      withConnection(deps.pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          const partition = await readPartition(client, partitionNo);
          if (!partition) throw new CommandUnavailableError('contention', partitionNo);
          if (partition.writeState === 'moved')
            throw new CommandUnavailableError('moved', partitionNo, partition.movedTo);
          if (partition.writeState !== 'active') throw new CommandUnavailableError('fenced', partitionNo);
          const realm =
            (
              await client.query<RealmPopulation>(
                `SELECT realm_id AS "realmId", head_revision_id AS "headRevisionId",
                  discovery_epoch::text AS "discoveryEpoch", publication_generation::text AS "publicationGeneration"
                  FROM community.realm
                  WHERE route=$1 AND space_id=$2 AND state='active'`,
                [route, spaceId],
              )
            ).rows[0] ?? null;
          // A withheld Realm slot is not a complete empty population. This
          // same-home unique slot read reveals no hidden identity to a client.
          if ((realm?.realmId ?? null) !== selected.realmId) throw new ProblemError('stale_cursor');
          if (realm) Object.freeze(realm);
          const observation = Object.freeze({
            spaceId,
            spaceHeadRevisionId: selected.headRevisionId,
            partitionEpoch: partition.epoch,
            realm,
          });
          const value = await read(client, observation);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }),
    );
  }
  const observation = await snapshot(async (_client, current) => current);
  if (expected !== undefined && !isDeepStrictEqual(expected, observation)) throw new ProblemError('stale_cursor');
  const requireCurrent = (current: SpaceSubjectObservation) => {
    if (!isDeepStrictEqual(current, observation)) throw new ProblemError('stale_cursor');
  };
  async function finish() {
    await snapshot(async (_client, current) => requireCurrent(current));
    // Also required for a Realm-less Space and a ready empty structural population.
    await selected.finish();
  }
  await finish();
  return Object.freeze({
    observation,
    async prefix(limit: number, after: string | null = null): Promise<SpaceSubjectPrefix> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 160 || (after !== null && routeOf(after) === null))
        throw new RangeError('Invalid Space Subject prefix');
      const result = await snapshot(async (client, current) => {
        requireCurrent(current);
        const rows =
          observation.realm === null
            ? []
            : (
                await client.query<{ subjectId: string; publicationId: string }>(
                  `SELECT subject_id AS "subjectId",publication_id AS "publicationId"
                    FROM community.publication_head
                    WHERE route=$1 AND realm_id=$2 AND verdict='adopt'
                      AND ($3::uuid IS NULL OR subject_id>$3)
                    ORDER BY subject_id LIMIT $4`,
                  [route, observation.realm.realmId, after, limit + 1],
                )
              ).rows;
        const subjects = rows.slice(0, limit).map((row) => Object.freeze(row));
        return Object.freeze({
          subjects: Object.freeze(subjects),
          coveredThrough: subjects.at(-1)?.subjectId ?? after,
          exhausted: rows.length <= limit,
          examined: rows.length,
          observation,
        });
      });
      await finish();
      return result;
    },
    finish,
  });
}
