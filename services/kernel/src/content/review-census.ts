import type { Pool, PoolClient } from 'pg';
import { withReadTransaction } from '../semantic/read.ts';
import { realmSubjectHome } from './realm-subject-candidates.ts';
import type { ReviewDiscoveryContinuation, ReviewDiscoveryHomeObservation } from './review-discovery.ts';

export const REVIEW_CENSUS_PAGE_SIZE = 25;
export const REVIEW_CENSUS_EPISODE_LIMIT = 100;
export type ReviewCensusCut = Readonly<{
  homes: readonly ReviewDiscoveryHomeObservation[];
  frontier: string;
}>;
/** Internal retained identity evidence. Never serialize this on a public page. */
export type ReviewCensusEpisode = Readonly<{
  route: number;
  id: string;
  boardId: string | null;
  realmId: string | null;
  subjectId: string | null;
  openingId: string | null;
  revisionId: string | null;
  sourceVersion: string;
  eligible: boolean;
}>;
export type ReviewCensusObservation =
  | Readonly<{ state: 'ready'; position: bigint; cut: ReviewCensusCut }>
  | Readonly<{ state: 'preparing' | 'changed' | 'unavailable'; position: bigint | null; missing: string }>;
export type ReviewCensusPage =
  | Readonly<{
      state: 'ready';
      position: bigint;
      cut: ReviewCensusCut;
      episodes: readonly ReviewCensusEpisode[];
      next: ReviewDiscoveryContinuation | null;
    }>
  | Exclude<ReviewCensusObservation, { state: 'ready' }>;
/** Candidate installation is intentionally weaker than anonymous eligibility coverage. */
export type ReviewCensusCoverage = Readonly<{
  state: 'preparing' | 'unavailable';
  partition: number;
  position: bigint | null;
  generation: string | null;
  installed: boolean;
  missing: string;
}>;
export type ReviewCensusStep = Readonly<{
  state: 'progress' | 'exhausted' | 'changed' | 'preparing' | 'unavailable';
  generation: string;
  examined: number;
}>;
type Reader = Readonly<{
  page(partition: number, after: ReviewDiscoveryContinuation | null): Promise<ReviewCensusPage>;
  observe(client: Pick<PoolClient, 'query'>, partition: number, cut: ReviewCensusCut | null): Promise<ReviewCensusObservation>;
}>;
type Installation = {
  generation: string;
  revision: string;
  after_route: number | null;
  after_id: string | null;
  after_token: string | null;
  cut: ReviewCensusCut | null;
  exhausted: boolean;
};
const fields = 'generation::text,revision::text,after_route,after_id::text,after_token,cut,exhausted';

function assertPartition(partition: number): void {
  if (!Number.isInteger(partition) || partition < 0 || partition > 4095)
    throw new RangeError('Review census partition must be from 0 to 4095');
}

export function sameReviewCensusCut(left: ReviewCensusCut, right: ReviewCensusCut): boolean {
  return left.frontier === right.frontier && left.homes.length === right.homes.length &&
    left.homes.every((home, index) => {
      const other = right.homes[index];
      return other !== undefined && home.partition === other.partition && home.epoch === other.epoch &&
        home.position === other.position;
    });
}

/** Durable native projection maintenance. Like the existing Realm Subject candidate
 * store, projection writes do not invent a domain log position. Owner observations
 * happen before writes, and only core home metadata is rechecked during the CAS.
 * This store cannot mint an anonymous-eligibility certificate.
 */
