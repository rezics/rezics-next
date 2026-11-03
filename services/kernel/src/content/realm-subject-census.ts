import type { Pool, QueryResultRow } from 'pg';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import {
  createRealmSubjectCandidates,
  realmSubjectHome,
  realmSubjectRoute,
  type CandidateVersion,
  type RealmSubjectCandidate,
} from './realm-subject-candidates.ts';

export type RealmSubjectCut = CandidateVersion & Readonly<{ route: number; generation: string; upper: string | null }>;
type Pending = Omit<RealmSubjectCandidate, 'original' | 'terminal' | 'identityEpoch' | 'active'> & {
  subjects: string[];
};
type Census = {
  generation: string;
  cut_epoch: number;
  cut_position: string;
  upper_id: string | null;
  after_id: string | null;
  pending: Pending | null;
  ordinal: number;
  exhausted: boolean;
};
const zero = '00000000-0000-0000-0000-000000000000';
const fields = 'generation::text,cut_epoch,cut_position::text,upper_id,after_id,pending,ordinal,exhausted';

/** Finite native source keys and durable cross-home handoff. Never marks a population ready. */
export function createRealmSubjectCensus(pool: Pool) {
  const candidates = createRealmSubjectCandidates(pool);
  function point<T extends QueryResultRow>(route: number, deadline: number, sql: string, parameters: unknown[]) {
    return realmSubjectHome(
      pool,
      route,
      deadline,
      false,
      async (client) => (await client.query<T>(sql, parameters)).rows[0],
    );
  }
  function load(route: number, deadline: number) {
    return point<Census>(route, deadline, `SELECT ${fields} FROM content.realm_subject_census WHERE route=$1`, [route]);
  }
  async function advance(
    route: number,
    state: Census,
    deadline: number,
    pending: Pending | null,
    after: string | null,
    ordinal: number,
    exhausted = false,
  ) {
    return realmSubjectHome(pool, route, deadline, true, async (client) => {
      const result = await client.query(
        `UPDATE content.realm_subject_census
        SET pending=$6::jsonb,after_id=$7,ordinal=$8,exhausted=$9
        WHERE route=$1 AND generation=$2 AND after_id IS NOT DISTINCT FROM $3::uuid
          AND ordinal=$4 AND pending IS NOT DISTINCT FROM $5::jsonb AND NOT exhausted RETURNING 1`,
        [
          route,
          state.generation,
          state.after_id,
          state.ordinal,
          state.pending === null ? null : JSON.stringify(state.pending),
          pending === null ? null : JSON.stringify(pending),
          after,
          ordinal,
          exhausted,
        ],
      );
      return result.rowCount === 1;
    });
  }
  return {
    async capture(route: number, deadline: number): Promise<RealmSubjectCut> {
      return realmSubjectHome(pool, route, deadline, true, async (client, cut) => {
        await client.query(
          `INSERT INTO content.realm_subject_census(route,cut_epoch,cut_position,upper_id)
          VALUES($1,$2,$3,(SELECT thread_id FROM content.thread WHERE route=$1 ORDER BY thread_id DESC LIMIT 1))
          ON CONFLICT DO NOTHING`,
          [route, cut.epoch, cut.position],
        );
        const state = (
          await client.query<Census>(`SELECT ${fields} FROM content.realm_subject_census WHERE route=$1`, [route])
        ).rows[0]!;
        return {
          route,
          generation: state.generation,
          epoch: state.cut_epoch,
          position: state.cut_position,
          upper: state.upper_id,
        };
      });
    },
    async observe(route: number, deadline: number) {
      const state = await load(route, deadline);
      return state
        ? {
            cut: {
              route,
              generation: state.generation,
              epoch: state.cut_epoch,
              position: state.cut_position,
              upper: state.upper_id,
            } as RealmSubjectCut,
            after: state.after_id,
            ordinal: state.ordinal,
            exhausted: state.exhausted,
          }
        : null;
    },
    async step(route: number, deadline: number): Promise<'progress' | 'exhausted' | 'unknown'> {
      const state = await load(route, deadline);
      if (!state) return 'unknown';
      if (state.exhausted) return 'exhausted';
      if (state.pending) {
        const pending = state.pending;
        const original = pending.subjects[state.ordinal];
        if (!original) {
          await advance(route, state, deadline, null, pending.thread, 0);
          return 'progress';
        }
        // Semantic alone determines terminals. An unavailable mapping remains a structural
        // original, with unresolved coverage; it is never silently treated as a self mapping.
        const mapping = (await readIdentityMappings(pool, [original]))[0]!;
        await candidates.write(
          {
            realm: pending.realm,
            thread: pending.thread,
            opening: pending.opening,
            revision: pending.revision,
            board: pending.board,
            kind: pending.kind,
            original,
            active: true,
            terminal: mapping.state === 'mapped' ? mapping.terminal : null,
            identityEpoch: mapping.state === 'mapped' ? mapping.epoch.toString() : null,
          },
          { epoch: state.cut_epoch, position: state.cut_position },
          'baseline',
          deadline,
        );
        await advance(route, state, deadline, pending, state.after_id, state.ordinal + 1);
        return 'progress';
      }
      const next = await point<{
        thread: string;
        opening: string | null;
        revision: string | null;
        board: string;
        kind: 'discussion' | 'review';
        subjects: string[];
      }>(
        route,
        deadline,
        `WITH next AS MATERIALIZED (
          SELECT thread_id,first_post_id,board_id,kind FROM content.thread
          WHERE route=$1 AND thread_id>$2::uuid AND thread_id<=$3::uuid ORDER BY thread_id LIMIT 1
        ) SELECT n.thread_id AS thread,n.first_post_id AS opening,p.head_revision_id AS revision,
          n.board_id AS board,n.kind,COALESCE(r.subject_ids,'{}'::uuid[]) AS subjects
          FROM next n LEFT JOIN content.post p ON p.route=$1 AND p.thread_id=n.thread_id AND p.post_id=n.first_post_id
          LEFT JOIN content.revision r ON r.route=$1 AND r.thread_id=n.thread_id
            AND r.post_id=n.first_post_id AND r.revision_id=p.head_revision_id`,
        [route, state.after_id ?? zero, state.upper_id ?? zero],
      );
      if (!next) {
        await advance(route, state, deadline, null, state.after_id, 0, true);
        return 'progress';
      }
      if (!next.opening || !next.revision) {
        // A not-yet-complete native opening cannot be certified by this census.
        return 'unknown';
      }
      const board = await point<{ realm: string | null }>(
        realmSubjectRoute(next.board),
        deadline,
        `SELECT realm_id AS realm FROM content.board WHERE route=$1 AND board_id=$2`,
        [realmSubjectRoute(next.board), next.board],
      );
      if (!board) return 'unknown';
      if (!board.realm || !next.subjects.length) {
        await advance(route, state, deadline, null, next.thread, 0);
      } else {
        await advance(
          route,
          state,
          deadline,
          { ...next, opening: next.opening, revision: next.revision, realm: board.realm },
          state.after_id,
          0,
        );
      }
      return 'progress';
    },
  };
}
