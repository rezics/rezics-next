import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { authoritativeTimeValue, runCommand } from '../command/command.ts';
import readTime from '../command/time.sql';
import { withConnection } from '../database/pool.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaEventData, MediaEventType } from './media-events.ts';
import selectCandidates from './select-collectable-media.sql';
import fenceCollection from './fence-collection.sql';
import finishCollection from './finish-collection.sql';

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
      for (let offset = 0; offset < 16; offset++) {
        candidates.push(
          ...(await selectCandidates.run(client, { route: partition * 16 + offset, at: time.at, batch })),
        );
      }
      // Each of the 32 index seeks contributes at most K rows. The only cross-route
      // sort is over this bounded host array, never over stored partition rows.
      return candidates
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.mediaId.localeCompare(b.mediaId))
        .slice(0, batch);
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
    if (!Number.isInteger(partition) || partition < 0 || partition > 4095) throw new RangeError('Invalid partition');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new RangeError('Invalid batch size');
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
