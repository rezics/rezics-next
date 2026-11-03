/** Native indexing hints only. Current viewer hydration is a separate Commerce boundary. */
import type { Pool, PoolClient } from 'pg';
import { readPartition } from '../partition/partition.ts';
import { PARTITIONS, partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import selectedOutput from './collection-source-output-head.sql';
import type { CollectionOutputRef } from './collection-source-output.ts';

export type CollectionDiscoveryKey = Readonly<{ route: number; id: string }>;
/** The existing public-listing stamp, observed in the same native snapshot as the values. */
export type CollectionDiscoveryPosition = Readonly<{ partition: number; epoch: number; position: string }>;
export type CollectionDiscoveryIndexableValue = Readonly<{
  kind: 'collection';
  key: CollectionDiscoveryKey;
  revision: number;
  title: string;
  description: string | null;
  presentationKind: string | null;
  coverMediaId: string | null;
}> & (
  | { membershipKind: 'curated'; output: null }
  | { membershipKind: 'dynamic'; output: CollectionOutputRef }
);
export type CollectionDiscoveryItem = Readonly<{ key: CollectionDiscoveryKey }> & (
  | { status: 'indexable'; value: CollectionDiscoveryIndexableValue }
  | { status: 'withdrawn' }
  | { status: 'unavailable'; reason: 'selected_publication_witness_unavailable' }
);
export type CollectionDiscoverySnapshot =
  | Readonly<{ status: 'available'; stamp: CollectionDiscoveryPosition; items: readonly CollectionDiscoveryItem[] }>
  | Readonly<{ status: 'unavailable'; reason: 'native_partition_unavailable' }>;
export type CollectionDiscoveryPage = CollectionDiscoverySnapshot & Readonly<{ next: CollectionDiscoveryKey | null }>;
export type CollectionDiscoveryCensus = Readonly<{
  status: 'unavailable';
  reason: 'native_collection_population_evidence_unavailable';
}>;
export type CollectionDiscoverySource = Readonly<{
  read(partition: number, ids: readonly CollectionDiscoveryKey[]): Promise<CollectionDiscoverySnapshot>;
  page(partition: number, after: CollectionDiscoveryKey | null, limit: number): Promise<CollectionDiscoveryPage>;
  count(partition: number): Promise<CollectionDiscoveryCensus>;
}>;

type Row = {
  route: number;
  id: string;
  state: string;
  visibility: string;
  revision: number;
  title: string;
  description: string | null;
  presentationKind: string | null;
  coverMediaId: string | null;
  membershipKind: 'curated' | 'dynamic';
  saved: boolean;
  sourceGeneration: string;
};
const metadata = `c.route,c.collection_id::text AS id,c.state,c.visibility,c.revision,c.title,c.description,
  c.presentation_kind AS "presentationKind",c.cover_media_id::text AS "coverMediaId",
  c.membership_kind AS "membershipKind",(c.builtin_kind IS NULL AND c.rule_revision>0) AS saved,
  c.source_generation::text AS "sourceGeneration"`;

function partitionKey(partition: number) {
  if (!Number.isSafeInteger(partition) || partition < 0 || partition >= PARTITIONS)
    throw new RangeError('Invalid Collection discovery partition');
}
function keyIn(partition: number, key: CollectionDiscoveryKey) {
  if (!Number.isSafeInteger(key.route) || routeOf(key.id) !== key.route || partitionOf(key.route) !== partition)
    throw new TypeError('Collection discovery requires a full routable key in its partition');
}
function compare(a: CollectionDiscoveryKey, b: CollectionDiscoveryKey) {
  return a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function item(client: PoolClient, key: CollectionDiscoveryKey, row?: Row): Promise<CollectionDiscoveryItem> {
  if (!row || row.state !== 'active' || row.visibility !== 'public') return { key, status: 'withdrawn' };
  const common = {
    kind: 'collection' as const,
    key,
    revision: row.revision,
    title: row.title,
    description: row.description,
    presentationKind: row.presentationKind,
    coverMediaId: row.coverMediaId,
  };
  if (row.membershipKind === 'curated')
    return { key, status: 'indexable', value: { ...common, membershipKind: 'curated', output: null } };
  // Saved rules and personal populations are never indexing inputs. Only the installed selected-output
  // witness (including its actual Core commit and current source fence) can supply a public output.
  if (!row.saved) return { key, status: 'unavailable', reason: 'selected_publication_witness_unavailable' };
  const publication = (
    await client.query<{ generation: string }>(selectedOutput.sql, [key.route, key.id, row.sourceGeneration])
  ).rows[0];
  if (!publication) return { key, status: 'unavailable', reason: 'selected_publication_witness_unavailable' };
  return {
    key,
    status: 'indexable',
    value: {
      ...common,
      membershipKind: 'dynamic',
      output: { route: key.route, collectionId: key.id, generation: publication.generation },
    },
  };
}

/** No projection, clock or authorization is owned here. Deliveries must reread current native truth;
 * consumers order replacements/withdrawals by (stamp.epoch, BigInt(stamp.position)), never event arrival.
 */
export function publicCollectionDiscoverySource({ pool }: { pool: Pool }): CollectionDiscoverySource {
  async function snapshot(
    partition: number,
    rows: (client: PoolClient) => Promise<{ keys: readonly CollectionDiscoveryKey[]; rows: Row[] }>,
  ): Promise<CollectionDiscoverySnapshot> {
    return withReadTransaction(pool, async (client) => {
      const owner = await readPartition(client, partition);
      if (!owner || owner.writeState !== 'active' || owner.movedTo !== null)
        return { status: 'unavailable', reason: 'native_partition_unavailable' };
      const found = await rows(client);
      const byId = new Map(found.rows.map((row) => [row.id, row]));
      const items: CollectionDiscoveryItem[] = [];
      for (const key of found.keys) items.push(await item(client, key, byId.get(key.id)));
      return {
        status: 'available',
        stamp: { partition, epoch: owner.epoch, position: owner.position.toString() },
        items,
      };
    });
  }
  return {
    async read(partition, ids) {
      partitionKey(partition);
      if (ids.length > 100) throw new RangeError('Collection discovery reads at most 100 keys');
      for (const key of ids) keyIn(partition, key);
      const keys = [...new Map(ids.map((key) => [key.id, key])).values()].sort(compare);
      return snapshot(partition, async (client) => ({
        keys,
        rows: (
          await client.query<Row>(
            `SELECT ${metadata} FROM unnest($1::integer[],$2::uuid[]) AS k(route,id)
             JOIN library.collection c ON c.route=k.route AND c.collection_id=k.id
             WHERE c.route >= $3*16 AND c.route < ($3+1)*16`,
            [keys.map((key) => key.route), keys.map((key) => key.id), partition],
          )
        ).rows,
      }));
    },
    async page(partition, after, limit) {
      partitionKey(partition);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new RangeError('Collection discovery pages require 1..100 keys');
      if (after !== null) keyIn(partition, after);
      const result = await snapshot(partition, async (client) => {
        // Existing partial public-listing index bounds raw work even if every dynamic witness is absent.
        const rows = (
          await client.query<Row>(
            `SELECT ${metadata} FROM library.collection c
             WHERE c.route >= $1*16 AND c.route < ($1+1)*16
               AND (c.route,c.collection_id)>($2::integer,$3::uuid)
               AND c.state='active' AND c.visibility='public'
             ORDER BY c.route,c.collection_id LIMIT $4`,
            [partition, after?.route ?? partition * 16 - 1, after?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff', limit],
          )
        ).rows;
        return { keys: rows.map(({ route, id }) => ({ route, id })), rows };
      });
      return {
        ...result,
        next: result.status === 'available' && result.items.length === limit ? result.items.at(-1)!.key : null,
      };
    },
    async count(partition) {
      partitionKey(partition);
      // No installed native maintained population witness exists. A scan or query count is not a census.
      return { status: 'unavailable', reason: 'native_collection_population_evidence_unavailable' };
    },
  };
}
