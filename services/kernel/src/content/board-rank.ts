import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../database/pool.ts';
import { readRealmVotes, type RealmVotes } from '../community/content-capabilities.ts';
import { PARTITIONS } from '../route/route.ts';
import { contentClock } from './adapters/bind.ts';
import { CONTENT_DEFAULT_REALM_VOTES } from './contract/index.ts';
import { clampReactionScore, lemmyActiveRank, rankUpdate } from './core/index.ts';
import refresh from './board-rank-refresh.sql';
import updateRanks from './board-rank-update.sql';
import readScores from './board-rank-scores.sql';
import type { ReactionKind } from './reactions.ts';

export { lemmyActiveRank };

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
  const weights =
    candidate.realm_id === null ? CONTENT_DEFAULT_REALM_VOTES : (realmVotes.get(candidate.realm_id) ?? {});
  const score = totals.reduce((sum, total) => sum + total.count * (weights[total.kind] ?? 0), 0);
  return clampReactionScore(score);
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

async function updateBatch(
  client: PoolClient,
  partition: number,
  updates: readonly RankUpdate[],
  at: Date,
): Promise<number> {
  const rows = await updateRanks.run(client, { partition, updates: [...updates], at: at.toISOString() });
  return rows.length;
}

/** One indexed refresh batch per partition, each locking at most 500 due candidates. */
export async function refreshBoardRankBatch(
  pool: Pool,
  at = contentClock(),
  partitions: readonly number[] = Array.from({ length: PARTITIONS }, (_, partition) => partition),
): Promise<number> {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid board rank refresh time');
  if (
    new Set(partitions).size !== partitions.length ||
    partitions.some((partition) => !Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
  )
    throw new RangeError('Invalid board rank partitions');
  let refreshed = 0;
  for (const partition of partitions) refreshed += await refreshPartition(pool, partition, at);
  return refreshed;
}

async function refreshPartition(pool: Pool, partition: number, at: Date): Promise<number> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const candidates = (await refresh.run(client, { partition, at: at.toISOString() })) as Candidate[];
      if (candidates.length === 0) {
        await client.query('COMMIT');
        return 0;
      }

      const realmIds = [...new Set(candidates.flatMap(({ realm_id }) => (realm_id === null ? [] : [realm_id])))];
      const totals = await readBatchScores(client, candidates);
      const realmVotes = await readRealmVotes(client, realmIds);
      const updates = candidates.map((candidate): RankUpdate => {
        const score = weightedScore(candidate, totals.get(candidate.thread_id) ?? [], realmVotes);
        const ranked = rankUpdate(
          {
            route: candidate.route,
            boardId: candidate.board_id,
            threadId: candidate.thread_id,
            createdAt: candidate.created_at,
            lastActivityAt: candidate.last_activity_at,
            realmId: candidate.realm_id,
          },
          score,
          at,
        );
        return {
          route: ranked.route,
          board_id: ranked.boardId,
          thread_id: ranked.threadId,
          score: ranked.score,
          active_rank: ranked.activeRank,
          hot_rank: ranked.hotRank,
        };
      });
      const updated = await updateBatch(client, partition, updates, at);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}
