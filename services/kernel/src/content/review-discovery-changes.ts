import type { Pool } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { withReadTransaction } from '../semantic/read.ts';
import { REVIEW_DISCOVERY_CHANGE_LIMIT } from './review-discovery-lifecycle.ts';
import type { ReviewDiscoveryOrigin } from './review-discovery-events.ts';
import type { IndexedReview, ReviewDiscoverySource } from './review-discovery.ts';

/** A receiving position orders invalidations, never native content revisions. */
export type ReviewDiscoveryChange = Readonly<{
  id: string;
  position: bigint;
  origin: ReviewDiscoveryOrigin;
}>;
export type ReviewDiscoveryChangePage = Readonly<{
  partition: number;
  /** Stable journal cut for this catch-up pass; pass it back on continuation. */
  through: bigint;
  /** Progress includes empty ranges. */
  after: bigint;
  next: bigint | null;
  changes: readonly ReviewDiscoveryChange[];
}>;
export type ReviewDiscoveryRefresh = Readonly<{
  partition: number;
  /** Search must serialize/CAS refresh application per receiving partition. */
  after: bigint;
  through: bigint;
  next: bigint | null;
  /** Native source observation, separate from the receiving journal frontier. */
  nativePosition: bigint;
  reviews: readonly IndexedReview[];
  removed: readonly string[];
}>;

/** Exact sparse identity journal. This is not another native population page or census.
 * A complete page proves receiving progress only, not that upstream effects are drained. */
export async function readReviewDiscoveryChanges(
  pool: Pool,
  partition: number,
  after: bigint = 0n,
  limit: number = REVIEW_DISCOVERY_CHANGE_LIMIT,
  through?: bigint,
): Promise<ReviewDiscoveryChangePage> {
  if (
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    typeof after !== 'bigint' ||
    after < 0n ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > REVIEW_DISCOVERY_CHANGE_LIMIT ||
    (through !== undefined && (typeof through !== 'bigint' || through < after))
  )
    throw new RangeError('Invalid review discovery change frontier');
  return withReadTransaction(
    pool,
    async (client) => {
      const native = await readPartition(client, partition);
      if (!native || native.writeState !== 'active') throw new CommandUnavailableError('fenced', partition);
      const head = (
        await client.query<{ position: string }>(
          `SELECT position::text FROM content.review_discovery_frontier WHERE route=$1`,
          [partition * 16],
        )
      ).rows[0];
      const current = BigInt(head?.position ?? '0');
      const cut = through ?? current;
      if (cut > current || after > cut) throw new RangeError('Review discovery change frontier is ahead of source');
      const rows = (
        await client.query<{ id: string; position: string; origin: ReviewDiscoveryOrigin }>(
          `SELECT thread_id AS id,position::text,origin FROM content.review_discovery_change
       WHERE partition_no=$1 AND position>$2::bigint AND position<=$3::bigint
       ORDER BY position LIMIT $4`,
          [partition, after.toString(), cut.toString(), limit + 1],
        )
      ).rows;
      const changes = rows.slice(0, limit).map((row) => ({ ...row, position: BigInt(row.position) }));
      const more = rows.length > limit;
      const progressed = more ? changes.at(-1)!.position : cut;
      return { partition, through: cut, after: progressed, next: more ? progressed : null, changes };
    },
    Date.now() + 30_000,
  );
}

/** Search's refresh linkage: every examined identity has an explicit current upsert or
 * removal. Missing native rows and loss of disclosure are both removals. Failures throw,
 * leaving consumer progress unacknowledged. No historical event body is hydrated. */
export async function refreshReviewDiscoveryChanges(
  source: ReviewDiscoverySource,
  page: ReviewDiscoveryChangePage,
): Promise<ReviewDiscoveryRefresh> {
  const ids = [...new Set(page.changes.map((change) => change.id))];
  if (ids.length > REVIEW_DISCOVERY_CHANGE_LIMIT) throw new RangeError('Review discovery refresh exceeds batch bound');
  const snapshot = await source.read(page.partition, ids);
  const present = new Set(snapshot.reviews.map((review) => review.id));
  return {
    partition: page.partition,
    after: page.after,
    through: page.through,
    next: page.next,
    nativePosition: snapshot.position,
    reviews: snapshot.reviews,
    removed: ids.filter((id) => !present.has(id)),
  };
}
