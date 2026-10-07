import type { Pool } from 'pg';
import { t } from 'elysia';
import { recordWorkerOutcome, withWorkerTelemetry } from '@rezics/observability/runtime';

export const horizonConsumerNames = ['notification', 'reviewRank', 'editorial'] as const;
type HorizonConsumer = typeof horizonConsumerNames[number];
export interface HorizonLag {
  oldestPendingRowAgeSeconds: number | null;
  oldestWriterAgeSeconds: number | null;
}
export interface ReviewRankLag extends HorizonLag {
  oldestPendingRowAgeBasis: 'enqueue' | 'unknown' | 'none';
}
const age = t.Union([t.Number({ minimum: 0 }), t.Null()]);
const consumerHealth = t.Object({ oldestPendingRowAgeSeconds: age, oldestWriterAgeSeconds: age });
export const horizonHealth = t.Object({ sampledAt: t.String(),
  writerVisibility: t.Union([t.Literal('all-sessions'), t.Literal('own-role')]),
  notification: consumerHealth,
  reviewRank: t.Object({
    oldestPendingRowAgeSeconds: age,
    oldestPendingRowAgeBasis: t.Union([t.Literal('enqueue'), t.Literal('unknown'), t.Literal('none')], {
      description: 'enqueue is waiting time from the append clock. unknown is a pending row with no recorded enqueue time. none is an empty queue.',
    }),
    oldestWriterAgeSeconds: age,
  }),
  editorial: consumerHealth });
export type HorizonHealth = Record<HorizonConsumer, HorizonLag> & {
  sampledAt: string;
  writerVisibility: 'all-sessions' | 'own-role';
  reviewRank: ReviewRankLag;
};
let latest: HorizonHealth | undefined;
export function latestHorizonHealth(): HorizonHealth | undefined { return latest; }

/** Age is measured on the database clock; null means no visible pending row or writer. */
export function lagAgeSeconds(now: Date, oldest: Date | null): number | null {
  return oldest === null ? null : Math.max(0, (now.getTime() - oldest.getTime()) / 1_000);
}

/** Pending-head waiting time. Null enqueue time is unknown, not a reconstructed age. */
export function reviewRankWaitingAge(now: Date, enqueuedAt: Date | null, pending: boolean | null):
  Pick<ReviewRankLag, 'oldestPendingRowAgeSeconds' | 'oldestPendingRowAgeBasis'> {
  if (pending !== true) return { oldestPendingRowAgeSeconds: null, oldestPendingRowAgeBasis: 'none' };
  if (enqueuedAt === null) return { oldestPendingRowAgeSeconds: null, oldestPendingRowAgeBasis: 'unknown' };
  return { oldestPendingRowAgeSeconds: lagAgeSeconds(now, enqueuedAt), oldestPendingRowAgeBasis: 'enqueue' };
}

/** One indexed head seek per consumer (not a backlog scan), plus O(server connections) activity read.
 * The pending head includes committed rows withheld by xmin. Do not apply the
 * horizon filter here: those rows are precisely the lag we need to observe.
 * pg_stat_activity hides other roles without pg_read_all_stats; report visibility.
 * The review seek returns that head's enqueue clock and whether a row exists.
 */
export const horizonLagSql = `SELECT clock_timestamp() AS now,
  CASE WHEN pg_has_role(current_user,'pg_read_all_stats','USAGE') THEN 'all-sessions'
    ELSE 'own-role' END AS "writerVisibility",
  (SELECT created_at FROM access.notification_producer_event e
    WHERE (e.epoch,e.xid,e.id) > COALESCE((SELECT ROW(c.epoch,c.xid,c.id)
      FROM access.notification_producer_cursor c WHERE consumer = 'notification-producer-v1'),
      ROW(0::bigint,'0'::xid8,0::bigint))
    ORDER BY epoch,xid,id LIMIT 1) AS notification,
  review_head.enqueued_at AS "reviewRank",
  review_head.pending AS "reviewRankPending",
  (SELECT created_at FROM access.editorial_event WHERE sequence IS NULL
    ORDER BY epoch,xid,entry LIMIT 1) AS editorial,
  (SELECT min(xact_start) FROM pg_stat_activity WHERE backend_xid IS NOT NULL
    AND pid <> pg_backend_pid()) AS writer
FROM (SELECT 1) AS anchor
LEFT JOIN LATERAL (
  SELECT enqueued_at, true AS pending
  FROM access.reader_review_rank_change
  WHERE position IS NULL
  ORDER BY epoch,xid,id
  LIMIT 1
) AS review_head ON true`;

export async function readHorizonLag(pool: Pick<Pool, 'query'>): Promise<HorizonHealth> {
  const row = (await pool.query<{ now: Date; notification: Date | null;
    reviewRank: Date | null; reviewRankPending: boolean | null; editorial: Date | null; writer: Date | null;
    writerVisibility: HorizonHealth['writerVisibility'] }>(horizonLagSql)).rows[0];
  if (!row) throw new Error('Horizon lag observation unavailable');
  const oldestWriterAgeSeconds = lagAgeSeconds(row.now, row.writer);
  return { sampledAt: row.now.toISOString(), writerVisibility: row.writerVisibility,
    notification: { oldestPendingRowAgeSeconds: lagAgeSeconds(row.now, row.notification), oldestWriterAgeSeconds },
    reviewRank: { ...reviewRankWaitingAge(row.now, row.reviewRank, row.reviewRankPending), oldestWriterAgeSeconds },
    editorial: { oldestPendingRowAgeSeconds: lagAgeSeconds(row.now, row.editorial), oldestWriterAgeSeconds } };
}

/** Reuse the producer's finite polling invocation; no extra scheduler or service. */
export async function observeHorizonLag(pool: Pick<Pool, 'query'>): Promise<void> {
  const health = await readHorizonLag(pool);
  latest = health;
  for (const consumer of horizonConsumerNames) {
    const unknownReview = consumer === 'reviewRank' && health.reviewRank.oldestPendingRowAgeBasis === 'unknown';
    const waiting = consumer === 'reviewRank'
      ? health.reviewRank.oldestPendingRowAgeBasis !== 'none'
      : health[consumer].oldestPendingRowAgeSeconds !== null;
    await withWorkerTelemetry(`main.horizon.${consumer}`, async () => {
      // Null pending age is an empty source, and the gauge stores null as zero.
      // An unstamped review head is still waiting, so omit that number.
      recordWorkerOutcome({
        outcome: waiting ? 'deferred' : 'idle',
        oldestWriterAgeSeconds: health[consumer].oldestWriterAgeSeconds,
        ...(unknownReview ? {} : { oldestPendingRowAgeSeconds: health[consumer].oldestPendingRowAgeSeconds }),
      });
    });
  }
}
