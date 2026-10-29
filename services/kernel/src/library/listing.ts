import type { Pool } from 'pg';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import { requireRoute } from './command-support.ts';
import apply from './listing-apply.sql';
import page from './listing-page.sql';
import { observeListingSource } from './listing-source-observer.ts';
import type { ListingObservation } from './listing-freshness-contract.ts';

class Unchanged extends Error {}
const unchanged = { changed: false } as const;

/** Trusted projection work: read and release the Collection anchor before entering the subject command. */
export async function syncSubjectListing(
  { pool, clock }: { pool: Pool; clock?: () => Date },
  { subjectId, collectionId }: { subjectId: string; collectionId: string },
) {
  const source = await observeListingSource(pool, { subjectId, collectionId });
  return applySubjectListing({ pool, clock }, source);
}

/** Apply a released native observation; source stamps order first deliveries as well as retries. */
export async function applySubjectListing(
  { pool, clock }: { pool: Pool; clock?: () => Date },
  source: ListingObservation,
) {
  const { subjectId, collectionId, collectionRoute, multiplicity, stamp } = source;
  const route = requireRoute(subjectId);
  if (requireRoute(collectionId) !== collectionRoute || partitionOf(collectionRoute) !== stamp.partition)
    throw new TypeError('Listing source binding changed');
  try {
    const result = await runCommand(
      pool,
      {
        partition: partitionOf(route),
        clock,
      },
      async (tx, command) => {
        const rows = await apply.run(tx, {
          route,
          subject_id: subjectId,
          collection_id: collectionId,
          collection_route: collectionRoute,
          multiplicity,
          source_partition: stamp.partition,
          source_epoch: stamp.epoch,
          source_position: stamp.position.toString(),
          ever_public: source.everPublic || source.currentlyPublic,
          time: authoritativeTimeValue(command.time),
          transaction_id: command.transactionId,
        });
        const value = rows[0];
        if (!value?.advanced) throw new Unchanged();
        // Ordering metadata is derived bookkeeping, not a public domain change.
        if (!value.projectionChanged) return noEffect(value);
        return {
          value,
          events: [{ type: 'com.rezics.library.subject.listed.v1', subject: subjectId, data: { subjectId } }],
        };
      },
    );
    return { ...result, changed: result.value.projectionChanged };
  } catch (error) {
    if (error instanceof Unchanged) return unchanged;
    throw error;
  }
}

/** Public Collection pairs in Collection ID order, bounded by a subject-leading keyset seek. */
export async function subjectCollections(pool: Pool, subjectId: string, after: string | null, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000)
    throw new RangeError('Page limit must be an integer from 1 through 5000');
  const route = requireRoute(subjectId);
  if (after !== null) requireRoute(after);
  return withConnection(pool, async (client) => {
    const rows = await page.run(
      { query: client.query.bind(client) },
      { route, subject_id: subjectId, after: after ?? '00000000-0000-0000-0000-000000000000', limit },
    );
    return rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() }));
  });
}
