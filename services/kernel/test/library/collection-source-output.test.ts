import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  beginCollectionSourceOutput as begin,
  appendCollectionSourceOutput as append,
  completeCollectionSourceOutput as complete,
  cancelCollectionSourceOutput as cancel,
} from '../../src/library/collection-source-output.ts';
import { currentCommand, currentCommandResources } from '../../src/command/command.ts';
import {
  bindAndHoldNativePublicCollectionOutput,
  readNativePublicCollectionOutput,
  revalidateNativePublicCollectionOutputHold,
  transferNativePublicCollectionOutputHold,
} from '../../src/library/native-public-output-custody.ts';
import {
  readNativeCollectionMetadata,
  readNativeCollectionRawPage,
} from '../../src/library/collection-source-native.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { declareLibraryIdentityStatement } from '../../src/library/identity-original-work.ts';
import {
  nativePublicOutputFootprint,
  nativePublicOutputWorkDimensions,
  NATIVE_PUBLIC_OUTPUT_JOURNEYS,
  PUBLIC_OUTPUT_PARTITION_SIZE_SQL,
} from '../../src/library/native-public-output-work.ts';
import type { NativePublicOutputIdentity } from '../../src/library/native-source-output-types.ts';
import holdSQL from '../../src/library/native-public-output-hold.sql';
import pageSQL from '../../src/library/collection-source-output-page.sql';
import partitionSQL from '../../src/partition/read.sql';
import { partitionOf } from '../../src/route/route.ts';
import {
  sourceRuntimeFixture,
  sourceAllowance,
  type SourceRuntimeFixture,
} from './support/canonical-source-runtime-fixture.ts';
let f: SourceRuntimeFixture;
beforeAll(async () => {
  f = await sourceRuntimeFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});

test('explicit COMPLETE A retains membership while pending B never becomes output; exact Core replay keeps one append', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() },
    b = { ...source, generation: randomUUID() };
  const ids = [await f.createSubject('game'), await f.createSubject('recipe')].sort();
  await f.command(source.collectionId, { a, size: 2 }, (tx) => begin(tx, { ...a, expectedMembers: 2 }));
  expect((await f.inspect(source.collectionId)).selected).toBeNull();
  const key = randomUUID(),
    input = { ...a, after: null, subjectIds: ids };
  const first = await f.command(source.collectionId, input, (tx) => append(tx, input), key);
  const replay = await f.command(source.collectionId, input, (tx) => append(tx, input), key);
  expect(first.replayed).toBe(false);
  expect(replay.replayed).toBe(true);
  expect((await f.inspect(source.collectionId)).members.map((row) => row.subject_id)).toEqual(ids);
  await f.command(source.collectionId, { a, complete: true }, (tx) => complete(tx, a));
  await f.command(source.collectionId, { b, size: 1 }, (tx) => begin(tx, { ...b, expectedMembers: 1 }));
  await expect(f.command(source.collectionId, { b, complete: true }, (tx) => complete(tx, b))).rejects.toThrow();
  const retained = await f.inspect(source.collectionId);
  expect(retained.selected).toBe(a.generation);
  expect(retained.generations.find((row) => row.generation === b.generation)?.state).toBe('building');
  // Curated native authority remains occurrences. Publication storage is never silently substituted for them.
  const observed = await readNativeCollectionMetadata(f.pool, source, {
    deadline: Date.now() + 30000,
    allowance: sourceAllowance(),
  });
  expect(observed.metadata?.authority).toBe('curated');
});

test('failed native append rolls back checkpoint and keys, then cancellation retains exact custody and refuses a third copy', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() },
    b = { ...source, generation: randomUUID() };
  const id = await f.createSubject('game');
  await f.command(source.collectionId, { a }, (tx) => begin(tx, { ...a, expectedMembers: 1 }));
  const input = { ...a, after: null, subjectIds: [id] },
    key = randomUUID();
  await expect(
    f.command(
      source.collectionId,
      input,
      async (tx) => {
        await append(tx, input);
        throw new Error('crash before commit');
      },
      key,
    ),
  ).rejects.toThrow('crash before commit');
  expect((await f.inspect(source.collectionId)).members).toEqual([]);
  expect((await f.inspect(source.collectionId)).generations[0]?.written_members).toBe('0');
  await f.command(source.collectionId, input, (tx) => append(tx, input), key);
  await f.command(source.collectionId, { a, cancel: true }, (tx) => cancel(tx, a));
  await f.command(source.collectionId, { b }, (tx) => begin(tx, { ...b, expectedMembers: 0 }));
  await f.command(source.collectionId, { b, complete: true }, (tx) => complete(tx, b));
  const retained = await f.inspect(source.collectionId);
  expect(retained.selected).toBe(b.generation);
  expect(retained.members).toEqual([{ generation: a.generation, subject_id: id }]);
  await expect(
    f.command(source.collectionId, { third: true }, (tx) =>
      begin(tx, { ...source, generation: randomUUID(), expectedMembers: 0 }),
    ),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
});

