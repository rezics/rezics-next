import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError } from '../command/command.ts';
import { readPartition, type Partition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import type { ListingKey, ListingObservation } from './listing-freshness-contract.ts';
import observation from './listing-source-observation.sql';
import { readLiveCopyDomain } from './access-port.ts';
import { LiveCopyPendingError } from '../access/contract/errors.ts';

type Client = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> };
type Truth = Pick<ListingObservation, 'multiplicity' | 'currentlyPublic' | 'everPublic'>;
type Source = {
  readPartition(client: Client, partition: number): Promise<Partition | null>;
  readTruth(client: Client, key: ListingKey): Promise<Truth>;
};

const defaultSource: Source = {
  async readPartition(client: Pick<PoolClient, 'query'>, partition: number) {
    await readLiveCopyDomain(client, partition, false);
    return readPartition(client, partition);
  },
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

/** The positive foreign factory uses this native source adapter, not a copied observation.
 * Collection truth and its original current writer basis share the admission transaction. */
export async function admitListingSource(deps: import('../access/live-copy.ts').LiveCopyDependencies, key: ListingKey) {
  const { observeLiveCopyDomain, stageLiveCopy, liveCopyEventRoles } = await import('../access/live-copy.ts');
  const { runOperationalTransaction } = await import('../command/operational.ts');
  const collectionRoute = routeOf(key.collectionId),
    targetRoute = routeOf(key.subjectId);
  if (collectionRoute === null || targetRoute === null) throw new TypeError('Invalid listing source locator');
  const receiver = await observeLiveCopyDomain(deps.pool, partitionOf(targetRoute));
  return runOperationalTransaction(
    deps.pool,
    {
      mode: 'work-step',
      partition: partitionOf(collectionRoute),
      kind: 'library.listing.admit',
      accounts: [],
      workClient: deps.client,
    },
    async (tx) => {
      const owner = await readPartition(tx, partitionOf(collectionRoute));
      if (!owner || owner.writeState !== 'active')
        throw new CommandUnavailableError('fenced', partitionOf(collectionRoute));
      const collection = (
        await tx.query<{ curator_account_id: string | null; transaction_id: string; revision: number }>(
          'SELECT curator_account_id,transaction_id,revision FROM library.collection WHERE route=$1 AND collection_id=$2 FOR SHARE',
          [collectionRoute, key.collectionId],
        )
      ).rows[0];
      const truth = await defaultSource.readTruth(tx, key);
      if (truth.multiplicity === 0) return null;
      if (!collection) throw new LiveCopyPendingError('Positive listing source Collection unavailable');
      const basis = (
        await tx.query<{
          epoch: number;
          position: string;
          principal_kind: string;
          principal_id: string;
          delegated: boolean;
        }>(
          `SELECT epoch,position::text,principal_kind,principal_id,requested_by IS NOT NULL AS delegated FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2`,
          [owner.partitionNo, collection.transaction_id],
        )
      ).rows[0];
      // A deidentified public Collection has no curator relationship. Existing public retention
      // is not converted to a new account claim, but still needs its genuine native commit basis.
      if (!basis || basis.epoch > owner.epoch)
        throw new LiveCopyPendingError('Listing original source transaction unavailable');
      const events = await tx.query<{ event_seq: number }>(
        'SELECT event_seq FROM core.outbox WHERE partition_no=$1 AND position=$2 ORDER BY event_seq LIMIT 101',
        [owner.partitionNo, basis.position],
      );
      if (events.rows.length > 100) throw new RangeError('Listing native source event fanout exceeds bound');
      let roles: import('../access/live-copy.ts').LiveCopyRole[] = [];
      if (collection.curator_account_id) roles.push({ accountId: collection.curator_account_id, roles: 8192 });
      if (basis.principal_kind === 'account') roles.push({ accountId: basis.principal_id, roles: 1 });
      // Delegation/human roles come from the original native event inventory.
      // requested_by is an attribution reference, not an Account id.
      for (const event of events.rows)
        roles = [
          ...(await liveCopyEventRoles(
            tx,
            {
              partition: owner.partitionNo,
              position: basis.position,
              eventSeq: event.event_seq,
              requireInventory: basis.delegated,
            },
            roles,
          )),
        ];
      return stageLiveCopy(tx, {
        route: collectionRoute,
        module: 'library.subject-listing',
        receiverRoute: targetRoute,
        receiver,
        effectKey: {
          collectionId: key.collectionId,
          subjectId: key.subjectId,
          epoch: basis.epoch,
          position: basis.position,
          transactionId: collection.transaction_id,
          revision: collection.revision,
        },
        payload: {
          subjectId: key.subjectId,
          collectionId: key.collectionId,
          collectionRoute,
          multiplicity: truth.multiplicity,
          currentlyPublic: truth.currentlyPublic,
          everPublic: truth.everPublic,
          stamp: { partition: owner.partitionNo, epoch: basis.epoch, position: basis.position },
        },
        roles,
      });
    },
  );
}

/** Fresh exact business generation, released before the receiver home is entered. */
export async function observeListingDeliverySource(pool: Pool, key: ListingKey) {
  const route = routeOf(key.collectionId);
  if (route === null) throw new TypeError('Invalid listing source Collection');
  return withReadTransaction(pool, async (tx) => {
    const owner = await readPartition(tx, partitionOf(route));
    if (!owner || owner.writeState !== 'active') throw new CommandUnavailableError('fenced', partitionOf(route));
    const collection = (
      await tx.query<{ transaction_id: string; revision: number }>(
        'SELECT transaction_id,revision FROM library.collection WHERE route=$1 AND collection_id=$2',
        [route, key.collectionId],
      )
    ).rows[0];
    const truth = await defaultSource.readTruth(tx, key);
    return { collection, truth, epoch: owner.epoch };
  });
}

/** Terminal exclusion for negative cleanup only. The native curator relation is
 * read in the Collection home, released, then its genuine immutable T is read. */
export async function terminalListingCurator(pool: Pool, key: ListingKey): Promise<boolean> {
  const collectionRoute = routeOf(key.collectionId);
  if (collectionRoute === null) throw new TypeError('Invalid terminal listing source');
  const accountId = await withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query<{ curator_account_id: string | null }>(
          'SELECT curator_account_id FROM library.collection WHERE route=$1 AND collection_id=$2',
          [collectionRoute, key.collectionId],
        )
      ).rows[0]?.curator_account_id,
  );
  if (!accountId) return false;
  const { observeLiveCopyDomain } = await import('../access/live-copy.ts');
  await observeLiveCopyDomain(pool, partitionOf(routeOf(accountId)!));
  return withReadTransaction(
    pool,
    async (tx) =>
      (
        await tx.query(
          "SELECT 1 FROM access.account WHERE route=$1 AND account_id=$2 AND state='deleted' AND authn_fenced",
          [routeOf(accountId), accountId],
        )
      ).rowCount === 1,
  );
}
