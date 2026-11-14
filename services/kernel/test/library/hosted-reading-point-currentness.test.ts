import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { Pool, PoolClient } from 'pg';
import { hostedChaptersFixture } from '../content/support/hosted-chapters-fixture.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { peekHostedReadingPort } from '../../src/library/hosted-reading-bind.ts';
import type { HostedReadingAddress, HostedReadingPort } from '../../src/library/contract/hosted-reading.ts';

setDefaultTimeout(180_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

type ControlledCall = {
  operation: 'metadata' | 'exact';
  address: HostedReadingAddress;
  finish(beforeResolve?: () => Promise<void>): Promise<void>;
};

function controlHostedReadingPort() {
  const port = peekHostedReadingPort();
  if (!port) throw new Error('Hosted reading Content port is not composed');
  const mutablePort = port as unknown as {
    readMetadata: HostedReadingPort['readMetadata'];
    resolveExact: HostedReadingPort['resolveExact'];
  };
  const originalMetadata = port.readMetadata;
  const originalExact = port.resolveExact;
  const calls: ControlledCall[] = [];
  const waiters: Array<{ count: number; resolve(): void }> = [];
  const notify = () => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (calls.length < waiters[index]!.count) continue;
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve();
    }
  };
  mutablePort.readMetadata = (...args) =>
    new Promise<Awaited<ReturnType<HostedReadingPort['readMetadata']>>>((resolve, reject) => {
      let settled = false;
      calls.push({
        operation: 'metadata',
        address: args[1],
        async finish(beforeResolve?: () => Promise<void>) {
          if (settled) return;
          settled = true;
          try {
            const value = await originalMetadata(...args);
            await beforeResolve?.();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
      });
      notify();
    });
  mutablePort.resolveExact = (...args) =>
    new Promise<Awaited<ReturnType<HostedReadingPort['resolveExact']>>>((resolve, reject) => {
      let settled = false;
      calls.push({
        operation: 'exact',
        address: args[1],
        async finish(beforeResolve?: () => Promise<void>) {
          if (settled) return;
          settled = true;
          try {
            const value = await originalExact(...args);
            await beforeResolve?.();
            resolve(value);
          } catch (error) {
            reject(error);
          }
        },
      });
      notify();
    });
  return {
    calls,
    waitForCalls(count: number) {
      if (calls.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    restore() {
      mutablePort.readMetadata = originalMetadata;
      mutablePort.resolveExact = originalExact;
    },
  };
}

function watchChapterBodyReads(pool: Pool) {
  let reads = 0;
  const mutablePool = pool as unknown as { connect: () => Promise<PoolClient> };
  const originalConnect = mutablePool.connect;
  mutablePool.connect = async () => {
    const client = await originalConnect.call(pool);
    const mutableClient = client as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = mutableClient.query;
    mutableClient.query = (...args) => {
      const statement = args[0];
      const sql = typeof statement === 'string' ? statement : ((statement as { text?: string } | null)?.text ?? '');
      const values = Array.isArray(args[1]) ? args[1] : [];
      if (sql.includes('FROM input i JOIN content.revision r') && values[4] === true) reads += 1;
      return Reflect.apply(originalQuery, client, args) as Promise<unknown>;
    };
    return client;
  };
  return {
    reset() {
      reads = 0;
    },
    count() {
      return reads;
    },
    restore() {
      mutablePool.connect = originalConnect;
    },
  };
}

function changePartitionAfterCheckpointSelection(pool: Pool, subjectId: string, change: () => Promise<void>) {
  const mutablePool = pool as unknown as { connect: () => Promise<PoolClient> };
  const originalConnect = mutablePool.connect;
  let selected = false;
  let changed = false;
  mutablePool.connect = async () => {
    const client = await originalConnect.call(pool);
    const mutableClient = client as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const originalQuery = mutableClient.query;
    mutableClient.query = async (...args) => {
      const statement = args[0];
      const sql = typeof statement === 'string' ? statement : ((statement as { text?: string } | null)?.text ?? '');
      const values = Array.isArray(args[1]) ? args[1] : [];
      const result = await Reflect.apply(originalQuery, client, args);
      if (sql.includes('FROM library.hosted_reading') && values[2] === subjectId) selected = true;
      if (sql.trim().toUpperCase() === 'COMMIT' && selected && !changed) {
        changed = true;
        await change();
      }
      return result;
    };
    return client;
  };
  return {
    changed: () => changed,
    restore() {
      mutablePool.connect = originalConnect;
    },
  };
}

test('point resume and metadata bind saved and empty results to the current owner home', async () => {
  const ownerId = f.native.system.actors.other.actor.accountId;
  const ownerRoute = routeOf(ownerId)!;
  let subjectKey = crypto.randomUUID();
  while (
    anchorRoute(f.native.system.routeKey, `${f.native.author.actor.accountId}\nsubject.create\n${subjectKey}`) !==
    ownerRoute
  )
    subjectKey = crypto.randomUUID();
  const createdSubject = await f.native.call(
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: `Hosted point ${crypto.randomUUID()}` } },
    { key: subjectKey },
  );
  expect(createdSubject.status).toBe(201);
  const subjectId = createdSubject.value.id as string;

  const chapter = await f.native.thread('published', fromPlainText('Exact saved point chapter'));
  const target = f.target(chapter);
  const occurrenceId = f.newOccurrenceId();
  const structure = await f.native.call(
    'POST',
    '/v1/hostedCatalogues',
    {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements: [{ occurrenceId, parentId: null, position: 0, title: 'Saved chapter', kind: 'chapter', target }],
    },
    { key: crypto.randomUUID() },
  );
  expect(structure.status).toBe(201);
  const publication = await f.native.call(
    'POST',
    `/v1/hostedCatalogues/${f.catalogueId}:publish`,
    { expectedRevisionId: structure.value.revisionId, expectedPublicationId: null, occurrenceIds: [occurrenceId] },
    { key: crypto.randomUUID() },
  );
  expect(publication.status).toBe(200);
  const catalogueState = await f.native.state(f.catalogueId);
  const association = await f.native.revise(
    {
      id: f.catalogueId,
      revisionId: String(catalogueState.head_revision_id),
      visibility: 'published',
    },
    { subjectIds: [subjectId] },
  );
  expect(association.status).toBe(200);
  const saved = await f.native.call(
    'PUT',
    '/v1/libraryHostedReading',
    {
      subjectId,
      catalogueId: f.catalogueId,
      publicationRevisionId: publication.value.revisionId,
      occurrenceId,
      targetRevisionId: target.revisionId,
      targetSha256: target.sha256,
      documentPosition: { blockId: 'keep-this-position', offset: 27 },
      expectedRevision: null,
    },
    { other: true, key: crypto.randomUUID() },
  );
  expect(saved.status).toBe(200);

  const partitionNo = partitionOf(ownerRoute);
  const accountBefore = await f.native.pool.query<{ state: string; minimum_authn_epoch: string }>(
    'SELECT state,minimum_authn_epoch::text FROM access.account WHERE route=$1 AND account_id=$2',
    [ownerRoute, ownerId],
  );
  const partitionBefore = await f.native.pool.query<{ write_state: string; moved_to: string | null }>(
    'SELECT write_state,moved_to FROM core.partition WHERE partition_no=$1',
    [partitionNo],
  );
  const account = accountBefore.rows[0]!;
  const partition = partitionBefore.rows[0]!;
  const controlled = controlHostedReadingPort();
  const bodyReads = watchChapterBodyReads(f.native.pool);
  const getPath = `/v1/libraryHostedReading?subjectId=${subjectId}`;
  const metadataPath = `/v1/libraryHostedReading/metadata?subjectId=${subjectId}`;
  const ownerRead = (path: string) => f.native.call('GET', path, undefined, { other: true });
  const updatePartition = async (state: string, movedTo: string | null) =>
    f.native.pool.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
      partitionNo,
      state,
      movedTo,
    ]);
  const restorePartition = async () => updatePartition(partition.write_state, partition.moved_to);
  const restoreAccount = async () =>
    f.native.pool.query('UPDATE access.account SET state=$3,minimum_authn_epoch=$4 WHERE route=$1 AND account_id=$2', [
      ownerRoute,
      ownerId,
      account.state,
      account.minimum_authn_epoch,
    ]);
  try {
    const resumePending = ownerRead(getPath);
    await controlled.waitForCalls(1);
    expect(controlled.calls[0]!.operation).toBe('exact');
    expect(controlled.calls[0]!.address).toEqual(saved.value.address);
    await controlled.calls[0]!.finish();
    const resumed = await resumePending;
    expect(resumed.status).toBe(200);
    expect(resumed.value).toMatchObject({ state: 'saved', subjectId, address: saved.value.address });

    bodyReads.reset();
    const metadataPending = ownerRead(metadataPath);
    await controlled.waitForCalls(2);
    expect(controlled.calls[1]!.operation).toBe('metadata');
    expect(controlled.calls[1]!.address).toEqual(saved.value.address);
    await controlled.calls[1]!.finish();
    const metadata = await metadataPending;
    expect(metadata.status).toBe(200);
    expect(metadata.value).toMatchObject({ state: 'saved', subjectId, address: saved.value.address });
    expect(bodyReads.count()).toBe(0);

    const absentSubject = newId(ownerRoute);
    expect((await ownerRead(`/v1/libraryHostedReading?subjectId=${absentSubject}`)).value).toEqual({
      state: 'none',
      subjectId: absentSubject,
    });
    expect((await ownerRead(`/v1/libraryHostedReading/metadata?subjectId=${absentSubject}`)).value).toEqual({
      state: 'none',
      subjectId: absentSubject,
    });
    expect(controlled.calls).toHaveLength(2);

    for (const path of [
      `/v1/libraryHostedReading?subjectId=${absentSubject}`,
      `/v1/libraryHostedReading/metadata?subjectId=${absentSubject}`,
    ]) {
      const finalHomeChange = changePartitionAfterCheckpointSelection(f.native.pool, absentSubject, async () => {
        await updatePartition('moved', 'hosted-reading-point-test');
      });
      try {
        expect((await ownerRead(path)).status).toBe(503);
        expect(finalHomeChange.changed()).toBe(true);
      } finally {
        finalHomeChange.restore();
        await restorePartition();
      }
    }

    for (const [state, movedTo, path] of [
      ['moved', 'hosted-reading-point-test', `/v1/libraryHostedReading?subjectId=${absentSubject}`],
      ['fenced', null, `/v1/libraryHostedReading/metadata?subjectId=${absentSubject}`],
    ] as const) {
      await updatePartition(state, movedTo);
      const unavailable = await ownerRead(path);
      expect(unavailable.status).toBe(503);
      await restorePartition();
    }
    expect(controlled.calls).toHaveLength(2);

    const protectedTarget = await f.native.revise(chapter.firstPost, { visibility: 'protected' });
    expect(protectedTarget.status).toBe(200);
    const hiddenResumePending = ownerRead(getPath);
    await controlled.waitForCalls(3);
    bodyReads.reset();
    await controlled.calls[2]!.finish();
    const hiddenResume = await hiddenResumePending;
    expect(hiddenResume.value).toMatchObject({
      state: 'saved',
      address: saved.value.address,
      resume: { availability: 'unavailable', occurrenceId, kind: 'chapter' },
    });

    const hiddenMetadataPending = ownerRead(metadataPath);
    await controlled.waitForCalls(4);
    bodyReads.reset();
    await controlled.calls[3]!.finish();
    const hiddenMetadata = await hiddenMetadataPending;
    expect(hiddenMetadata.value).toMatchObject({
      state: 'saved',
      address: saved.value.address,
      metadata: { availability: 'unavailable', occurrenceId, kind: 'chapter' },
    });
    expect(bodyReads.count()).toBe(0);

    const floorPending = ownerRead(getPath);
    await controlled.waitForCalls(5);
    await controlled.calls[4]!.finish(async () => {
      await f.native.pool.query('UPDATE access.account SET minimum_authn_epoch=$3 WHERE route=$1 AND account_id=$2', [
        ownerRoute,
        ownerId,
        BigInt(f.native.system.actors.other.actor.authnEpoch) + 1n,
      ]);
    });
    expect((await floorPending).status).toBe(403);
    await restoreAccount();

    const revokedPending = ownerRead(metadataPath);
    await controlled.waitForCalls(6);
    await controlled.calls[5]!.finish(async () => {
      await f.native.pool.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
        ownerRoute,
        ownerId,
      ]);
    });
    expect((await revokedPending).status).toBe(403);
    await restoreAccount();

    const movedPending = ownerRead(getPath);
    await controlled.waitForCalls(7);
    await controlled.calls[6]!.finish(async () => {
      await updatePartition('moved', 'hosted-reading-point-test');
    });
    expect((await movedPending).status).toBe(503);
    await restorePartition();

    const fencedPending = ownerRead(metadataPath);
    await controlled.waitForCalls(8);
    await controlled.calls[7]!.finish(async () => {
      await updatePartition('fenced', null);
    });
    expect((await fencedPending).status).toBe(503);
  } finally {
    await restoreAccount();
    await restorePartition();
    bodyReads.restore();
    controlled.restore();
  }
});