test('private sources cannot publish and visibility reduction prevents a late append or COMPLETE', async () => {
  const source = await f.collection('private'),
    a = { ...source, generation: randomUUID() };
  await expect(
    f.command(source.collectionId, { a }, (tx) => begin(tx, { ...a, expectedMembers: 0 })),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect((await f.inspect(source.collectionId)).generations).toEqual([]);
  const publicSource = await f.collection(),
    b = { ...publicSource, generation: randomUUID() };
  await f.command(publicSource.collectionId, { b }, (tx) => begin(tx, { ...b, expectedMembers: 0 }));
  const response = await f.send(f.owner.bearer, 'PATCH', '/v1/collections/' + publicSource.collectionId, {
    revision: 1,
    visibility: 'private',
  });
  expect(response.status).toBe(200);
  await expect(f.command(publicSource.collectionId, { b, complete: true }, (tx) => complete(tx, b))).rejects.toThrow();
  expect((await f.inspect(publicSource.collectionId)).selected).toBeNull();
});

test('output helpers require the actual native transaction and bounded sorted chunks before any write', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() },
    id = await f.createSubject('game');
  await expect(begin(f.pool, { ...a, expectedMembers: 0 })).rejects.toThrow('No authorized live command transaction');
  await f.command(source.collectionId, { a }, (tx) => begin(tx, { ...a, expectedMembers: 2 }));
  await expect(
    f.command(source.collectionId, { duplicates: true }, (tx) =>
      append(tx, { ...a, after: null, subjectIds: [id, id] }),
    ),
  ).rejects.toThrow();
  await expect(
    f.command(source.collectionId, { oversize: true }, (tx) =>
      append(tx, { ...a, after: null, subjectIds: Array(101).fill(id) }),
    ),
  ).rejects.toThrow();
  expect((await f.inspect(source.collectionId)).members).toEqual([]);
  const observed = await readNativeCollectionMetadata(f.pool, source, {
    deadline: Date.now() + 30000,
    allowance: sourceAllowance(),
  });
  if (!observed.metadata) throw new Error('Native Collection metadata is required');
  await expect(
    readNativeCollectionRawPage(f.pool, observed.metadata, {
      driver: 'output',
      after: null,
      limit: 1,
      deadline: Date.now() + 30000,
      allowance: sourceAllowance(),
    }),
  ).rejects.toMatchObject({ code: 'dependency_unavailable' });
});

test('COMPLETE output has immutable same-command publication provenance and pending B cannot replace that receipt', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() },
    b = { ...source, generation: randomUUID() };
  const id = await f.createSubject('game');
  await f.command(source.collectionId, { begin: a }, (tx) => begin(tx, { ...a, expectedMembers: 1 }));
  await f.command(source.collectionId, { append: a }, (tx) => append(tx, { ...a, after: null, subjectIds: [id] }));
  const committed = await f.command(source.collectionId, { complete: a }, (tx) => complete(tx, a));
  const proof = async () =>
    (
      await f.pool.query(
        `SELECT r.transaction_id::text,b.position::text,r.native_xid::text,
      r.xmin=b.xmin AND r.xmin=g.xmin AND r.xmin=h.xmin AS same_transaction,
      r.source_generation=s.source_generation AND r.source_generation=h.source_generation AS same_source,
      g.member_count::text,g.member_fence=r.member_fence AS same_members,f.generation=r.collection_fence AS same_fence
     FROM library.collection_source_output_publication r
     JOIN editorial.write_basis b ON b.partition_no=r.partition_no AND b.transaction_id=r.transaction_id
     JOIN library.collection_source_output g USING(route,collection_id,generation)
     JOIN library.collection_source_output_head h USING(route,collection_id,generation)
     JOIN library.collection s ON s.route=r.route AND s.collection_id=r.collection_id
     JOIN library.native_source_fence f ON f.route=r.route AND f.kind='collection' AND f.owner_id=r.collection_id
     WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=$3`,
        [source.route, source.collectionId, a.generation],
      )
    ).rows;
  const before = await proof();
  expect(before).toEqual([
    expect.objectContaining({
      transaction_id: committed.transactionId,
      position: committed.position.toString(),
      same_transaction: true,
      same_source: true,
      member_count: '1',
      same_members: true,
      same_fence: true,
    }),
  ]);
  await f.command(source.collectionId, { begin: b }, (tx) => begin(tx, { ...b, expectedMembers: 0 }));
  expect(await proof()).toEqual(before);
  await expect(
    f.pool.query(
      'UPDATE library.collection_source_output_publication SET transaction_id=$4 WHERE route=$1 AND collection_id=$2 AND generation=$3',
      [source.route, source.collectionId, a.generation, randomUUID()],
    ),
  ).rejects.toThrow('native_source_receipt_immutable');
});

