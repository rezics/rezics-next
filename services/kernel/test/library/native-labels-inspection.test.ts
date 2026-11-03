import { expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';
import { inspectNativeLabelCollections } from './support/native-labels-inspection.ts';
import { json, write, type NativeConformanceWorld } from './support/native-conformance.ts';

async function createPublicCollection(world: NativeConformanceWorld, persona: 'owner' | 'other') {
  const { collection } = await json<{ collection: { id: string } }>(
    await write(world, persona, 'POST', '/v1/collections', { title: `Inspection ${persona}`, visibility: 'private' }),
    201,
  );
  const path = `/v1/collections/${collection.id}`;
  const { collection: current } = await json<{ collection: { revision: number } }>(
    await world.native.request(persona, { method: 'GET', path }),
  );
  await json(await write(world, persona, 'PATCH', path, { revision: current.revision, visibility: 'public' }));
  return collection.id;
}

test('native Collection inspection distinguishes empty and populated owner observations', async () => {
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
    expect(foreign.collectionGrants.some((row) => row.collectionId === otherId)).toBe(true);
    expect(foreign.collectionOutbox.some((row) => row.subject === otherId)).toBe(true);
    expect(foreign.collectionWork.some((row) => row.collectionId === otherId)).toBe(true);
    expect(owned.collections.map((row) => row.collectionId)).toEqual([ownerId]);
    expect(owned.collectionGrants.some((row) => row.collectionId === ownerId && row.accountId === owner.id)).toBe(true);
    expect(owned.collectionGrants.map((row) => row.collectionId)).toEqual([ownerId]);
    expect(owned.collectionOutbox.map((row) => row.subject)).toContain(ownerId);
    expect(owned.collectionOutbox.map((row) => row.subject)).not.toContain(otherId);
    expect(owned.collectionWork).toContainEqual({
      collectionId: ownerId,
      kind: 'library.collectionListing',
      state: 'SUCCESS',
    });
    expect(owned.collectionWork.map((row) => row.collectionId)).not.toContain(otherId);

    const actualWork = (
      await world.native.reader.query<{ collectionId: string; kind: string; state: string }>(
        `SELECT event.data->>'collectionId' AS "collectionId", workflow.name AS kind, workflow.status AS state
             FROM core.outbox AS event
             JOIN dbos.workflow_status AS workflow ON workflow.workflow_uuid=event.id::text
            WHERE event.partition_no=$1 AND event.subject=$2
              AND event.type='com.rezics.library.collection.listing.changed.v1'
            ORDER BY event.position, event.event_seq LIMIT 1`,
        [owner.partition, ownerId],
      )
    ).rows[0];
    expect(actualWork).toBeDefined();
    expect(owned.collectionWork).toContainEqual(actualWork);
  } finally {
    await world.close();
  }
}, 120_000);
