import type { PoolClient } from 'pg';
export type CollectionDiscoveryFollowCountKey = Readonly<{ route: number; id: string }>;

export async function readCollectionDiscoveryFollowCounts(
  client: Pick<PoolClient, 'query'>,
  keys: readonly CollectionDiscoveryFollowCountKey[],
): Promise<ReadonlyMap<string, string | null>> {
  if (keys.length === 0) return new Map();
  const rows = await client.query<{ id: string; total: string | null }>(
    `SELECT requested.id::text AS id, counts.total::text AS total
     FROM unnest($1::integer[], $2::uuid[]) requested(route,id)
     LEFT JOIN library.follow_count_total counts
       ON counts.route=requested.route AND counts.target_type='collection' AND counts.target_id=requested.id
     ORDER BY requested.route,requested.id`,
    [keys.map((key) => key.route), keys.map((key) => key.id)],
  );
  return new Map(rows.rows.map(({ id, total }) => [id, total]));
}
