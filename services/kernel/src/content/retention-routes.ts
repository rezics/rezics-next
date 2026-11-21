import type { Pool } from 'pg';
import { partitionOf } from '../route/contract.ts';
import collectDue from './collect-retention-due.sql';
import noticeDue from './notice-retention-due.sql';

export type RetentionFamily = 'collect' | 'notice';
export type RetentionFrontier = Record<string, { through: string; route: number }>;
export type RetentionPartition = { partition: number; routes: number[]; media: boolean };

/** Fresh bounded index witnesses elect the existing route owners. Each owner rechecks its own rows. */
export async function readDueContentRetention(
  pool: Pool,
  family: RetentionFamily,
  cutoff: string,
  frontier: RetentionFrontier,
) {
  const params = { cutoff, frontier };
  const rows = family === 'collect' ? await collectDue.run(pool, params) : await noticeDue.run(pool, params);
  const next = { ...frontier };
  const counts = new Map<string, number>();
  const partitions = new Map<number, RetentionPartition>();
  for (const row of rows) {
    if (row.kind === null || row.through === null || row.route === null)
      throw new Error('Content retention index returned an incomplete witness');
    const { kind, through, route } = row;
    next[kind] = { through, route };
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const partition = partitionOf(route);
    let work = partitions.get(partition);
    if (!work) {
      work = { partition, routes: [], media: false };
      partitions.set(partition, work);
    }
    if (kind === 'eligible' || kind === 'pending') work.media = true;
    else if (!work.routes.includes(route)) work.routes.push(route);
  }
  return {
    cutoff,
    frontier: next,
    work: [...partitions.values()],
    complete: [...counts.values()].every((count) => count < 8),
  };
}
