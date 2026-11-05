import type { PoolClient } from 'pg';
import { PARTITIONS, routeOf } from '../route/route.ts';
import sitemapPage from './sitemap-page.sql';

type QueryClient = Pick<PoolClient, 'query'>;

export type SitemapCandidate = { route: number; id: string; updatedAt: string };
export type SitemapAfter = { route: number; id: string };

const MAX_LIMIT = 4000;
const ROUTES_PER_PARTITION = 16;
// The first page seeks from the route before the partition, so this id is never compared.
const UNUSED_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * Reads at most `limit` active, public Collection identities of one partition after a checkpoint, in ascending
 * `(route, collection_id)` order. The result is an internal discovery hint: it is never anonymous disclosure authority,
 * and `updatedAt` is the stored timestamp as exact UTC text for the caller to serialize.
 */
export async function readSitemapCandidates(
  client: QueryClient,
  input: { partition: number; after: SitemapAfter | null; limit: number },
): Promise<SitemapCandidate[]> {
  const { partition, after, limit } = input;
  if (!Number.isSafeInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError(`Partition must be an integer from 0 to ${PARTITIONS - 1}`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new RangeError(`Limit must be an integer from 1 to ${MAX_LIMIT}`);
  const first = partition * ROUTES_PER_PARTITION;
  if (after !== null) {
    if (typeof after !== 'object' || !Number.isSafeInteger(after.route))
      throw new TypeError('Checkpoint route must be an integer');
    if (after.route < first || after.route >= first + ROUTES_PER_PARTITION)
      throw new RangeError('Checkpoint route belongs to a different partition');
    if (routeOf(after.id) !== after.route) throw new RangeError('Checkpoint id does not carry the checkpoint route');
  }
  const rows = await sitemapPage.run(client, {
    partition_no: partition,
    // Without a checkpoint, the tuple seek starts just before the partition's first route.
    after_route: after?.route ?? first - 1,
    after_id: after?.id ?? UNUSED_ID,
    page_limit: limit,
  });
  return rows.map((row) => ({ route: row.route, id: row.id, updatedAt: row.updatedAt }));
}