export function createReviewCensus(pool: Pool, reader: Reader) {
  async function load(client: Pick<PoolClient, 'query'>, partition: number, lock = false) {
    return (await client.query<Installation>(
      `SELECT ${fields} FROM content.review_census_installation WHERE route=$1${lock ? ' FOR UPDATE' : ''}`,
      [partition * 16],
    )).rows[0];
  }

  async function reset(partition: number, state: Installation, deadline: number): Promise<ReviewCensusStep> {
    const generation = await realmSubjectHome(pool, partition * 16, deadline, true, async (client) => {
      const result = await client.query<{ generation: string }>(
        `UPDATE content.review_census_installation SET generation=gen_random_uuid(),revision=revision+1,
         after_route=NULL,after_id=NULL,after_token=NULL,cut=NULL,exhausted=false,observed_public=0,examined=0
         WHERE route=$1 AND generation=$2::uuid AND revision=$3::bigint RETURNING generation::text`,
        [partition * 16, state.generation, state.revision],
      );
      return result.rows[0]?.generation ?? (await load(client, partition))!.generation;
    });
    return { state: 'changed', generation, examined: 0 };
  }

  return Object.freeze({
    async coverage(partition: number, deadline: number): Promise<ReviewCensusCoverage> {
      assertPartition(partition);
      return withReadTransaction(pool, async (client) => {
        const state = await load(client, partition);
        const current = await reader.observe(client, partition, state?.cut ?? null);
        const common = { partition, position: current.position, generation: state?.generation ?? null };
        if (current.state !== 'ready')
          return { ...common, state: current.state === 'unavailable' ? 'unavailable' : 'preparing',
            installed: false, missing: current.missing };
        if (state?.cut && !sameReviewCensusCut(state.cut, current.cut))
          return { ...common, state: 'preparing', installed: false, missing: 'population-cut' };
        const installed = !!state?.exhausted;
        return { ...common, state: 'preparing', installed,
          missing: installed ? 'native-eligibility-coverage' : 'census-installation' };
      }, deadline);
    },

    async step(partition: number, deadline: number): Promise<ReviewCensusStep> {
      assertPartition(partition);
      const state = await realmSubjectHome(pool, partition * 16, deadline, true, async (client) => {
        await client.query(
          'INSERT INTO content.review_census_installation(route) VALUES($1) ON CONFLICT DO NOTHING',
          [partition * 16],
        );
        return (await load(client, partition))!;
      });
      if (state.exhausted) {
        const current = await withReadTransaction(pool,
          (client) => reader.observe(client, partition, state.cut), deadline);
        if (current.state !== 'ready')
          return { state: current.state, generation: state.generation, examined: 0 };
        if (!state.cut || !sameReviewCensusCut(state.cut, current.cut)) return reset(partition, state, deadline);
        return { state: 'exhausted', generation: state.generation, examined: 0 };
      }
      const after = state.after_id === null ? null : {
        route: state.after_route!, id: state.after_id, token: state.after_token!,
      };
      const page = await reader.page(partition, after);
      if (page.state === 'changed') return reset(partition, state, deadline);
      if (page.state !== 'ready') return { state: page.state, generation: state.generation, examined: 0 };
      if (page.episodes.length > REVIEW_CENSUS_EPISODE_LIMIT)
        throw new RangeError('Review census native page exceeded its episode bound');
      return realmSubjectHome(pool, partition * 16, deadline, true, async (client): Promise<ReviewCensusStep> => {
        const locked = (await load(client, partition, true))!;
        // Another resumed worker won. Do not replay an old delta or move its frontier.
        if (locked.generation !== state.generation || locked.revision !== state.revision)
          return { state: 'changed', generation: locked.generation, examined: 0 };
        const current = await reader.observe(client, partition, page.cut);
        if (current.state !== 'ready') return { state: current.state, generation: state.generation, examined: 0 };
        if (!sameReviewCensusCut(page.cut, current.cut))
          return { state: 'changed', generation: state.generation, examined: 0 };

        const keys = JSON.stringify(page.episodes);
        const previous = await client.query<{ id: string; generation: string; eligible: boolean }>(
          `SELECT c.thread_id::text AS id,c.generation::text,c.eligible
           FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid)
           JOIN content.review_census_contribution c ON c.route=k.route AND c.thread_id=k.id`, [keys],
        );
        const byId = new Map(previous.rows.map((row) => [row.id, row]));
        let delta = 0;
        for (const episode of page.episodes) {
          const prior = byId.get(episode.id);
          delta += Number(episode.eligible) - Number(prior?.generation === state.generation && prior.eligible);
        }
        // Retain the old board/place/target/revision episode independently of the
        // current contribution. A disappearing native row cannot erase cleanup keys.
        await client.query(
          `INSERT INTO content.review_census_episode
           (route,thread_id,source_version,board_id,realm_id,subject_id,opening_id,revision_id,eligible)
           SELECT k.route,k.id,k."sourceVersion",k."boardId",k."realmId",k."subjectId",k."openingId",k."revisionId",k.eligible
           FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid,"sourceVersion" text,"boardId" uuid,
             "realmId" uuid,"subjectId" uuid,"openingId" uuid,"revisionId" uuid,eligible boolean)
           ON CONFLICT DO NOTHING`, [keys],
        );
        await client.query(
          `INSERT INTO content.review_census_contribution(route,thread_id,generation,source_version,eligible)
           SELECT k.route,k.id,$2::uuid,k."sourceVersion",k.eligible
           FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid,"sourceVersion" text,eligible boolean)
           ON CONFLICT(route,thread_id) DO UPDATE SET generation=excluded.generation,
             source_version=excluded.source_version,eligible=excluded.eligible`, [keys, state.generation],
        );
        await client.query(
          `UPDATE content.review_census_installation SET revision=revision+1,after_route=$4,after_id=$5,
           after_token=$6,cut=$7::jsonb,exhausted=$8,observed_public=observed_public+$9,examined=examined+$10
           WHERE route=$1 AND generation=$2::uuid AND revision=$3::bigint`,
          [partition * 16, state.generation, state.revision, page.next?.route ?? null, page.next?.id ?? null,
            page.next?.token ?? null, JSON.stringify(page.cut), page.next === null, delta, page.episodes.length],
        );
        return { state: page.next === null ? 'exhausted' : 'progress',
          generation: state.generation, examined: page.episodes.length };
      });
    },
  });
}
