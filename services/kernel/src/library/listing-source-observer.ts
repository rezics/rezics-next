import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { ListingKey, ListingObservation } from './listing-freshness-contract.ts';
import observation from './listing-source-observation.sql';

type Client = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
type Truth = Pick<ListingObservation, 'multiplicity' | 'currentlyPublic' | 'everPublic'>;
type Source = {
  readPartition(client: Client, partition: number): Promise<Partition | null>;
  readTruth(client: Client, key: ListingKey): Promise<Truth>;
};

const defaultSource: Source = {
  readPartition,
  async readTruth(client: Pick<PoolClient, 'query'>, key: ListingKey) {
    const row = await observation.run(
      { query: client.query.bind(client) },
      { route: routeOf(key.collectionId)!, collection_id: key.collectionId, subject_id: key.subjectId },
    );
    if (!row) throw new Error('Listing source truth returned no row');
    return row;
  },
};

/** Internal source truth, released before return; this grants no disclosure authority. */
export function createListingSourceObserver({ pool, source = defaultSource }: { pool: Pool; source?: Source }) {
  return async (key: ListingKey): Promise<ListingObservation> => {
    const collectionRoute = routeOf(key.collectionId);
    if (collectionRoute === null) throw new TypeError('Collection id must carry a valid route');
    if (routeOf(key.subjectId) === null) throw new TypeError('Subject id must carry a valid route');
    const partition = partitionOf(collectionRoute);

    return withReadTransaction(pool, async (client) => {
      const owner = await source.readPartition(client, partition);
      if (!owner) throw new CommandUnavailableError('deadline', partition);
      if (owner.writeState === 'moved') throw new CommandUnavailableError('moved', partition, owner.movedTo);
      if (owner.writeState === 'fenced') throw new CommandUnavailableError('fenced', partition);
      const stamp = { partition, epoch: owner.epoch, position: owner.position };
      const { multiplicity, currentlyPublic, everPublic } = await source.readTruth(client, key);
      return {
        subjectId: key.subjectId,
        collectionId: key.collectionId,
        collectionRoute,
        stamp,
        multiplicity,
        currentlyPublic,
        everPublic,
      };
    });
  };
}

export function observeListingSource(pool: Pool, key: ListingKey): Promise<ListingObservation> {
  return createListingSourceObserver({ pool })(key);
}
