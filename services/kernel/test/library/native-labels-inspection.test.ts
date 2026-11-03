import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';
import { inspectNativeLabelCollections } from './support/native-labels-inspection.ts';
import { json, requestKey, write, type NativeConformanceWorld } from './support/native-conformance.ts';

type CollectionOwner = 'owner' | 'other';

async function createCollection(world: NativeConformanceWorld, owner: CollectionOwner): Promise<string> {
  const response = await write(world, owner, 'POST', '/v1/collections', {
    title: `Inspection ${owner}`,
    visibility: 'private',
  });
  const result = await json<{ collection: { id: string } }>(response, 201);
  return result.collection.id;
}

async function publishCollection(world: NativeConformanceWorld, owner: CollectionOwner, collectionId: string) {
  const detail = await json<{ collection: { revision: number } }>(
    await world.native.request(owner, { method: 'GET', path: `/v1/collections/${collectionId}` }),
  );
  await json(
    await write(
      world,
      owner,
      'PATCH',
      `/v1/collections/${collectionId}`,
      { revision: detail.collection.revision, visibility: 'public' },
      requestKey(),
    ),
  );
}

test(
  'native Collection inspection distinguishes empty and populated owner observations',
  async () => {
    const world = await createLibraryDriver();
    try {
      const owner = world.accounts.owner;
      const other = world.accounts.other;
      const empty = await inspectNativeLabelCollections(world, owner, [newId(owner.route)]);
      expect(empty).toEqual({ collections: [], collectionGrants: [], collectionOutbox: [], collectionWork: [] });

      const ownerCollectionId = await createCollection(world, 'owner');
      const otherCollectionId = await createCollection(world, 'other');
      await publishCollection(world, 'owner', ownerCollectionId);
      await publishCollection(world, 'other', otherCollectionId);
      await world.settle();

      const otherObservations = await inspectNativeLabelCollections(world, other, [otherCollectionId]);
      expect(otherObservations.collections.map((row) => row.collectionId)).toEqual([otherCollectionId]);
      expect(otherObservations.collectionGrants.length).toBeGreaterThan(0);
      expect(otherObservations.collectionOutbox.some((row) => row.subject === otherCollectionId)).toBe(true);
      expect(otherObservations.collectionWork).toContainEqual({
        collectionId: otherCollectionId,
        kind: 'library.collectionListing',
        state: 'SUCCESS',
      });

      const ownerObservations = await inspectNativeLabelCollections(world, owner, [ownerCollectionId, otherCollectionId]);
      expect(ownerObservations.collections.map((row) => row.collectionId)).toEqual([ownerCollectionId]);
      expect(ownerObservations.collectionGrants.length).toBeGreaterThan(0);
      expect(ownerObservations.collectionGrants.every((row) => row.collectionId === ownerCollectionId)).toBe(true);
      expect(ownerObservations.collectionOutbox.some((row) => row.subject === ownerCollectionId)).toBe(true);
      expect(ownerObservations.collectionOutbox.every((row) => row.subject === ownerCollectionId)).toBe(true);
      expect(ownerObservations.collectionWork).toContainEqual({
        collectionId: ownerCollectionId,
        kind: 'library.collectionListing',
        state: 'SUCCESS',
      });
      expect(ownerObservations.collectionWork.every((row) => row.collectionId === ownerCollectionId)).toBe(true);

      const listingEvent = (
        await world.native.reader.query<{ id: string }>(
          `SELECT id::text AS id FROM core.outbox
            WHERE partition_no=$1 AND subject=$2
              AND type='com.rezics.library.collection.listing.changed.v1'
            ORDER BY position, event_seq LIMIT 1`,
          [owner.partition, ownerCollectionId],
        )
      ).rows[0];
      if (!listingEvent) throw new Error('Native Collection listing outbox event is absent');
      const workflow = (
        await world.native.reader.query<{ kind: string; state: string }>(
          'SELECT name AS kind, status AS state FROM dbos.workflow_status WHERE workflow_uuid=$1',
          [listingEvent.id],
        )
      ).rows[0];
      if (!workflow) throw new Error('Native Collection listing workflow is absent');
      expect(ownerObservations.collectionWork).toContainEqual({
        collectionId: ownerCollectionId,
        kind: workflow.kind,
        state: workflow.state,
      });
    } finally {
      await world.close();
    }
  },
  120_000,
);
