import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  authoritativeTimeValue,
  commandTime,
  CommandUnavailableError,
  DEFAULT_REQUEST_DEADLINE_MS,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { runOperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf } from '../route/route.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { requireRoute } from './command-support.ts';
import apply from './listing-apply.sql';
import page from './listing-page.sql';
import { observeListingSource } from './listing-source-observer.ts';
import type { ListingObservation } from './listing-freshness-contract.ts';

class Unchanged extends Error {}
class StampOnly extends Error {}
class ProjectionChanged extends Error {}
const unchanged = { changed: false } as const;
type Dependencies = { pool: Pool; clock?: () => Date; client?: WorkClient };

/** Trusted projection work: read and release the Collection anchor before entering the subject command. */
export async function syncSubjectListing(
  dependencies: Dependencies,
  { subjectId, collectionId }: { subjectId: string; collectionId: string },
) {
  const source = await observeListingSource(dependencies.pool, { subjectId, collectionId });
  return applySubjectListing(dependencies, source);
}

/** Apply a released native observation; source stamps order first deliveries as well as retries. */
export async function applySubjectListing({ pool, clock, client }: Dependencies, source: ListingObservation) {
  const { subjectId, collectionId, collectionRoute, multiplicity, stamp } = source;
  const route = requireRoute(subjectId);
  if (requireRoute(collectionId) !== collectionRoute || partitionOf(collectionRoute) !== stamp.partition)
    throw new TypeError('Listing source binding changed');
  const partition = partitionOf(route);
  const deadline = Date.now() + DEFAULT_REQUEST_DEADLINE_MS;
  const replace = (tx: CommandTransaction, time: string, transactionId: string) =>
    apply.run(tx, {
      route,
      subject_id: subjectId,
      collection_id: collectionId,
      collection_route: collectionRoute,
      multiplicity,
      source_partition: stamp.partition,
      source_epoch: stamp.epoch,
      source_position: stamp.position.toString(),
      ever_public: source.everPublic || source.currentlyPublic,
      time,
      transaction_id: transactionId,
    });
  while (Date.now() < deadline) {
    try {
      const result = await runCommand(
        pool,
        {
          partition,
          clock,
          deadline,
        },
        async (tx, command) => {
          const rows = await replace(tx, authoritativeTimeValue(command.time), command.transactionId);
          const value = rows[0];
          if (!value?.advanced) throw new Unchanged();
          // Roll back: noEffect cannot conceal persisted ordering/coordination writes.
          if (!value.projectionChanged) throw new StampOnly();
          return {
            value,
            events: [{ type: 'com.rezics.library.subject.listed.v1', subject: subjectId, data: { subjectId } }],
          };
        },
      );
      return { ...result, changed: result.value.projectionChanged };
    } catch (error) {
      if (error instanceof Unchanged) return unchanged;
      if (!(error instanceof StampOnly)) throw error;
    }
    // Registered work reuses its client. Direct native callers own a short-lived client,
    // with the same supplied database pool; no work is enqueued for ordering metadata.
    const work = client ?? (await createWorkClient(pool.options.connectionString!, pool));
    try {
      await runOperationalTransaction(
        pool,
        {
          mode: 'work-step',
          partition,
          kind: 'library.listing.order',
          accounts: [],
          workClient: work,
          clock,
          deadline,
        },
        async (tx) => {
          const rows = await replace(tx, authoritativeTimeValue(commandTime(tx)!), randomUUID());
          if (rows[0]?.projectionChanged) throw new ProjectionChanged();
        },
      );
      return unchanged;
    } catch (error) {
      // A competing replacement changed the public value: retry in the command envelope.
      if (!(error instanceof ProjectionChanged)) throw error;
    } finally {
      if (!client) await work.close();
    }
  }
  throw new CommandUnavailableError('deadline', partition);
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
