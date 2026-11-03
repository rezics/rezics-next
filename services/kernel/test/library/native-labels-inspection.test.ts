import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';
import { inspectNativeLabelCollections } from './support/native-labels-inspection.ts';
import { json, requestKey, write, type NativeConformanceWorld } from './support/native-conformance.ts';

async function createPublicCollection(world: NativeConformanceWorld, persona: 'owner' | 'other') {
  const created = await json<{ collection: { id: string } }>(
    await write(world, persona, 'POST', '/v1/collections', { title: `Inspection ${persona}`, visibility: 'private' }),
    201,
  );
  const path = `/v1/collections/${created.collection.id}`;
  const current = await json<{ collection: { revision: number } }>(await world.native.request(persona, { method: 'GET', path }));
  await json(
    await write(
      world,
      persona,
      'PATCH',
      path,
      { revision: current.collection.revision, visibility: 'public' },
      requestKey(),
    ),
  );
  return created.collection.id;
}

test(
  'native Collection inspection distinguishes empty and populated owner observations',
  async () => {
    const world = await createLibraryDriver();
    try {
      const { owner, other } = world.accounts;
      const empty = await inspectNativeLabelCollections(world, owner, [newId(owner.route)]);
      const ownerId = await createPublicCollection(world, 'owner');
      const otherId = await createPublicCollection(world, 'other');
      await world.settle();

      const foreign = await inspectNativeLabelCollections(world, other, [otherId]);
      const owned = await inspectNativeLabelCollections(world, owner, [ownerId, otherId]);
      expect(empty).toEqual({ collections: [], collectionGrants: [], collectionOutbox: [], collectionWork: [] });
      expect(foreign.collections.map((row) => row.collectionId)).toEqual([otherId]);
      expect(foreign.collectionGrants.length).toBeGreaterThan(0);
      expect(foreign.collectionOutbox.some((row) => row.subject === otherId)).toBe(true);
      expect(foreign.collectionWork.some((row) => row.collectionId === otherId)).toBe(true);
      expect(owned.collections.map((row) => row.collectionId)).toEqual([ownerId]);
      expect(owned.collectionGrants.some((row) => row.collectionId === ownerId && row.accountId === owner.id)).toBe(true);
      expect(owned.collectionGrants.every((row) => row.collectionId === ownerId)).toBe(true);
      expect(owned.collectionOutbox.some((row) => row.subject === ownerId)).toBe(true);
      expect(owned.collectionOutbox.some((row) => row.subject === otherId)).toBe(false);
      expect(owned.collectionWork).toContainEqual({
        collectionId: ownerId,
        kind: 'library.collectionListing',
        state: 'SUCCESS',
      });
      expect(owned.collectionWork.every((row) => row.collectionId === ownerId)).toBe(true);

      const eventId = (
        await world.native.reader.query<{ id: string }>(
          `SELECT id::text AS id FROM core.outbox
            WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.library.collection.listing.changed.v1'
            ORDER BY position, event_seq LIMIT 1`,
          [owner.partition, ownerId],
        )
      ).rows[0]?.id;
      if (!eventId) throw new Error('Native Collection listing outbox event is absent');
      const workflow = (
        await world.native.reader.query<{ kind: string; state: string }>(
          'SELECT name AS kind, status AS state FROM dbos.workflow_status WHERE workflow_uuid=$1',
          [eventId],
        )
      ).rows[0];
      if (!workflow) throw new Error('Native Collection listing workflow is absent');
      expect(owned.collectionWork).toContainEqual({ collectionId: ownerId, ...workflow });
    } finally {
      await world.close();
    }
  },
  120_000,
);
