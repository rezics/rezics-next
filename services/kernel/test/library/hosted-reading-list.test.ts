import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fromPlainText, serializeDocument } from '@rezics/document';
import type { Pool, PoolClient } from 'pg';
import { hostedChaptersFixture } from '../content/support/hosted-chapters-fixture.ts';
import { newId, routeOf } from '../../src/route/route.ts';

setDefaultTimeout(180_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

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
  const subjectOne = newId(ownerRoute);
  const subjectTwo = newId(ownerRoute);
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
  const savedTwo = await f.native.call('PUT', '/v1/libraryHostedReading', saveTwo, {
    other: true,
    key: 'hosted-reading-save-two',
  });
  expect(savedOne.status).toBe(200);
  expect(savedTwo.status).toBe(200);

  const bodyReads = watchChapterBodyReads(f.native.pool);
  try {
    bodyReads.reset();
    const firstPage = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints?limit=1', undefined, {
      other: true,
    });
    expect(firstPage.status).toBe(200);
    expect(firstPage.value.items).toHaveLength(1);
    expect(firstPage.value.items[0]).toMatchObject({
      subjectId: subjectTwo,
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
    const nextPage = await f.native.call(
      'GET',
      `/v1/libraryHostedReading/checkpoints?limit=1&cursor=${encodeURIComponent(firstPage.value.nextCursor)}`,
      undefined,
      { other: true },
    );
    expect(nextPage.status).toBe(200);
    expect(nextPage.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectOne]);
    expect(bodyReads.count()).toBe(0);
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
      address: { publicationRevisionId: publication.value.revisionId, occurrenceId: firstOccurrence },
      metadata: { availability: 'available', position: 0, title: 'First chapter', target: firstTarget },
    });
    expect(historicalBodyReads.count()).toBe(0);
    const opened = await f.native.call('GET', `/v1/libraryHostedReading?subjectId=${subjectOne}`, undefined, {
      other: true,
    });
    const exactBytes = Buffer.from(serializeDocument(firstDocument), 'utf8');
    expect(opened.value).toMatchObject({
      state: 'saved',
      address: historical.address,
      resume: {
        availability: 'available',
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

  const cleared = await f.native.call(
    'POST',
    '/v1/libraryHostedReading/$clear',
    { subjectId: subjectTwo, expectedRevision: savedTwo.value.revision },
    { other: true, key: crypto.randomUUID() },
  );
  expect(cleared.status).toBe(200);
  const afterClear = await f.native.call('GET', '/v1/libraryHostedReading/checkpoints', undefined, { other: true });
  expect(afterClear.value.items.map((item: { subjectId: string }) => item.subjectId)).toEqual([subjectOne]);

  const protectedTarget = await f.native.revise(firstThread.firstPost, { visibility: 'protected' });
  expect(protectedTarget.status).toBe(200);
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
});
