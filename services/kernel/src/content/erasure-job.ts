import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaId } from './model.ts';
import readErasedMedia from './read-erased-media.sql';

export type PurgeOutcome = Readonly<{ mediaId: MediaId; outcome: 'purged' | 'already_absent' | 'fenced' }>;
export type ErasureJob = Readonly<{ purgeObject(mediaId: MediaId): Promise<PurgeOutcome> }>;
export function createErasureJob(pool: Pool, storage: MediaStorage): ErasureJob {
  return Object.freeze({ purgeObject: (mediaId: MediaId) => purgeObject(pool, storage, mediaId) });
}

/** Trusted cleanup of an already committed, irreversible media decision. This
 * read neither authorizes erasure nor depends on the uploader's current access.
 */
export async function purgeObject(pool: Pool, storage: MediaStorage, mediaId: MediaId): Promise<PurgeOutcome> {
  const route = routeOf(mediaId);
  if (route === null) throw new RangeError('Erasure job requires a routable media ID');
  const media = await withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const anchor = await readPartition(client, partitionOf(route));
      if (!anchor || anchor.writeState === 'moved') throw new Error('Content partition is unavailable');
      const row = await readErasedMedia.run(client, { route, media_id: mediaId });
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!media) return { mediaId, outcome: 'already_absent' };
  if (!media.erased && media.state !== 'rejected') return { mediaId, outcome: 'fenced' };
  // Image/import publishers await all writes under the media row lock before
  // committing these terminal facts. No late output can follow this purge.
  // Release the read connection first; storage failures escape to the durable
  // worker's retry, while the media row retains the cleanup authority.
  await storage.deletePrefix(`m/${mediaId}/`);
  return { mediaId, outcome: 'purged' };
}
