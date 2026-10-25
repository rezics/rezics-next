import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authoritativeTimeValue, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import { requireRoute } from './command-support.ts';
import apply from './listing-apply.sql';
import page from './listing-page.sql';
import readSource from './listing-source.sql';

class Unchanged extends Error {}
const unchanged = { changed: false } as const;

/** Trusted projection work: read and release the Collection anchor before entering the subject command. */
export async function syncSubjectListing(
  { pool, clock }: { pool: Pool; clock?: () => Date },
  { subjectId, collectionId }: { subjectId: string; collectionId: string },
) {
  const route = requireRoute(subjectId);
  const collectionRoute = requireRoute(collectionId);
  // One statement sees both the Collection state and its members in the same source snapshot.
  const source = await withConnection(pool, (client) =>
    readSource.run(
      { query: client.query.bind(client) },
      { route: collectionRoute, collection_id: collectionId, subject_id: subjectId },
    ),
  );
  const multiplicity = source?.multiplicity ?? 0;
  // Include the source transaction so public/private/public cycles cannot replay an obsolete receipt.
  const digest = createHash('sha256')
    .update(JSON.stringify([subjectId, collectionId, source?.transactionId ?? null, multiplicity]))
    .digest();
  try {
    const result = await runCommand(
      pool,
      {
        partition: partitionOf(route),
        clock,
        // The subject namespaces this internal receipt; no request actor or write basis is supplied.
        receipt: {
          actorAccountId: subjectId,
          kind: 'library.subject.listing.sync',
          key: digest.toString('hex'),
          digest,
        },
      },
      async (tx, command) => {
        const rows = await apply.run(tx, {
          route,
          subject_id: subjectId,
          collection_id: collectionId,
          collection_route: collectionRoute,
          multiplicity,
          time: authoritativeTimeValue(command.time),
          transaction_id: command.transactionId,
        });
        const value = rows[0];
        if (!value) throw new Unchanged();
        return {
          value,
          events: [{ type: 'com.rezics.library.subject.listed.v1', subject: subjectId, data: { subjectId } }],
        };
      },
    );
    return { ...result, changed: true as const };
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
