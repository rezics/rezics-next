import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authoritativeTimeValue, runCommand } from '../command/command.ts';
import readTime from '../command/time.sql';
import { withConnection } from '../database/pool.ts';
import { PARTITIONS, ROUTES } from '../route/route.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaEventData, MediaEventType } from './media-events.ts';
import selectCandidates from './select-collectable-media.sql';
import fenceCollection from './fence-collection.sql';
import finishCollection from './finish-collection.sql';

const ROUTES_PER_PARTITION = ROUTES / PARTITIONS;
const MAX_BATCH_SIZE = 100;
const SELECTION_BRANCHES = 2;
/** SQL bounds each branch before the host merges exact routes. Deletion and
 * the two command phases run sequentially for at most one selected batch.
 */
export const COLLECTION_BOUNDS = Object.freeze({
  routes: ROUTES_PER_PARTITION,
  batch: MAX_BATCH_SIZE,
  selectedCandidates: ROUTES_PER_PARTITION * SELECTION_BRANCHES * MAX_BATCH_SIZE,
  bufferedCandidates: (1 + SELECTION_BRANCHES) * MAX_BATCH_SIZE,
  commands: 2 * MAX_BATCH_SIZE,
  prefixes: MAX_BATCH_SIZE,
  concurrency: 1,
});

export type CollectionOutcome = Readonly<{
  partition: number;
  examined: number;
  collected: number;
  complete: boolean;
}>;
export type CollectionJob = Readonly<{
  collectPartition(partition: number, batchSize: number): Promise<CollectionOutcome>;
}>;
/** Composition-only configuration. Job invocations accept no clock or authority input. */
type CollectionConfiguration = Readonly<{ clock?: () => Date }>;
type Candidate = Readonly<{
  route: number;
  mediaId: string;
  containerId: string;
  uploaderId: string;
  createdAt: string;
}>;
class Unchanged extends Error {}
function event<T extends MediaEventType>(type: T, data: MediaEventData<T>) {
  return { type, subject: data.mediaId, data };
}

/** An internal service capability, consumed by trusted worker composition. */
export function createCollectionJob(
  pool: Pool,
  storage: MediaStorage,
  configuration: CollectionConfiguration = {},
): CollectionJob {
  const clock = configuration.clock;
  async function selectCollectableMedia(partition: number, batch: number): Promise<Candidate[]> {
    return withConnection(pool, async (client) => {
      const configured = clock?.();
      if (configured && !Number.isFinite(configured.getTime())) throw new TypeError('Invalid collection clock');
      const time = await readTime.run(client, { at: configured?.toISOString() ?? '' });
      if (!time) throw new TypeError('No authoritative database time');
      const candidates: Candidate[] = [];
      for (let offset = 0; offset < ROUTES_PER_PARTITION; offset++) {
        const route = partition * ROUTES_PER_PARTITION + offset;
        candidates.push(
          ...(await selectCandidates.run(client, {
            route,
            at: time.at,
            batch,
            pending_batch: batch,
          })),
        );
        // Discard only candidates that already have a full earlier batch ahead
        // of them. Later routes cannot make those discarded candidates eligible
        // for this step, so retain at most K between the exact-route seeks.
        candidates.sort(
          (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.mediaId.localeCompare(b.mediaId),
        );
        candidates.splice(batch);
      }
      // At most 32K candidates are read; each host merge holds at most 3K.
      // The SQL never sorts or scans an unbounded partition candidate set.
      return candidates;
    });
  }
  function options(partition: number, candidate: Candidate, phase: 'fence' | 'finish') {
    const kind = `content.media.collection.${phase}`;
    return {
      partition,
      clock,
      deadline: Date.now() + 30_000,
      receipt: {
        actorAccountId: candidate.uploaderId,
        kind,
        key: candidate.mediaId,
        digest: createHash('sha256').update(`${kind}:${candidate.mediaId}`).digest(),
      },
    };
  }
  async function collectPartition(partition: number, batchSize: number): Promise<CollectionOutcome> {
    if (!Number.isInteger(partition) || partition < 0 || partition >= PARTITIONS)
      throw new RangeError('Invalid partition');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE)
      throw new RangeError('Invalid batch size');
    const candidates = await selectCollectableMedia(partition, batchSize);
    let collected = 0;
    for (const candidate of candidates) {
      try {
        await runCommand(pool, options(partition, candidate, 'fence'), async (tx, command) => {
          const fenced = await fenceCollection.run(tx, {
            route: candidate.route,
            media_id: candidate.mediaId,
            at: authoritativeTimeValue(command.time),
            transaction_id: command.transactionId,
          });
          if (!fenced) throw new Unchanged();
          return {
            value: fenced,
            events: [event('com.rezics.content.media.collection-pending.v1', fenced)],
          };
        });
      } catch (error) {
        if (error instanceof Unchanged) continue;
        throw error;
      }
      // runCommand has committed and released its connection. Failures leave the
      // fence and receipt durable, so neither claims nor processing may publish.
      await storage.deletePrefix(`m/${candidate.mediaId}/`);
      try {
        const finished = await runCommand(pool, options(partition, candidate, 'finish'), async (tx) => {
          const removed = await finishCollection.run(tx, { route: candidate.route, media_id: candidate.mediaId });
          if (!removed) throw new Unchanged();
          return { value: removed, events: [event('com.rezics.content.media.collected.v1', removed)] };
        });
        if (!finished.replayed) collected++;
      } catch (error) {
        if (!(error instanceof Unchanged)) throw error;
      }
    }
    return { partition, examined: candidates.length, collected, complete: candidates.length < batchSize };
  }
  return Object.freeze({ collectPartition });
}
export function collectPartition(
  pool: Pool,
  storage: MediaStorage,
  partition: number,
  batchSize: number,
): Promise<CollectionOutcome> {
  return createCollectionJob(pool, storage).collectPartition(partition, batchSize);
}
