import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { lookupEventType } from '../events/catalogue.ts';
import { REVIEW_DISCOVERY_CHANGED } from '../content/review-discovery-events.ts';
import { readReviewDiscoveryChanges, refreshReviewDiscoveryChanges } from '../content/review-discovery-changes.ts';
import type { ReviewDiscoverySource } from '../content/review-discovery.ts';
import { discoveryGenerations } from './generations.ts';
import { withDiscoveryTarget, type DiscoveryProjection, type DiscoveryTarget } from './account-discovery.ts';

/** Increment when the installed native read/Format2 projection meaning changes. */
export const REVIEW_RECEIVING_MEANING = 'content-review-current-format2-v1';
export const REVIEW_RECEIVING_BATCH = 100;
const maxPosition = 9_223_372_036_854_775_807n;
const targetWhere = 'prefix=$1 AND generation=$2 AND index_uuid=$3 AND incarnation=$4 AND meaning=$5';
const where = `${targetWhere} AND partition_no=$6`;
const parameters = (target: DiscoveryTarget) => [
  target.prefix,
  target.generation,
  target.uuid,
  target.incarnation,
  REVIEW_RECEIVING_MEANING,
];
function partition(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 4095) throw new RangeError('Invalid receiving partition');
}

type Stored = {
  acknowledged: string;
  requested: string;
  through: string | null;
  completed_cut: string;
  native_position: string | null;
  status: 'preparing' | 'ready' | 'unavailable';
  claim: string | null;
};
export type ReviewReceivingFrontier = Readonly<{
  target: DiscoveryTarget;
  meaning: typeof REVIEW_RECEIVING_MEANING;
  partition: number;
  status: 'preparing' | 'ready' | 'unavailable';
  acknowledged: bigint;
  requested: bigint;
  /** Incomplete fixed pass, or null after its final visible application. */
  through: bigint | null;
  completedCut: bigint;
  nativePosition: bigint | null;
}>;

/** Exact partition readiness only. Never a population, upstream-dispatch or disclosure certificate. */
export async function readReviewDiscoveryReceiving(
  pool: Pool,
  target: DiscoveryTarget,
  home: number,
): Promise<ReviewReceivingFrontier> {
  partition(home);
  const row = (
    await pool.query<Stored>(
      `SELECT acknowledged::text,requested::text,through::text,completed_cut::text,native_position::text,status,claim
     FROM search.review_discovery_receiving WHERE ${where}`,
      [...parameters(target), home],
    )
  ).rows[0];
  return {
    target: { ...target },
    meaning: REVIEW_RECEIVING_MEANING,
    partition: home,
    status: row?.status ?? 'preparing',
    acknowledged: BigInt(row?.acknowledged ?? 0),
    requested: BigInt(row?.requested ?? 0),
    through: row?.through === null || !row ? null : BigInt(row.through),
    completedCut: BigInt(row?.completed_cut ?? 0),
    nativePosition: row?.native_position === null || !row ? null : BigInt(row.native_position),
  };
}

