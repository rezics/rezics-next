import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { readRealmVotes, type RealmVotes } from '../community/realm-votes.ts';
import refresh from './board-rank-refresh.sql';
import readScores from './board-rank-scores.sql';
import type { ReactionKind } from './reactions.ts';

const noRealmVotes: RealmVotes = Object.freeze({ upvote: 1, downvote: -1 });
const minimumScore = -2_147_483_648;
const maximumScore = 2_147_483_647;

type Candidate = {
  route: number;
  board_id: string;
  thread_id: string;
  created_at: string;
  last_activity_at: string;
  realm_id: string | null;
};

type Total = { thread_id: string; kind: ReactionKind; count: number };

type RankUpdate = {
  route: number;
  board_id: string;
  thread_id: string;
  score: number;
  active_rank: number;
  hot_rank: number;
};

/** Lemmy's rank formula, used with last activity for active and creation for hot. */
export function lemmyActiveRank(score: number, activityAt: Date, at: Date): number {
  if (!Number.isInteger(score) || !Number.isFinite(activityAt.getTime()) || !Number.isFinite(at.getTime()))
    throw new TypeError('Invalid active rank input');
  const hours = Math.max(0, (at.getTime() - activityAt.getTime()) / 3_600_000);
  if (at.getTime() - activityAt.getTime() > 7 * 24 * 3_600_000) return 0;
  return Math.log10(Math.max(2, score + 2)) / Math.pow(hours + 2, 1.8);
}

function routedThreadPartition(threadId: string): number {
  const route = Number.parseInt(threadId.slice(24, 28), 16);
  if (!Number.isInteger(route) || route < 0 || route > 65_535) throw new TypeError('Invalid thread route');
  return Math.floor(route / 16);
}

function routedThreadRoute(threadId: string): number {
  const route = Number.parseInt(threadId.slice(24, 28), 16);
  if (!Number.isInteger(route) || route < 0 || route > 65_535) throw new TypeError('Invalid thread route');
  return route;
}

function weightedScore(
  candidate: Candidate,
  totals: readonly Total[],
  realmVotes: ReadonlyMap<string, RealmVotes>,
): number {
  const weights = candidate.realm_id === null ? noRealmVotes : (realmVotes.get(candidate.realm_id) ?? {});
  const score = totals.reduce((sum, total) => sum + total.count * (weights[total.kind] ?? 0), 0);
  return Math.max(minimumScore, Math.min(maximumScore, Math.trunc(score)));
}

async function readBatchScores(client: PoolClient, candidates: readonly Candidate[]): Promise<Map<string, Total[]>> {
  const byPartition = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const partition = routedThreadPartition(candidate.thread_id);
    const group = byPartition.get(partition) ?? [];
    group.push(candidate);
    byPartition.set(partition, group);
  }

  const totals = new Map<string, Total[]>();
  for (const [partition, group] of byPartition) {
    const rows = (await readScores.run(client, {
      partition,
      threads: group.map(({ thread_id }) => ({ route: routedThreadRoute(thread_id), thread_id })),
    })) as Total[];
    for (const row of rows) {
      const threadTotals = totals.get(row.thread_id) ?? [];
      threadTotals.push(row);
      totals.set(row.thread_id, threadTotals);
    }
  }
  return totals;
}

async function updateBatch(client: PoolClient, updates: readonly RankUpdate[], at: Date): Promise<number> {
  const result = await client.query<{ thread_id: string }>(
    `UPDATE content.board_thread AS candidate
     SET score = batch.score,
         active_rank = batch.active_rank,
         hot_rank = batch.hot_rank,
         rank_refreshed_at = $2::timestamptz
     FROM jsonb_to_recordset($1::jsonb) AS batch(
       route integer, board_id uuid, thread_id uuid, score integer,
       active_rank double precision, hot_rank double precision
     )
     WHERE candidate.route = batch.route
       AND candidate.board_id = batch.board_id
       AND candidate.thread_id = batch.thread_id
     RETURNING candidate.thread_id::text AS thread_id`,
    [JSON.stringify(updates), at.toISOString()],
  );
  return result.rowCount ?? 0;
}

/** One due, indexed refresh batch. Candidate locking and the 500-row cap are in SQL. */
export async function refreshBoardRankBatch(pool: Pool, at = new Date()): Promise<number> {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid board rank refresh time');
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SET LOCAL enable_seqscan = off');
      const candidates = (await refresh.run(client, { at: at.toISOString() })) as Candidate[];
      if (candidates.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const realmIds = [...new Set(candidates.flatMap(({ realm_id }) => (realm_id === null ? [] : [realm_id])))];
      const totals = await readBatchScores(client, candidates);
      const realmVotes = await readRealmVotes(client, realmIds);
      const updates = candidates.map((candidate): RankUpdate => {
        const score = weightedScore(candidate, totals.get(candidate.thread_id) ?? [], realmVotes);
        return {
          route: candidate.route,
          board_id: candidate.board_id,
          thread_id: candidate.thread_id,
          score,
          active_rank: lemmyActiveRank(score, new Date(candidate.last_activity_at), at),
          hot_rank: lemmyActiveRank(score, new Date(candidate.created_at), at),
        };
      });
      const updated = await updateBatch(client, updates, at);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
