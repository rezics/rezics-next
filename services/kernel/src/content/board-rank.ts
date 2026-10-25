import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import refresh from './board-rank-refresh.sql';

/** Lemmy's active rank, with a zero score until reaction weights are available. */
export function lemmyActiveRank(score: number, activityAt: Date, at: Date): number {
  if (!Number.isInteger(score) || !Number.isFinite(activityAt.getTime()) || !Number.isFinite(at.getTime()))
    throw new TypeError('Invalid active rank input');
  const hours = Math.max(0, (at.getTime() - activityAt.getTime()) / 3_600_000);
  if (at.getTime() - activityAt.getTime() > 7 * 24 * 3_600_000) return 0;
  return Math.log10(Math.max(2, score + 2)) / Math.pow(hours + 2, 1.8);
}

/** One due, indexed refresh batch. The database enforces the 500-row maximum. */
export async function refreshBoardRankBatch(pool: Pool, at = new Date()): Promise<number> {
  if (!Number.isFinite(at.getTime())) throw new TypeError('Invalid board rank refresh time');
  return withConnection(pool, async (client) => {
    const row = await refresh.run(client, { at: at.toISOString() });
    return row.refreshed ?? 0;
  });
}
