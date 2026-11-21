import type { Pool } from 'pg';
import { discardConnection, withConnection } from '../database/pool.ts';
import { PARTITIONS } from '../route/contract.ts';
import scanChanged from './scan-changed-partitions.sql';
import scanAll from './scan-partitions.sql';
import upsertLag from './upsert-consumer-lag.sql';

type Home = { partition_no: number; position: string | bigint; oldest_pending_at: string | Date | null };
type Cut = { heads: string[]; revision: string | null };
const POINT_LIMIT = 128;

/** Within one snapshot a covered home can fall behind only when its head changes or its checkpoint is reset.
 * Keep the pending homes until a native reread covers them. A new worker always starts with a complete scan. */
export function createRelayDiscovery(pool: Pool) {
  const previous = new Map<string, { cut: Cut; pending: number[] }>();
  return (consumers: readonly string[]) =>
    withConnection(pool, async (client) => {
      const found = new Map<string, readonly Home[]>();
      let cut: Cut;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const observed = await client.query<Cut>(
          `SELECT
          CASE WHEN max(partition_no) = $1 - 1 THEN array_agg(position::text ORDER BY partition_no)
            ELSE ARRAY[]::text[] END AS heads,
          (SELECT revision::text FROM core.relay_checkpoint_reset WHERE singleton) AS revision
          FROM core.partition`,
          [PARTITIONS],
        );
        cut = observed.rows[0]!;
        const changed = new Map<Cut, number[]>();
        for (const consumer of consumers) {
          const prior = previous.get(consumer);
          let homes: number[] | undefined;
          if (
            cut.revision &&
            cut.heads.length === PARTITIONS &&
            prior?.cut.revision === cut.revision &&
            prior.cut.heads.length === PARTITIONS &&
            prior.pending.length <= POINT_LIMIT
          ) {
            let delta = changed.get(prior.cut);
            if (!delta) {
              delta = [];
              for (let home = 0; home < PARTITIONS && delta.length <= POINT_LIMIT; home++) {
                if (cut.heads[home] !== prior.cut.heads[home]) delta.push(home);
              }
              changed.set(prior.cut, delta);
            }
            if (delta.length <= POINT_LIMIT) homes = [...new Set([...delta, ...prior.pending])];
          }
          const rows =
            homes === undefined || homes.length > POINT_LIMIT
              ? await scanAll.run(client, { consumer })
              : homes.length
                ? await scanChanged.run(client, { consumer, homes })
                : [];
          found.set(consumer, rows);
        }
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(
            client,
            rollbackError instanceof Error ? rollbackError : new Error('Relay discovery rollback failed'),
          );
        }
        throw error;
      }
      const polled = [...found.keys()];
      await upsertLag.run(client, {
        consumers: polled,
        oldest_pending_ats: polled.map((consumer) => {
          const oldest = found.get(consumer)![0]?.oldest_pending_at;
          return oldest ? new Date(oldest).toISOString() : '';
        }),
      });
      for (const [consumer, rows] of found)
        previous.set(consumer, { cut, pending: rows.map((row) => row.partition_no) });
      return found;
    });
}