async function ensure(pool: Pool, target: DiscoveryTarget, home: number) {
  await pool.query(
    `INSERT INTO search.review_discovery_receiving(prefix,generation,index_uuid,incarnation,meaning,partition_no)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [...parameters(target), home],
  );
}

/** Events carry identities/original provenance, never an index body or a Content revision ordering. */
export async function requestReviewDiscoveryReceiving(pool: Pool, prefix: string, data: unknown): Promise<void> {
  if (!lookupEventType(REVIEW_DISCOVERY_CHANGED)?.Check(data)) throw new TypeError('Invalid review receiving wakeup');
  const wake = data as { partition: number; through: string };
  if (BigInt(wake.through) > maxPosition) throw new RangeError('Review receiving wakeup exceeds native position');
  for (const target of await discoveryGenerations(pool, prefix)) {
    if (!target.uuid || ['retired', 'retiring', 'quarantined', 'allocated'].includes(target.state)) continue;
    await ensure(pool, target, wake.partition);
    await pool.query(
      `UPDATE search.review_discovery_receiving SET requested=GREATEST(requested,$7::bigint),
       pending=pending OR $7::bigint>acknowledged,
       status=CASE WHEN $7::bigint>acknowledged THEN 'preparing' ELSE status END WHERE ${where}`,
      [...parameters(target), wake.partition, wake.through],
    );
  }
}

const encode = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? item.toString() : item));

/** One admitted page. A short durable claim releases the checkout before native refresh (including max=1 pools).
 * Target session custody then fences staging, index application, visible observation and acknowledged progress.
 * An expired claimant cannot write after its successor: claim validation is inside that same target custody.
 */
export function createReviewDiscoveryReceiving(options: {
  pool: Pool;
  search: Parameters<typeof withDiscoveryTarget>[1];
  projection: DiscoveryProjection;
  source?: ReviewDiscoverySource;
  batchSize?: number;
}) {
  const { pool, search, projection, source } = options;
  const target = projection.target;
  const batch = options.batchSize ?? REVIEW_RECEIVING_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 100) throw new RangeError('Invalid review receiving page limit');

  async function step(home: number): Promise<ReviewReceivingFrontier> {
    partition(home);
    await ensure(pool, target, home);
    const values = [...parameters(target), home];
    const claim = randomUUID();
    const claimed = (
      await pool.query<Stored>(
        `UPDATE search.review_discovery_receiving SET claim=$7,claim_until=clock_timestamp()+interval '30 seconds',
       pending=true,status='preparing' WHERE ${where}
       AND (claim IS NULL OR claim_until<=clock_timestamp())
       RETURNING acknowledged::text,requested::text,through::text,completed_cut::text,native_position::text,status,claim`,
        [...values, claim],
      )
    ).rows[0];
    if (!claimed) return readReviewDiscoveryReceiving(pool, target, home);
    try {
      if (!source) throw new Error('Native review receiving source is unavailable');
      // Recover by reading current native rows again. A staged body is never a refresh cache.
      const page = await readReviewDiscoveryChanges(
        pool,
        home,
        BigInt(claimed.acknowledged),
        batch,
        claimed.through === null ? undefined : BigInt(claimed.through),
      );
      const retained = await pool.query(
        `UPDATE search.review_discovery_receiving SET through=$8,stage=$9::jsonb WHERE ${where} AND claim=$7`,
        [...values, claim, page.through.toString(), encode({ page })],
      );
      if (retained.rowCount !== 1) return readReviewDiscoveryReceiving(pool, target, home);
      const ids = [...new Set(page.changes.map((change) => change.id))];
      const refreshed = ids.length ? await refreshReviewDiscoveryChanges(source, page) : undefined;
      const actions = refreshed ? await projection.prepareReviews(refreshed, ids) : [];
      await withDiscoveryTarget(pool, search, target, async (client, index) => {
        const admitted = await client.query(
          `UPDATE search.review_discovery_receiving SET stage=$8::jsonb WHERE ${where}
           AND claim=$7 AND claim_until>clock_timestamp()`,
          [...values, claim, encode({ page, actions, nativePosition: refreshed?.nativePosition ?? null })],
        );
        if (admitted.rowCount !== 1) throw new Error('Review receiving claim was superseded or expired');
        await projection.applyReviews(actions, {
          client,
          index,
          async acknowledge() {
            // Copy settlement and receiving frontier commit in the same PostgreSQL transaction,
            // only after the exact engine effects have become visible. A lost response repeats refresh.
            const result = await client.query(
              `UPDATE search.review_discovery_receiving SET acknowledged=$8,
               through=$9,completed_cut=CASE WHEN $9::bigint IS NULL THEN $10 ELSE completed_cut END,
               native_position=COALESCE($11::bigint,native_position),stage=NULL,
               pending=($9::bigint IS NOT NULL OR requested>$8::bigint),
               status=CASE WHEN $9::bigint IS NOT NULL OR requested>$8::bigint THEN 'preparing' ELSE 'ready' END,
               claim=NULL,claim_until=NULL WHERE ${where} AND claim=$7 AND acknowledged=$12::bigint`,
              [
                ...values,
                claim,
                page.after.toString(),
                page.next === null ? null : page.through.toString(),
                page.through.toString(),
                refreshed?.nativePosition.toString() ?? null,
                claimed.acknowledged,
              ],
            );
            if (result.rowCount !== 1) throw new Error('Review receiving acknowledgement lost its claim');
          },
        });
      });
      return await readReviewDiscoveryReceiving(pool, target, home);
    } catch (error) {
      await pool.query(
        `UPDATE search.review_discovery_receiving SET status='unavailable',pending=true,claim=NULL,claim_until=NULL
         WHERE ${where} AND claim=$7`,
        [...values, claim],
      );
      throw error;
    }
  }

  /** Fair indexed pending seeks, with a fixed 4096-partition sweep for restart and missed wakeups.
   * The existing supervisor calls this once per live target; there is no second poller or drain loop.
   */
  async function next() {
    const values = parameters(target);
    const home = await withConnection(pool, async (client) => {
      await client.query(
        `INSERT INTO search.review_discovery_receiving_scan(prefix,generation,index_uuid,incarnation,meaning)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        values,
      );
      const cursor = (
        await client.query<{ partition_no: number }>(
          `SELECT partition_no FROM search.review_discovery_receiving_scan WHERE ${targetWhere}`,
          values,
        )
      ).rows[0]!.partition_no;
      let due: number | undefined;
      // Two keyset seeks implement wraparound, both bounded by the fixed native partition domain.
      for (const after of [cursor, 0]) {
        const selected = (
          await client.query<{ partition_no: number }>(
            `SELECT partition_no FROM search.review_discovery_receiving WHERE ${targetWhere}
           AND pending AND partition_no>=$6 AND (claim IS NULL OR claim_until<=clock_timestamp())
           ORDER BY partition_no LIMIT 1`,
            [...values, after],
          )
        ).rows[0];
        if (selected) {
          due = selected.partition_no;
          break;
        }
      }
      const selected = due ?? cursor;
      await client.query(`UPDATE search.review_discovery_receiving_scan SET partition_no=$6 WHERE ${targetWhere}`, [
        ...values,
        (selected + 1) % 4096,
      ]);
      return selected;
    });
    return step(home);
  }
  return { step, next, status: (home: number) => readReviewDiscoveryReceiving(pool, target, home) };
}