test('native member inventory prevents forged ready-empty and a missing Core commit cannot seal publication', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() };
  const id = await f.createSubject('game');
  await f.command(source.collectionId, { begin: a }, (tx) => begin(tx, { ...a, expectedMembers: 1 }));
  await f.command(source.collectionId, { append: a }, (tx) => append(tx, { ...a, after: null, subjectIds: [id] }));
  // Corrupt only the caller-maintained checkpoint. Actual native member bookkeeping remains independent.
  await f.pool.query(
    'UPDATE library.collection_source_output SET expected_members=0,written_members=0,after_subject_id=NULL WHERE route=$1 AND collection_id=$2 AND generation=$3',
    [source.route, source.collectionId, a.generation],
  );
  await expect(f.command(source.collectionId, { complete: a }, (tx) => complete(tx, a))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await f.inspect(source.collectionId)).selected).toBeNull();
  // A fabricated receipt cannot use a real but unrelated old Core command or an invented transaction UUID.
  await expect(
    f.pool.query(
      `INSERT INTO library.collection_source_output_publication
      (route,collection_id,generation,account_id,incarnation,source_generation,expected_members,member_fence,collection_fence,transaction_id)
     SELECT g.route,g.collection_id,g.generation,g.account_id,
       s.collection_id::text || ':' || extract(epoch FROM s.created_at)::text,s.source_generation+1,0,g.member_fence,0,$4
     FROM library.collection_source_output g JOIN library.collection s USING(route,collection_id)
     WHERE g.route=$1 AND g.collection_id=$2 AND g.generation=$3`,
      [source.route, source.collectionId, a.generation, randomUUID()],
    ),
  ).rejects.toThrow();
  expect(
    (
      await f.pool.query(
        'SELECT 1 FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2',
        [source.route, source.collectionId],
      )
    ).rows,
  ).toEqual([]);
});

test('a build cannot append or complete after its captured native owner binding changes', async () => {
  const source = await f.collection(),
    a = { ...source, generation: randomUUID() };
  const id = await f.createSubject('game');
  await f.command(source.collectionId, { begin: a }, (tx) => begin(tx, { ...a, expectedMembers: 1 }));
  await f.pool.query(
    'UPDATE library.collection_source_output SET account_id=NULL WHERE route=$1 AND collection_id=$2 AND generation=$3',
    [source.route, source.collectionId, a.generation],
  );
  await expect(
    f.command(source.collectionId, { append: a }, (tx) => append(tx, { ...a, after: null, subjectIds: [id] })),
  ).rejects.toMatchObject({ code: 'conflict' });
  await expect(f.command(source.collectionId, { complete: a }, (tx) => complete(tx, a))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await f.inspect(source.collectionId)).selected).toBeNull();
  expect((await f.inspect(source.collectionId)).members).toEqual([]);
});

test('the public output descriptor refuses unknown shapes and charges plan-node bounds, not observed rows', () => {
  const work = new NativeCollectionWork(sourceAllowance(), Date.now() + 30000);
  const id = randomUUID();
  expect(nativePublicOutputFootprint('SELECT 1', [], work)).toBeUndefined();
  expect(nativePublicOutputFootprint(pageSQL.sql, [0, id, id, id, 0], work)).toBeUndefined();
  expect(nativePublicOutputFootprint(pageSQL.sql, [0, id, id, id, 101], work)).toBeUndefined();
  expect(nativePublicOutputFootprint(holdSQL.sql, [1, id, id, id, 'fabricated'], work)).toBeUndefined();
  expect(nativePublicOutputFootprint(partitionSQL.sql, [1], work)).toBeUndefined();
  work.admitResultBytes('partition:1', 64);
  const admitted = nativePublicOutputFootprint(partitionSQL.sql, [1], work);
  expect(admitted?.nativeRows).toBe(4);
  expect(admitted?.bytes).toBeGreaterThanOrEqual(64);
  const page = nativePublicOutputFootprint(pageSQL.sql, [0, id, id, id, 2], work)!;
  expect(page.candidateKeys).toBe(2);
  expect(page.nativeRows).toBe(12);
  expect(page.nativeRows).toBeGreaterThan(2);
  const eight = nativePublicOutputWorkDimensions(NATIVE_PUBLIC_OUTPUT_JOURNEYS().read);
  expect('engineRequests' in eight).toBe(false);
  expect(() =>
    nativePublicOutputWorkDimensions({ ...NATIVE_PUBLIC_OUTPUT_JOURNEYS().read, engineRequests: 1 }),
  ).toThrow(/engine requests/);
  const declared = declareLibraryIdentityStatement('native-public-output', PUBLIC_OUTPUT_PARTITION_SIZE_SQL, [1], work);
  expect(declared?.engineRequests).toBe(0);
  expect(declared?.work).toEqual(nativePublicOutputFootprint(PUBLIC_OUTPUT_PARTITION_SIZE_SQL, [1], work));
});

