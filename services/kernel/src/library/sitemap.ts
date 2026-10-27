import type { Pool } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import type { KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { PARTITIONS } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createCollectionReads } from './collection-reads.ts';
import { readSitemapCandidates, type SitemapAfter } from './sitemap-discovery.ts';
import { decodeSitemapPosition, encodeSitemapPosition, type SitemapPosition } from './sitemap-position.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; clock: KernelClock };

/** A bounded, live anonymous walk. Discovery hints never authorize disclosure. */
export async function listSitemapCollections(
  dependencies: Dependencies,
  deadline: number,
  input: { cursor?: string; limit?: number },
): Promise<{ items: { id: string; lastModified: string }[]; next: string | null }> {
  const { pool, access, tokens, clock } = dependencies;
  const limit = input.limit ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new ProblemError('invalid_request');
  const reader = { kind: 'anonymous' } as const;
  const cursor = await decodeSitemapPosition(tokens, limit, input.cursor, clock());
  try {
    await admitGroup({
      pool,
      access: () => access,
      actor: reader,
      group: 'collections',
      clientAction: 'collection:read',
      deadline,
      clock,
    });
  } catch (error) {
    if (error instanceof PlatformClosedError) return { items: [], next: null };
    throw error;
  }
  const reads = createCollectionReads({ pool, access, tokens });
  const items: { id: string; lastModified: string }[] = [];
  let partition = cursor?.partition ?? 0;
  let after: SitemapAfter | null = cursor?.after ?? null;
  let checkpoint: SitemapPosition | null = cursor;
  let budget = 4 * limit;
  for (let visited = 0; visited < 4 && partition < PARTITIONS && budget > 0 && items.length < limit; visited++) {
    const observation = await withConnection(pool, async (client) => {
      const bounded = deadlineClient(client, deadline);
      const current = await readPartition(bounded, partition);
      if (!current || current.writeState === 'moved') throw new ProblemError('partition_unavailable');
      if (cursor?.partition === partition && cursor.epoch !== current.epoch) throw new ProblemError('stale_cursor');
      // Validate the exhausted partition's epoch before crossing its boundary. It is not an empty unvisited partition.
      if (cursor?.partition === partition && cursor.exhausted) return { epoch: current.epoch, rows: null };
      const rows = await readSitemapCandidates(bounded, { partition, after, limit: budget });
      return { epoch: current.epoch, rows };
    });
    if (observation.rows === null) {
      partition++;
      after = null;
      continue;
    }
    const rows = observation.rows;
    const exhausted = rows.length < budget;
    // Charge the entire fetched batch, including any suffix that the output limit leaves for the next request.
    budget -= rows.length;
    for (const row of rows) {
      checkpoint = { partition, epoch: observation.epoch, exhausted: false, after: { route: row.route, id: row.id } };
      try {
        const collection = await reads.readCollection(reader, row.id, deadline);
        if (collection.visibility === 'public') items.push({ id: collection.id, lastModified: collection.updatedAt });
      } catch (error) {
        if (!(error instanceof ProblemError && error.code === 'not_found')) throw error;
      }
      // Never move the checkpoint past an unreturned eligible suffix, even when discovery already fetched it.
      if (items.length === limit) break;
    }
    if (items.length === limit) break;
    if (!exhausted) break;
    checkpoint = { partition, epoch: observation.epoch, exhausted: true, after: null };
    partition++;
    after = null;
  }
  return {
    items,
    next:
      partition >= PARTITIONS || !checkpoint ? null : await encodeSitemapPosition(tokens, limit, checkpoint, clock()),
  };
}
