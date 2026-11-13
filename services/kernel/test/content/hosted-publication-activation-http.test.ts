import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { routeOf } from '../../src/route/route.ts';

setDefaultTimeout(240_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;

beforeAll(async () => {
  f = await hostedChaptersFixture();
});

afterAll(async () => {
  await f?.close();
});

async function newBook() {
  const thread = await f.native.thread();
  const book = {
    catalogueId: thread.firstPost.id,
    threadId: thread.id,
    newId: () => f.newOccurrenceIdFor(thread.firstPost.id),
  };
  const target = f.target(thread);
  const rootPart = book.newId();
  const nestedChapter = book.newId();
  const publicChapter = book.newId();
  const placements: HostedPlacement[] = [
    { occurrenceId: rootPart, parentId: null, position: 0, title: 'Part one', kind: 'part' },
    {
      occurrenceId: nestedChapter,
      parentId: rootPart,
      position: 0,
      title: 'Nested chapter',
      kind: 'chapter',
      target,
    },
    {
      occurrenceId: publicChapter,
      parentId: null,
      position: 1,
      title: 'Existing release A',
      kind: 'chapter',
      target,
    },
  ];
  const path = `/v1/hostedCatalogues/${book.catalogueId}`;
  const created = await f.native.command('/v1/hostedCatalogues', {
    postId: book.catalogueId,
    threadId: book.threadId,
    placements,
  });
  const published = await f.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [publicChapter],
    },
    200,
  );
  return { ...book, path, target, publicChapter, created, published };
}

async function selectedRelease(catalogueId: string): Promise<string | null> {
  const row = (
    await f.native.pool.query<{ publication_id: string | null }>(
      'SELECT publication_id FROM content.hosted_catalogue WHERE route=$1 AND catalogue_id=$2',
      [routeOf(catalogueId), catalogueId],
    )
  ).rows[0];
  return row?.publication_id ?? null;
}

function stagePath(path: string, stageId: string): string {
  return `${path}/publicationPreparations/${stageId}`;
}

async function sealedCandidate(book: Awaited<ReturnType<typeof newBook>>) {
  const stageId = book.newId();
  const started = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId,
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(started.status).toBe(202);
  let progress = started.value;
  let pages = 0;
  while (!progress.candidate?.coverageComplete) {
    if (++pages > 16) throw new Error('The bounded candidate fixture did not complete');
    const advanced = await f.native.call('POST', `${stagePath(book.path, stageId)}:advance`, {
      stepId: book.newId(),
    });
    expect(advanced.status).toBe(200);
    progress = advanced.value;
  }
  const sealed = await f.native.call('POST', `${stagePath(book.path, stageId)}:seal`, {});
  expect(sealed.status).toBe(200);
  expect(sealed.value.candidateReady).toBe(true);
  return { stageId, path: stagePath(book.path, stageId), candidate: sealed.value.candidate };
}

async function advanceUntil(
  path: string,
  expected: 'ready' | 'checking' | 'restart' | 'activated',
): Promise<Record<string, any>> {
  let progress: Record<string, any> | undefined;
  for (let page = 0; page < 8; page++) {
    const advanced = await f.native.call('POST', `${path}:advanceActivation`, {});
    expect(advanced.status).toBe(200);
    progress = advanced.value;
    if (progress.state === expected) return progress;
  }
  throw new Error(`Activation did not reach ${expected}`);
}

