import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  appendCollectionSourceOutput,
  beginCollectionSourceOutput,
  beginWholeQueryCollectionSourceOutput,
  completeCollectionSourceOutput,
} from '../../src/library/collection-source-output.ts';
import { readCollectionPublicationStagingSeal } from '../../src/library/collection-publication-staging.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import {
  sourceAllowance,
  sourceRuntimeFixture,
  type SourceRuntimeFixture,
} from './support/canonical-source-runtime-fixture.ts';

let f: SourceRuntimeFixture;
beforeAll(async () => {
  f = await sourceRuntimeFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('unknown-size B survives interrupted allocation and exact replay without selecting it or erasing complete A', async () => {
  const collection = await f.collection();
  const a = { ...collection, generation: randomUUID() };
  const b = { ...collection, generation: randomUUID() };
  const subject = await f.createSubject('game');
  await f.command(collection.collectionId, { a, subject }, async (tx) => {
    await beginCollectionSourceOutput(tx, { ...a, expectedMembers: 1 });
    await appendCollectionSourceOutput(tx, { ...a, after: null, subjectIds: [subject] });
    await completeCollectionSourceOutput(tx, a);
  });
  const key = randomUUID();
  await expect(
    f.command(
      collection.collectionId,
      { b },
      async (tx) => {
        await beginWholeQueryCollectionSourceOutput(tx, b);
        throw new Error('interrupted before commit');
      },
      key,
    ),
  ).rejects.toThrow('interrupted before commit');
  expect((await f.inspect(collection.collectionId)).generations).toHaveLength(1);
  const first = await f.command(
    collection.collectionId,
    { b },
    (tx) => beginWholeQueryCollectionSourceOutput(tx, b),
    key,
  );
  const replay = await f.command(
    collection.collectionId,
    { b },
    (tx) => beginWholeQueryCollectionSourceOutput(tx, b),
    key,
  );
  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  const current = await f.inspect(collection.collectionId);
  expect(current.selected).toBe(a.generation);
  expect(current.generations).toHaveLength(2);
  expect(current.generations.find((row) => row.generation === b.generation)).toMatchObject({
    state: 'building',
    expected_members: null,
    written_members: '0',
    after_subject_id: null,
  });
  expect(current.members).toEqual([{ generation: a.generation, subject_id: subject }]);
}, 120000);

test('selected-list hooks and a zero counter cannot append or complete unknown-size B; true-empty A survives', async () => {
  const collection = await f.collection();
  const a = { ...collection, generation: randomUUID() };
  const b = { ...collection, generation: randomUUID() };
  await f.command(collection.collectionId, { a }, async (tx) => {
    await beginCollectionSourceOutput(tx, { ...a, expectedMembers: 0 });
    await completeCollectionSourceOutput(tx, a);
  });
  await f.command(collection.collectionId, { b }, (tx) => beginWholeQueryCollectionSourceOutput(tx, b));
  const subject = await f.createSubject('recipe');
  await expect(
    f.command(collection.collectionId, { b, subject }, (tx) =>
      appendCollectionSourceOutput(tx, {
        ...b,
        after: null,
        subjectIds: [subject],
      }),
    ),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(
    f.command(collection.collectionId, { b, complete: true }, (tx) => completeCollectionSourceOutput(tx, b)),
  ).rejects.toMatchObject({ code: 'conflict' });
  await f.command(collection.collectionId, { b, missingSeal: true }, async (tx) => {
    expect(
      await readCollectionPublicationStagingSeal(
        tx,
        {
          ...collection,
          ownerAccountId: f.owner.actor.accountId,
          publicationId: randomUUID(),
        },
        new NativeCollectionWork(sourceAllowance(), Date.now() + 30000),
      ),
    ).toBeNull();
  });
  const current = await f.inspect(collection.collectionId);
  expect(current.selected).toBe(a.generation);
  expect(current.members).toEqual([]);
  expect(current.generations.find((row) => row.generation === b.generation)?.expected_members).toBeNull();
  await expect(
    f.command(collection.collectionId, { third: true }, (tx) =>
      beginWholeQueryCollectionSourceOutput(tx, {
        ...collection,
        generation: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
}, 120000);

test('a changed output fence refuses late unknown-size allocation and preserves its retained generation', async () => {
  const collection = await f.collection();
  const b = { ...collection, generation: randomUUID() };
  await f.command(collection.collectionId, { b }, (tx) => beginWholeQueryCollectionSourceOutput(tx, b));
  const response = await f.send(f.owner.bearer, 'PATCH', `/v1/collections/${collection.collectionId}`, {
    revision: 1,
    visibility: 'private',
  });
  expect(response.status).toBe(200);
  await expect(
    f.command(collection.collectionId, { b, late: true }, (tx) => beginWholeQueryCollectionSourceOutput(tx, b)),
  ).rejects.toMatchObject({ code: 'conflict' });
  const current = await f.inspect(collection.collectionId);
  expect(current.selected).toBeNull();
  expect(current.generations).toHaveLength(1);
  expect(current.generations[0]).toMatchObject({ generation: b.generation, state: 'building', expected_members: null });
}, 120000);
