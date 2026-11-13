import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool, PoolClient } from 'pg';
import { hostedChaptersFixture } from '../content/support/hosted-chapters-fixture.ts';
import { anchorRoute, newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readHostedReadingExportPage } from '../../src/library/hosted-reading.ts';
import { peekHostedReadingPort } from '../../src/library/hosted-reading-bind.ts';
import type { HostedReadingPort } from '../../src/library/contract/hosted-reading.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  restorePositionProjection?.();
  await f?.close();
});

let restorePositionProjection: (() => void) | undefined;
const ownerCall = (method: 'GET' | 'POST' | 'PUT', path: string, body: unknown, key?: string) =>
  f.native.call(method, path, body, { other: true, ...(key ? { key } : {}) });

async function subjectOnRoute(route: number): Promise<string> {
  let key = crypto.randomUUID();
  while (anchorRoute(f.native.system.routeKey, `${f.native.author.actor.accountId}\nsubject.create\n${key}`) !== route)
    key = crypto.randomUUID();
  const created = await f.native.call(
    'POST',
    '/v1/subjects',
    { type: 'skos:ConceptScheme', labels: { en: `Hosted reading ${crypto.randomUUID()}` } },
    { key },
  );
  expect(created.status, JSON.stringify(created.value)).toBe(201);
  const subjectId = created.value.subject.id as string;
  expect(routeOf(subjectId)).toBe(route);
  return subjectId;
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

function watchHostedReadingPort() {
  const port = peekHostedReadingPort();
  if (!port) throw new Error('Hosted reading Content port is not composed');
  const mutablePort = port as unknown as {
    readMetadata: HostedReadingPort['readMetadata'];
    resolveExact: HostedReadingPort['resolveExact'];
  };
  const originalMetadata = port.readMetadata;
  const originalExact = port.resolveExact;
  let metadataCalls = 0;
  let exactCalls = 0;
  mutablePort.readMetadata = (...args) => {
    metadataCalls += 1;
    return Reflect.apply(originalMetadata, port, args) as ReturnType<typeof originalMetadata>;
  };
  mutablePort.resolveExact = (...args) => {
    exactCalls += 1;
    return Reflect.apply(originalExact, port, args) as ReturnType<typeof originalExact>;
  };
  return {
    reset() {
      metadataCalls = 0;
      exactCalls = 0;
    },
    counts() {
      return { metadata: metadataCalls, exact: exactCalls };
    },
    restore() {
      mutablePort.readMetadata = originalMetadata;
      mutablePort.resolveExact = originalExact;
    },
  };
}

function projectHostedReadingPosition(occurrenceId: string, position: number) {
  const port = peekHostedReadingPort();
  if (!port) throw new Error('Hosted reading Content port is not composed');
  const mutablePort = port as unknown as {
    readMetadata: HostedReadingPort['readMetadata'];
    resolveExact: HostedReadingPort['resolveExact'];
  };
  const originalMetadata = port.readMetadata;
  const originalExact = port.resolveExact;
  mutablePort.readMetadata = async (...args) => {
    const result = await Reflect.apply(originalMetadata, port, args);
    return result.availability === 'available' && result.occurrenceId === occurrenceId
      ? { ...result, position }
      : result;
  };
  mutablePort.resolveExact = async (...args) => {
    const result = await Reflect.apply(originalExact, port, args);
    return result.availability === 'available' && result.occurrenceId === occurrenceId
      ? { ...result, position }
      : result;
  };
  return () => {
    mutablePort.readMetadata = originalMetadata;
    mutablePort.resolveExact = originalExact;
  };
}

test('owner checkpoint pages keep exact history, current disclosure and body-free metadata', async () => {
  const firstDocument = fromPlainText('Saved exact chapter');
  const secondDocument = fromPlainText('Second chapter');
  const firstThread = await f.native.thread('published', firstDocument);
  const secondThread = await f.native.thread('published', secondDocument);
  const firstTarget = f.target(firstThread);
  const secondTarget = f.target(secondThread);
  const firstOccurrence = f.newOccurrenceId();
  const secondOccurrence = f.newOccurrenceId();
  const cataloguePath = `/v1/hostedCatalogues/${f.catalogueId}`;
  const structure = await f.native.call(
    'POST',
    '/v1/hostedCatalogues',
    {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements: [
        {
          occurrenceId: firstOccurrence,
          parentId: null,
          position: 0,
          title: 'First chapter',
          kind: 'chapter',
          target: firstTarget,
        },
        {
          occurrenceId: secondOccurrence,
          parentId: null,
          position: 1,
          title: 'Second chapter',
          kind: 'chapter',
          target: secondTarget,
        },
      ],
    },
    { key: crypto.randomUUID() },
  );
  expect(structure.status).toBe(201);
  const publication = await f.native.call(
    'POST',
    `${cataloguePath}:publish`,
    {
      expectedRevisionId: structure.value.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [firstOccurrence, secondOccurrence],
    },
    { key: crypto.randomUUID() },
  );
  expect(publication.status).toBe(200);

  const ownerId = f.native.system.actors.other.actor.accountId;
  const ownerRoute = routeOf(ownerId)!;
  const catalogueRoute = routeOf(f.catalogueId)!;
  const subjectRoutes = [ownerRoute, ownerRoute ^ 0x10, ownerRoute ^ 0x20, ownerRoute ^ 0x30];
  const subjectOne = await subjectOnRoute(subjectRoutes[0]!);
  const subjectTwo = await subjectOnRoute(subjectRoutes[1]!);
  const subjectThree = await subjectOnRoute(subjectRoutes[2]!);
  const subjectFour = await subjectOnRoute(subjectRoutes[3]!);
  const subjects = [subjectOne, subjectTwo, subjectThree, subjectFour];
  expect(subjects.map((subjectId) => routeOf(subjectId))).toEqual(subjectRoutes);
  expect(new Set(subjects.map((subjectId) => partitionOf(routeOf(subjectId)!))).size).toBe(subjects.length);
  const catalogueState = await f.native.state(f.catalogueId);
  const associationRevision = await f.native.revise(
    {
      id: f.catalogueId,
      revisionId: String(catalogueState.head_revision_id),
      visibility: 'published',
    },
    { subjectIds: subjects },
  );
  expect(associationRevision.status, JSON.stringify(associationRevision.value)).toBe(200);
  const saveOne = {
    subjectId: subjectOne,
    catalogueId: f.catalogueId,
    publicationRevisionId: publication.value.revisionId,
    occurrenceId: firstOccurrence,
    targetRevisionId: firstTarget.revisionId,
    targetSha256: firstTarget.sha256,
    documentPosition: { blockId: 'opening-block', offset: 12 },
    expectedRevision: null,
  };
  const saveTwo = {
    ...saveOne,
    subjectId: subjectTwo,
    occurrenceId: secondOccurrence,
    targetRevisionId: secondTarget.revisionId,
    targetSha256: secondTarget.sha256,
    documentPosition: null,
  };
  const savedOne = await f.native.call('PUT', '/v1/libraryHostedReading', saveOne, {
    other: true,
    key: 'hosted-reading-save-one',
  });
  expect(savedOne.status, JSON.stringify(savedOne.value)).toBe(200);
  const directAssociationProjection = await f.native.pool.query(
    `SELECT 1 FROM content.subject_thread
     WHERE route=$1 AND subject_id=$2 AND thread_route=$3 AND thread_id=$4`,
    [routeOf(subjectOne), subjectOne, catalogueRoute, f.threadId],
  );
  expect(directAssociationProjection.rows).toHaveLength(0);
  await f.projectSubjectThread(f.threadId);
  const projectedCrossHomeAssociation = await f.native.pool.query(
    `SELECT 1 FROM content.subject_thread
     WHERE route=$1 AND subject_id=$2 AND thread_route=$3 AND thread_id=$4`,
    [routeOf(subjectTwo), subjectTwo, catalogueRoute, f.threadId],
  );
  expect(projectedCrossHomeAssociation.rows).toHaveLength(1);
  const savedTwo = await f.native.call('PUT', '/v1/libraryHostedReading', saveTwo, {
    other: true,
    key: 'hosted-reading-save-two',
  });
  expect(savedTwo.status, JSON.stringify(savedTwo.value)).toBe(200);
  const saveThree = { ...saveOne, subjectId: subjectThree };
  const savedThree = await f.native.call('PUT', '/v1/libraryHostedReading', saveThree, {
    other: true,
    key: 'hosted-reading-save-three',
  });
  expect(savedThree.status, JSON.stringify(savedThree.value)).toBe(200);
  const saveFour = { ...saveTwo, subjectId: subjectFour };
  const savedFour = await f.native.call('PUT', '/v1/libraryHostedReading', saveFour, {
    other: true,
    key: 'hosted-reading-save-four',
  });
  expect(savedFour.status, JSON.stringify(savedFour.value)).toBe(200);
  restorePositionProjection = projectHostedReadingPosition(firstOccurrence, 512);

  const readingPort = watchHostedReadingPort();
  const metadataBodyReads = watchChapterBodyReads(f.native.pool);
  try {
    const metadataPath = `/v1/libraryHostedReading/metadata?subjectId=${subjectOne}`;
    metadataBodyReads.reset();
    readingPort.reset();
    const noneSubject = newId(ownerRoute);
    const none = await f.native.call('GET', `/v1/libraryHostedReading/metadata?subjectId=${noneSubject}`, undefined, {
      other: true,
    });
    expect(none.status).toBe(200);
    expect(none.value).toEqual({ state: 'none', subjectId: noneSubject });
    expect(readingPort.counts()).toEqual({ metadata: 0, exact: 0 });

    const anonymous = await f.native.call('GET', metadataPath, undefined, { anonymous: true });
    expect(anonymous.status).toBe(401);
    const privateRead = await f.native.call('GET', metadataPath);
    expect(privateRead.status).toBe(200);
    expect(privateRead.value).toEqual({ state: 'none', subjectId: subjectOne });
    expect(readingPort.counts()).toEqual({ metadata: 0, exact: 0 });

    const metadataRead = await f.native.call('GET', metadataPath, undefined, { other: true });
    expect(metadataRead.status).toBe(200);
    expect(metadataRead.value).toMatchObject({
      state: 'saved',
      subjectId: subjectOne,
      revision: savedOne.value.revision,
      address: savedOne.value.address,
      metadata: {
        availability: 'available',
        occurrenceId: firstOccurrence,
        position: 512,
        title: 'First chapter',
        target: firstTarget,
      },
    });
    expect(metadataRead.value).not.toHaveProperty('resume');
    expect(readingPort.counts()).toEqual({ metadata: 1, exact: 0 });
    expect(metadataBodyReads.count()).toBe(0);
    expect(
      (
        await f.native.call(
          'GET',
          `/v1/libraryHostedReading/metadata?subjectId=${subjectOne}&subjectId=${subjectTwo}`,
          undefined,
          { other: true },
        )
      ).status,
    ).toBe(400);
  } finally {
    metadataBodyReads.restore();
    readingPort.restore();
  }

  const bodyReads = watchChapterBodyReads(f.native.pool);
  try {
    bodyReads.reset();
    const firstPage = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints?limit=1', undefined, {
      other: true,
    });
    expect(firstPage.status).toBe(200);
    expect(firstPage.value.items).toHaveLength(1);
    expect(firstPage.value.items[0]).toMatchObject({
      subjectId: subjectFour,
      revision: '1',
      address: {
        catalogueId: f.catalogueId,
        publicationRevisionId: publication.value.revisionId,
        occurrenceId: secondOccurrence,
        targetRevisionId: secondTarget.revisionId,
        targetSha256: secondTarget.sha256,
      },
      metadata: {
        availability: 'available',
        title: 'Second chapter',
        target: secondTarget,
      },
    });
    expect(firstPage.value.nextCursor).toEqual(expect.any(String));
    const secondPage = await f.native.call(
      'GET',
      `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(firstPage.value.nextCursor)}`,
      undefined,
      { other: true },
    );
    expect(secondPage.status).toBe(200);
    expect(secondPage.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectThree]);
    expect(secondPage.value.items[0]).toMatchObject({
      subjectId: subjectThree,
      address: {
        catalogueId: f.catalogueId,
        publicationRevisionId: publication.value.revisionId,
        occurrenceId: firstOccurrence,
        targetRevisionId: firstTarget.revisionId,
        targetSha256: firstTarget.sha256,
      },
      metadata: { availability: 'available', position: 512, title: 'First chapter', target: firstTarget },
    });
    expect(secondPage.value.nextCursor).toEqual(expect.any(String));
    const thirdPage = await f.native.call(
      'GET',
      `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(secondPage.value.nextCursor)}`,
      undefined,
      { other: true },
    );
    expect(thirdPage.status).toBe(200);
    expect(thirdPage.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectTwo]);
    expect(thirdPage.value.nextCursor).toEqual(expect.any(String));
    const fourthPage = await f.native.call(
      'GET',
      `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(thirdPage.value.nextCursor)}`,
      undefined,
      { other: true },
    );
    expect(fourthPage.status).toBe(200);
    expect(fourthPage.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectOne]);
    const pages = [firstPage, secondPage, thirdPage, fourthPage];
    expect(pages.flatMap((page) => page.value.items.map((item: { subjectId: string }) => item.subjectId))).toEqual([
      subjectFour,
      subjectThree,
      subjectTwo,
      subjectOne,
    ]);
    expect(
      new Set(pages.flatMap((page) => page.value.items.map((item: { subjectId: string }) => item.subjectId))).size,
    ).toBe(subjects.length);
    expect(fourthPage.value.nextCursor).toBeNull();
    const laterPageSubjectId = fourthPage.value.items[0].subjectId;
    const laterPageAddress = fourthPage.value.items[0].address;
    expect(laterPageAddress).toEqual(savedOne.value.address);
    expect(bodyReads.count()).toBe(0);
    const opened = await f.native.call('GET', `/v1/libraryHostedReading?subjectId=${laterPageSubjectId}`, undefined, {
      other: true,
    });
    expect(opened.status).toBe(200);
    const exactBytes = Buffer.from(serializeDocument(firstDocument), 'utf8');
    expect(opened.value).toMatchObject({
      state: 'saved',
      address: laterPageAddress,
      resume: {
        availability: 'available',
        position: 512,
        target: firstTarget,
        document: {
          canonicalBytes: exactBytes.toString('base64'),
          sha256: createHash('sha256').update(exactBytes).digest('hex'),
        },
      },
    });
    expect(bodyReads.count()).toBeGreaterThan(0);
    expect(
      (
        await f.native.call(
          'GET',
          `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(firstPage.value.nextCursor)}`,
          undefined,
          { anonymous: true },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.native.call(
          'GET',
          `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(firstPage.value.nextCursor)}`,
        )
      ).status,
    ).toBe(400);

    const beforeRetry = await f.native.pool.query(
      `SELECT revision::text,activity_sequence::text,changed_at::text
       FROM library.hosted_reading WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [ownerRoute, ownerId, subjectOne],
    );
    const retry = await f.native.call('PUT', '/v1/libraryHostedReading', saveOne, {
      other: true,
      key: 'hosted-reading-save-one',
    });
    expect(retry.value).toEqual(savedOne.value);
    const afterRetry = await f.native.pool.query(
      `SELECT revision::text,activity_sequence::text,changed_at::text
       FROM library.hosted_reading WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [ownerRoute, ownerId, subjectOne],
    );
    expect(afterRetry.rows).toEqual(beforeRetry.rows);
  } finally {
    bodyReads.restore();
  }

  const beforeRetirement = await f.native.state(f.catalogueId);
  const retiredAssociation = await f.native.revise(
    {
      id: f.catalogueId,
      revisionId: String(beforeRetirement.head_revision_id),
      visibility: 'published',
    },
    { subjectIds: [subjectOne] },
  );
  expect(retiredAssociation.status, JSON.stringify(retiredAssociation.value)).toBe(200);
  await f.projectSubjectThread(f.threadId);
  const retiredProjection = await f.native.pool.query(
    `SELECT 1 FROM content.subject_thread
     WHERE route=$1 AND subject_id=$2 AND thread_route=$3 AND thread_id=$4`,
    [routeOf(subjectTwo), subjectTwo, catalogueRoute, f.threadId],
  );
  expect(retiredProjection.rows).toHaveLength(0);
  const beforeRejectedSave = await f.native.pool.query(
    `SELECT revision::text,activity_sequence::text,changed_at::text,publication_revision_id,occurrence_id
     FROM library.hosted_reading WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [ownerRoute, ownerId, subjectTwo],
  );
  const retiredSave = await f.native.call(
    'PUT',
    '/v1/libraryHostedReading',
    {
      ...saveTwo,
      documentPosition: { blockId: 'retired-association', offset: 4 },
      expectedRevision: savedTwo.value.revision,
    },
    { other: true, key: crypto.randomUUID() },
  );
  expect(retiredSave.status).toBe(404);
  const afterRejectedSave = await f.native.pool.query(
    `SELECT revision::text,activity_sequence::text,changed_at::text,publication_revision_id,occurrence_id
     FROM library.hosted_reading WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [ownerRoute, ownerId, subjectTwo],
  );
  expect(afterRejectedSave.rows).toEqual(beforeRejectedSave.rows);

  const moved = await f.native.call(
    'POST',
    `${cataloguePath}:revise`,
    {
      expectedRevisionId: structure.value.revisionId,
      placements: [
        {
          occurrenceId: secondOccurrence,
          parentId: null,
          position: 0,
          title: 'Second chapter moved first',
          kind: 'chapter',
          target: secondTarget,
        },
        {
          occurrenceId: firstOccurrence,
          parentId: null,
          position: 1,
          title: 'First chapter moved second',
          kind: 'chapter',
          target: firstTarget,
        },
      ],
    },
    { key: crypto.randomUUID() },
  );
  expect(moved.status).toBe(200);
  const laterPublication = await f.native.call(
    'POST',
    `${cataloguePath}:publish`,
    {
      expectedRevisionId: moved.value.revisionId,
      expectedPublicationId: publication.value.revisionId,
      occurrenceIds: [secondOccurrence, firstOccurrence],
    },
    { key: crypto.randomUUID() },
  );
  expect(laterPublication.status).toBe(200);
  const historicalSave = await ownerCall(
    'PUT',
    '/v1/libraryHostedReading',
    { ...saveOne, expectedRevision: savedOne.value.revision },
    crypto.randomUUID(),
  );
  expect(historicalSave.status, JSON.stringify(historicalSave.value)).toBe(200);
  expect(historicalSave.value.address.publicationRevisionId).toBe(publication.value.revisionId);

  // Rebuild the migration seed from a checkpoint that predates its durable fence.
  await f.native.pool.query(
    `DELETE FROM library.hosted_reading_fence WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [ownerRoute, ownerId, subjectOne],
  );
  await f.native.pool.query(
    `INSERT INTO library.hosted_reading_fence (route,account_id,subject_id,revision)
     SELECT route,account_id,subject_id,revision FROM library.hosted_reading
     WHERE route=$1 AND account_id=$2 AND subject_id=$3
     ON CONFLICT (route,account_id,subject_id) DO UPDATE SET revision=EXCLUDED.revision`,
    [ownerRoute, ownerId, subjectOne],
  );
  const clearAKey = 'hosted-reading-clear-A';
  const clearAInput = { subjectId: subjectOne, expectedRevision: historicalSave.value.revision };
  const clearA = await ownerCall('POST', '/v1/libraryHostedReading/$clear', clearAInput, clearAKey);

  const saveBInput = {
    ...saveOne,
    documentPosition: { blockId: 'new-checkpoint', offset: 73 },
    expectedRevision: null,
  };
  const savedB = await ownerCall('PUT', '/v1/libraryHostedReading', saveBInput, 'hosted-reading-save-B');
  expect(BigInt(savedB.value.revision)).toBeGreaterThan(BigInt(historicalSave.value.revision));

  const staleUpdate = await ownerCall(
    'PUT',
    '/v1/libraryHostedReading',
    {
      ...saveOne,
      documentPosition: { blockId: 'delayed-old-position', offset: 19 },
      expectedRevision: historicalSave.value.revision,
    },
    'hosted-reading-stale-update-A',
  );
  expect(staleUpdate.status).toBe(409);
  const staleClear = await ownerCall(
    'POST',
    '/v1/libraryHostedReading/$clear',
    clearAInput,
    'hosted-reading-stale-clear-A',
  );
  expect(staleClear.status).toBe(409);

  const replayedA = await ownerCall('PUT', '/v1/libraryHostedReading', saveOne, 'hosted-reading-save-one');
  expect(replayedA.value).toEqual(savedOne.value);
  const replayedClearA = await ownerCall('POST', '/v1/libraryHostedReading/$clear', clearAInput, clearAKey);
  expect(replayedClearA.value).toEqual(clearA.value);
  const afterOldReplays = await ownerCall('GET', `/v1/libraryHostedReading?subjectId=${subjectOne}`, undefined);
  expect(afterOldReplays.value).toMatchObject({
    state: 'saved',
    revision: savedB.value.revision,
    address: savedB.value.address,
    resume: { availability: 'available', occurrenceId: firstOccurrence, target: firstTarget },
  });

  const currentWrite = await ownerCall(
    'PUT',
    '/v1/libraryHostedReading',
    {
      ...saveBInput,
      documentPosition: { blockId: 'current-checkpoint', offset: 88 },
      expectedRevision: savedB.value.revision,
    },
    'hosted-reading-current-fence-write',
  );
  expect(currentWrite.status, JSON.stringify(currentWrite.value)).toBe(200);
  const withdrawn = await f.native.call(
    'POST',
    `${cataloguePath}:publish`,
    {
      expectedRevisionId: moved.value.revisionId,
      expectedPublicationId: laterPublication.value.revisionId,
      occurrenceIds: [],
    },
    { key: crypto.randomUUID() },
  );
  expect(withdrawn.status).toBe(200);

  const historicalBodyReads = watchChapterBodyReads(f.native.pool);
  try {
    historicalBodyReads.reset();
    const current = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints', undefined, { other: true });
    const historical = current.value.items.find((item: { subjectId: string }) => item.subjectId === subjectOne);
    expect(historical).toMatchObject({
      revision: currentWrite.value.revision,
      address: {
        publicationRevisionId: publication.value.revisionId,
        occurrenceId: firstOccurrence,
        documentPosition: { blockId: 'current-checkpoint', offset: 88 },
      },
      metadata: { availability: 'available', position: 512, title: 'First chapter', target: firstTarget },
    });
    expect(historical.address).toEqual(currentWrite.value.address);
    expect(current.value.items.find((item: { subjectId: string }) => item.subjectId === subjectTwo)).toMatchObject({
      subjectId: subjectTwo,
      address: { occurrenceId: secondOccurrence, targetRevisionId: secondTarget.revisionId },
    });
    expect(historicalBodyReads.count()).toBe(0);
    const opened = await f.native.call('GET', `/v1/libraryHostedReading?subjectId=${subjectOne}`, undefined, {
      other: true,
    });
    const exactBytes = Buffer.from(serializeDocument(firstDocument), 'utf8');
    expect(opened.value).toMatchObject({
      state: 'saved',
      revision: currentWrite.value.revision,
      address: historical.address,
      resume: {
        availability: 'available',
        position: 512,
        target: firstTarget,
        document: {
          canonicalBytes: exactBytes.toString('base64'),
          sha256: createHash('sha256').update(exactBytes).digest('hex'),
        },
      },
    });
    expect(historicalBodyReads.count()).toBeGreaterThan(0);
  } finally {
    historicalBodyReads.restore();
  }
  restorePositionProjection?.();
  restorePositionProjection = undefined;

  const cleared = await f.native.call(
    'POST',
    '/v1/libraryHostedReading/$clear',
    { subjectId: subjectTwo, expectedRevision: savedTwo.value.revision },
    { other: true, key: crypto.randomUUID() },
  );
  expect(cleared.status).toBe(200);
  const clearedThree = await f.native.call(
    'POST',
    '/v1/libraryHostedReading/$clear',
    { subjectId: subjectThree, expectedRevision: savedThree.value.revision },
    { other: true, key: crypto.randomUUID() },
  );
  expect(clearedThree.status).toBe(200);
  const clearedFour = await f.native.call(
    'POST',
    '/v1/libraryHostedReading/$clear',
    { subjectId: subjectFour, expectedRevision: savedFour.value.revision },
    { other: true, key: crypto.randomUUID() },
  );
  expect(clearedFour.status).toBe(200);
  const afterClear = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints', undefined, { other: true });
  expect(afterClear.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectOne]);

  const protectedTarget = await f.native.revise(firstThread.firstPost, { visibility: 'protected' });
  expect(protectedTarget.status).toBe(200);
  const unavailablePort = watchHostedReadingPort();
  const unavailableBodyReads = watchChapterBodyReads(f.native.pool);
  try {
    unavailablePort.reset();
    unavailableBodyReads.reset();
    const unavailable = await f.native.call(
      'GET',
      `/v1/libraryHostedReading/metadata?subjectId=${subjectOne}`,
      undefined,
      { other: true },
    );
    expect(unavailable.status).toBe(200);
    expect(unavailable.value).toMatchObject({
      state: 'saved',
      subjectId: subjectOne,
      revision: currentWrite.value.revision,
      address: currentWrite.value.address,
      metadata: { availability: 'unavailable', occurrenceId: firstOccurrence, kind: 'chapter' },
    });
    expect(unavailablePort.counts()).toEqual({ metadata: 1, exact: 0 });
    expect(unavailableBodyReads.count()).toBe(0);
  } finally {
    unavailableBodyReads.restore();
    unavailablePort.restore();
  }
  const concealedPage = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints', undefined, { other: true });
  const concealed = concealedPage.value.items[0];
  expect(concealed.address).toMatchObject({
    targetRevisionId: firstTarget.revisionId,
    targetSha256: firstTarget.sha256,
  });
  expect(concealed.metadata).toEqual({
    availability: 'unavailable',
    occurrenceId: firstOccurrence,
    kind: 'chapter',
  });
  expect(concealed.metadata).not.toHaveProperty('title');
  expect(concealed.metadata).not.toHaveProperty('target');
  const concealedOpen = await f.native.call('GET', `/v1/libraryHostedReading?subjectId=${subjectOne}`, undefined, {
    other: true,
  });
  expect(concealedOpen.value.resume).toEqual({
    availability: 'unavailable',
    occurrenceId: firstOccurrence,
    kind: 'chapter',
  });

  const clearCurrent = await ownerCall(
    'POST',
    '/v1/libraryHostedReading/$clear',
    { subjectId: subjectOne, expectedRevision: currentWrite.value.revision },
    'hosted-reading-current-fence-clear',
  );
  expect(clearCurrent.status, JSON.stringify(clearCurrent.value)).toBe(200);
  expect((await ownerCall('GET', `/v1/libraryHostedReading?subjectId=${subjectOne}`, undefined)).value).toEqual({
    state: 'none',
    subjectId: subjectOne,
  });
  const absentPage = await ownerCall('GET', '/v1/libraryHostedReading/checkpoints', undefined);
  expect(absentPage.value.items.map((item: { subjectId: string }) => item.subjectId)).not.toContain(subjectOne);
  const exported = await readHostedReadingExportPage(
    f.native.pool,
    ownerRoute,
    ownerId,
    '00000000-0000-0000-0000-000000000000',
    100,
  );
  expect(exported.map((item: { subject_id: string }) => item.subject_id)).not.toContain(subjectOne);
});