test('mounted activation selects the sealed candidate, replays receipts and keeps A after stale authority', async () => {
  const book = await newBook();
  const candidate = await sealedCandidate(book);
  const startKey = crypto.randomUUID();
  const started = await f.native.call('POST', `${candidate.path}:startActivation`, {}, { key: startKey });
  expect(started.status).toBe(200);
  expect(started.value).toMatchObject({
    catalogueId: book.catalogueId,
    stageId: candidate.stageId,
    state: 'checking',
    publicationId: null,
    restartRequired: false,
    candidateGenerationId: candidate.candidate.generationId,
  });
  expect(started.value.passId).toEqual(expect.any(String));
  expect(started.value.checkedTargetCount).toBe('0');
  const replayedStart = await f.native.call('POST', `${candidate.path}:startActivation`, {}, { key: startKey });
  expect(replayedStart.status).toBe(200);
  expect(replayedStart.value).toEqual(started.value);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const advanceKey = crypto.randomUUID();
  const firstPage = await f.native.call('POST', `${candidate.path}:advanceActivation`, {}, { key: advanceKey });
  expect(firstPage.status).toBe(200);
  const ready = firstPage.value.state === 'ready' ? firstPage.value : await advanceUntil(candidate.path, 'ready');
  expect(ready).toMatchObject({
    state: 'ready',
    publicationId: null,
    restartRequired: false,
    candidateGenerationId: candidate.candidate.generationId,
  });
  const replayedAdvance = await f.native.call('POST', `${candidate.path}:advanceActivation`, {}, { key: advanceKey });
  expect(replayedAdvance.status).toBe(200);
  expect(replayedAdvance.value).toEqual(firstPage.value);

  await f.native.pool.query(
    `UPDATE core.publication_authority_epoch e
     SET epoch = e.epoch + 1
     FROM content.hosted_publication_activation_dependency d
     WHERE e.home_no = d.home_no AND d.route=$1 AND d.catalogue_id=$2 AND d.stage_id=$3`,
    [routeOf(book.catalogueId), book.catalogueId, candidate.stageId],
  );
  const stale = await f.native.call('POST', `${candidate.path}:activate`, {});
  expect(stale.status).toBe(200);
  expect(stale.value).toMatchObject({
    state: 'restart',
    restartRequired: true,
    publicationId: null,
    candidateGenerationId: candidate.candidate.generationId,
  });
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const resumed = await advanceUntil(candidate.path, 'ready');
  expect(resumed.candidateGenerationId).toBe(candidate.candidate.generationId);
  const activateKey = crypto.randomUUID();
  const activated = await f.native.call('POST', `${candidate.path}:activate`, {}, { key: activateKey });
  expect(activated.status).toBe(200);
  expect(activated.value).toMatchObject({
    catalogueId: book.catalogueId,
    stageId: candidate.stageId,
    state: 'activated',
    restartRequired: false,
    candidateGenerationId: candidate.candidate.generationId,
  });
  expect(activated.value.publicationId).toEqual(expect.any(String));
  expect(activated.value.publicationId).not.toBe(book.published.revisionId);
  expect(await selectedRelease(book.catalogueId)).toBe(activated.value.publicationId);

  await f.native.command(
    `${book.path}:revise`,
    {
      expectedRevisionId: book.created.revisionId,
      placements: [
        {
          occurrenceId: book.publicChapter,
          parentId: null,
          position: 0,
          title: 'Later draft',
          kind: 'chapter',
          target: book.target,
        },
      ],
    },
    200,
  );
  const replayedActivate = await f.native.call('POST', `${candidate.path}:activate`, {}, { key: activateKey });
  expect(replayedActivate.status).toBe(200);
  expect(replayedActivate.value).toEqual(activated.value);
  expect(await selectedRelease(book.catalogueId)).toBe(activated.value.publicationId);

  const published = await f.native.call(
    'GET',
    `${book.path}/children?kind=publication&revisionId=${activated.value.publicationId}`,
    undefined,
    { anonymous: true },
  );
  expect(published.status).toBe(200);
  expect(published.value.items?.length).toBeGreaterThan(0);
});

test('mounted activation maps author denial, missing locators, extra fields and unsealed conflict', async () => {
  const book = await newBook();
  const collecting = await f.native.call('POST', `${book.path}:prepareRelease`, {
    stageId: book.newId(),
    expectedRevisionId: book.created.revisionId,
    expectedPublicationId: book.published.revisionId,
    mode: 'whole',
  });
  expect(collecting.status).toBe(202);
  const collectingPath = stagePath(book.path, collecting.value.stageId as string);
  const unsealed = await f.native.call('POST', `${collectingPath}:startActivation`, {});
  expect(unsealed.status).toBe(412);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);

  const candidate = await sealedCandidate(book);
  const denied = await f.native.call('POST', `${candidate.path}:startActivation`, {}, { other: true });
  expect(denied.status).toBe(403);
  const extra = await f.native.call('POST', `${candidate.path}:startActivation`, { passId: book.newId() });
  expect(extra.status).toBe(400);
  const missing = await f.native.call('POST', `${stagePath(book.path, book.newId())}:startActivation`, {});
  expect(missing.status).toBe(404);
  const beforeReady = await f.native.call('POST', `${candidate.path}:activate`, {});
  expect(beforeReady.status).toBe(404);

  const started = await f.native.call('POST', `${candidate.path}:startActivation`, {});
  expect(started.status).toBe(200);
  expect(started.value.state).toBe('checking');
  const incomplete = await f.native.call('POST', `${candidate.path}:activate`, {});
  expect(incomplete.status).toBe(412);
  expect(await selectedRelease(book.catalogueId)).toBe(book.published.revisionId);
});