test('a well-formed public output identity without a retained original hold is unavailable, not empty', async () => {
  const source = await f.collection();
  const identity: NativePublicOutputIdentity = {
    scope: 'public_output',
    route: source.route,
    collectionId: source.collectionId,
    incarnation: `${source.collectionId}:1`,
    generation: '1',
    ownerEpoch: 0,
    receivingEpoch: '1',
    effectKey: 'a'.repeat(64),
    outputGeneration: randomUUID(),
    activation: { transactionId: randomUUID(), position: '1', sourceGeneration: '1' },
  };
  const page = await readNativePublicCollectionOutput(f.pool, identity, {
    deadline: Date.now() + 30000,
    allowance: sourceAllowance(),
    after: null,
    limit: 1,
  });
  expect(page.status).toBe('unavailable');
  expect('rows' in page).toBe(false);
  expect(page.work.used.nativeRows).toBeGreaterThan(0);
});

test('changed publication and fabricated successor transfer refuse without creating or consuming a hold', async () => {
  const source = await f.collection();
  const a = { ...source, generation: randomUUID() };
  const id = await f.createSubject('game');
  await f.command(source.collectionId, { begin: a }, (tx) => begin(tx, { ...a, expectedMembers: 1 }));
  await f.command(source.collectionId, { append: a }, (tx) => append(tx, { ...a, after: null, subjectIds: [id] }));
  const committed = await f.command(source.collectionId, { complete: a }, (tx) => complete(tx, a));
  const holds = async () =>
    (
      await f.pool.query(
        'SELECT hold_id::text FROM library.native_public_output_hold WHERE route=$1 AND collection_id=$2',
        [source.route, source.collectionId],
      )
    ).rows;
  expect(await holds()).toEqual([]);
  await f.command(source.collectionId, { bind: true }, async (tx) => {
    const current = currentCommand(tx);
    const resources = currentCommandResources(tx);
    const context = {
      pool: resources.pool,
      at: current.time,
      deadline: resources.deadline,
      allowance: sourceAllowance(),
    };
    const bound = await bindAndHoldNativePublicCollectionOutput(
      tx,
      {
        captureId: randomUUID(),
        definitionDigest: 'b'.repeat(64),
        publication: {
          route: source.route,
          collectionId: source.collectionId,
          generation: a.generation,
          activation: {
            transactionId: committed.transactionId,
            position: committed.position.toString(),
            sourceGeneration: '1',
          },
        },
      },
      context,
    );
    expect(bound.status === 'changed' || bound.status === 'unavailable').toBe(true);
    expect('binding' in bound).toBe(false);
    const transferred = await transferNativePublicCollectionOutputHold(
      tx,
      {
        captureId: randomUUID(),
        holdId: randomUUID(),
        bindingDigest: 'c'.repeat(64),
        disposition: {
          partition: partitionOf(source.route),
          epoch: 0,
          position: 1n,
          transactionId: randomUUID(),
        },
      },
      context,
    );
    expect(transferred.status).toBe('unavailable');
    await expect(
      revalidateNativePublicCollectionOutputHold(
        tx,
        {
          captureId: randomUUID(),
          holdId: randomUUID(),
          definitionDigest: 'b'.repeat(64),
          bindingDigest: 'c'.repeat(64),
          tuple: {
            identity: {
              scope: 'public_output',
              route: source.route,
              collectionId: source.collectionId,
              incarnation: `${source.collectionId}:1`,
              generation: '1',
              ownerEpoch: 0,
              receivingEpoch: '1',
              effectKey: 'a'.repeat(64),
              outputGeneration: a.generation,
              activation: {
                transactionId: committed.transactionId,
                position: committed.position.toString(),
                sourceGeneration: '1',
              },
            },
            publication: {
              generation: a.generation,
              transactionId: committed.transactionId,
              position: committed.position.toString(),
              nativeXid: '0',
              members: '1',
              memberFence: '0',
              sourceGeneration: '1',
            },
            observation: { partition: partitionOf(source.route), epoch: 0, position: 1n },
          },
          accepted: {
            partition: partitionOf(source.route),
            epoch: 0,
            position: 1n,
            transactionId: committed.transactionId,
          },
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  });
  expect(await holds()).toEqual([]);
});
