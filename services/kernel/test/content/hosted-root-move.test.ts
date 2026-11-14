import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';
import readNode from '../../src/content/hosted-version-read-node.sql';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';
import commitVersion from '../../src/content/hosted-version-commit.sql';

setDefaultTimeout(180_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

type HostedPageEntry = Readonly<{
  occurrenceId: string;
  parentId: string | null;
  position: number;
}>;

type HostedPage = Readonly<{ items: readonly HostedPageEntry[]; nextCursor: string | null }>;

async function readAllPages(path: string) {
  const items: HostedPageEntry[] = [];
  let cursor: string | null = null;
  let page: HostedPage | undefined;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const response = await f.native.call(
      'GET',
      `${path}${separator}limit=20${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(response.status).toBe(200);
    page = response.value as HostedPage;
    items.push(...page!.items);
    cursor = page!.nextCursor;
  } while (cursor !== null);
  return items;
}

function occurrenceUrl(path: string, occurrenceId: string, revisionId: string, kind: 'structure' | 'publication') {
  return `${path}/occurrences/${occurrenceId}?kind=${kind}&revisionId=${revisionId}`;
}

test('promotes and reorders root occurrences while exact snapshots and chapter navigation stay stable', async () => {
  const { native } = f;
  const catalogue = await native.thread();
  const catalogueId = catalogue.firstPost.id;
  const path = `/v1/hostedCatalogues/${catalogueId}`;
  const movePath = `${path}:moveDraftPoint`;
  const target = f.target(await native.thread());
  const partA = f.newOccurrenceIdFor(catalogueId);
  const partB = f.newOccurrenceIdFor(catalogueId);
  const partD = f.newOccurrenceIdFor(catalogueId);
  const promotedChapter = f.newOccurrenceIdFor(catalogueId);
  const rootAnchor = f.newOccurrenceIdFor(catalogueId);
  const children = Array.from({ length: 256 }, () => f.newOccurrenceIdFor(catalogueId));

  const created = await native.call('POST', '/v1/hostedCatalogues', {
    postId: catalogueId,
    threadId: catalogue.id,
    placements: [],
  });
  expect(created.status).toBe(201);
  let draftRevisionId = created.value.revisionId as string;
  const insert = async (
    occurrenceId: string,
    parentId: string | null,
    title: string,
    placement: { kind: 'part' } | { kind: 'chapter'; target: typeof target },
  ) => {
    const result = await native.call('POST', `${path}:insertDraftPoint`, {
      expectedRevisionId: draftRevisionId,
      occurrenceId,
      parentId,
      beforeOccurrenceId: null,
      title,
      placement,
    });
    expect(result.status).toBe(200);
    draftRevisionId = result.value.revisionId as string;
  };
  await insert(partA, null, 'First root part', { kind: 'part' });
  await insert(partB, null, 'Second root part', { kind: 'part' });
  await insert(rootAnchor, null, 'Root anchor', { kind: 'chapter', target });
  await insert(promotedChapter, partA, 'Promoted chapter', { kind: 'chapter', target });
  await insert(partD, partA, 'Promoted Part', { kind: 'part' });
  for (const [index, occurrenceId] of children.entries()) {
    await insert(occurrenceId, partD, `Part chapter ${index}`, { kind: 'chapter', target });
  }

  const publication = await native.call('POST', `${path}:publish`, {
    expectedRevisionId: draftRevisionId,
    expectedPublicationId: null,
    occurrenceIds: [promotedChapter, rootAnchor, ...children],
  });
  expect(publication.status).toBe(200);
  const oldDraftRevisionId = draftRevisionId;
  const oldPublicationId = publication.value.revisionId as string;
  const oldDraftRoot = await readAllPages(`${path}/children?kind=structure&revisionId=${oldDraftRevisionId}`);
  const oldDraftPartChildren = await readAllPages(
    `${path}/children?kind=structure&revisionId=${oldDraftRevisionId}&parentId=${partA}`,
  );
  const oldDraftDescendants = await readAllPages(
    `${path}/children?kind=structure&revisionId=${oldDraftRevisionId}&parentId=${partD}`,
  );
  const oldDraftChapterLink = await native.call(
    'GET',
    occurrenceUrl(path, promotedChapter, oldDraftRevisionId, 'structure'),
  );
  const oldDraftDescendantLink = await native.call(
    'GET',
    occurrenceUrl(path, children[0]!, oldDraftRevisionId, 'structure'),
  );
  const oldReleaseChapterLink = await native.call(
    'GET',
    occurrenceUrl(path, promotedChapter, oldPublicationId, 'publication'),
  );
  const oldReleaseDescendantLink = await native.call(
    'GET',
    occurrenceUrl(path, children[0]!, oldPublicationId, 'publication'),
  );
  for (const response of [
    oldDraftChapterLink,
    oldDraftDescendantLink,
    oldReleaseChapterLink,
    oldReleaseDescendantLink,
  ]) {
    expect(response.status).toBe(200);
  }
  expect(oldDraftPartChildren.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
    promotedChapter,
    partD,
  ]);
  expect(oldDraftDescendants.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual(children);

  const promoteChapterInput = {
    expectedRevisionId: oldDraftRevisionId,
    occurrenceId: promotedChapter,
    parentId: null,
    beforeOccurrenceId: rootAnchor,
  };
  expect((await native.call('POST', movePath, promoteChapterInput, { other: true })).status).toBe(403);
  expect((await native.call('POST', movePath, { ...promoteChapterInput, parentId: 4 })).status).toBe(400);
  expect(
    (
      await native.call('POST', movePath, {
        ...promoteChapterInput,
        beforeOccurrenceId: children[0],
      })
    ).status,
  ).toBe(400);
  const chapterMoveKey = crypto.randomUUID();
  const promoted = await native.call('POST', movePath, promoteChapterInput, { key: chapterMoveKey });
  expect(promoted.status).toBe(200);
  const chapterMoveRevisionId = promoted.value.revisionId as string;

  const reordered = await native.call('POST', movePath, {
    expectedRevisionId: chapterMoveRevisionId,
    occurrenceId: promotedChapter,
    parentId: null,
    beforeOccurrenceId: partB,
  });
  expect(reordered.status).toBe(200);
  const reorderedRevisionId = reordered.value.revisionId as string;

  const observer = observeSql(native.pool);
  try {
    const moveStart = observer.records.length;
    const promotedPart = await native.call('POST', movePath, {
      expectedRevisionId: reorderedRevisionId,
      occurrenceId: partD,
      parentId: null,
      beforeOccurrenceId: null,
    });
    expect(promotedPart.status).toBe(200);
    const finalRevisionId = promotedPart.value.revisionId as string;
    const moveStatements = observer.records.slice(moveStart);
    const probeStatements: readonly string[] = [readNode.sql, readOccurrence.sql, readSiblingRoot.sql];
    const physicalProbes = moveStatements.filter((entry) => probeStatements.includes(entry.statement)).length;
    const pathBound = 96 * (Math.ceil(Math.log2(children.length + 1)) + 8);
    expect(physicalProbes).toBeLessThan(pathBound);
    expect(
      moveStatements.filter(
        (entry) =>
          /^SELECT/i.test(entry.statement) &&
          entry.statement.includes('content.hosted_occurrence_version') &&
          entry.statement !== readOccurrence.sql,
      ),
    ).toHaveLength(0);
    const commit = moveStatements.find((entry) => entry.statement === commitVersion.sql);
    expect(commit).toBeDefined();
    const nodeRows = JSON.parse(String(commit!.parameters[5])) as unknown[];
    const occurrenceRows = JSON.parse(String(commit!.parameters[6])) as unknown[];
    const siblingRootRows = JSON.parse(String(commit!.parameters[7])) as unknown[];
    expect(nodeRows.length).toBeLessThan(pathBound);
    expect(nodeRows.length).toBeLessThan(children.length);
    expect(occurrenceRows.length).toBeLessThan(16);
    expect(siblingRootRows.length).toBe(2);

    const replay = await native.call('POST', movePath, promoteChapterInput, { key: chapterMoveKey });
    expect(replay.status).toBe(200);
    expect(replay.value.revisionId).toBe(chapterMoveRevisionId);
    const appendNoOp = await native.call('POST', movePath, {
      expectedRevisionId: finalRevisionId,
      occurrenceId: partD,
      parentId: null,
      beforeOccurrenceId: null,
    });
    expect(appendNoOp.status).toBe(200);
    expect(appendNoOp.value.revisionId).toBe(finalRevisionId);
    expect(observer.records.filter((entry) => entry.statement === commitVersion.sql)).toHaveLength(1);

    const currentRoot = await readAllPages(`${path}/children?kind=structure&revisionId=${finalRevisionId}`);
    expect(
      currentRoot.map((item: { occurrenceId: string; parentId: string | null; position: number }) => [
        item.occurrenceId,
        item.parentId,
        item.position,
      ]),
    ).toEqual([
      [partA, null, 0],
      [promotedChapter, null, 1],
      [partB, null, 2],
      [rootAnchor, null, 3],
      [partD, null, 4],
    ]);
    const currentPartChildren = await readAllPages(
      `${path}/children?kind=structure&revisionId=${finalRevisionId}&parentId=${partA}`,
    );
    const currentDescendants = await readAllPages(
      `${path}/children?kind=structure&revisionId=${finalRevisionId}&parentId=${partD}`,
    );
    expect(currentPartChildren).toEqual([]);
    expect(currentDescendants.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual(children);

    const outline = (await readAllPages(`${path}/outline?kind=structure&revisionId=${finalRevisionId}`)) as {
      occurrenceId: string;
      parentId: string | null;
      position: number;
    }[];
    expect(outline.map((item) => item.occurrenceId)).toEqual([
      partA,
      promotedChapter,
      partB,
      rootAnchor,
      partD,
      ...children,
    ]);
    expect(outline.slice(0, 5).map((item) => [item.parentId, item.position])).toEqual([
      [null, 0],
      [null, 1],
      [null, 2],
      [null, 3],
      [null, 4],
    ]);
    expect(outline.slice(5).map((item) => [item.parentId, item.position])).toEqual(
      children.map((_, index) => [partD, index]),
    );
    expect(outline[1]).toMatchObject({ occurrenceId: promotedChapter, parentId: null, position: 1, target });
    expect(outline[5]).toMatchObject({ occurrenceId: children[0], parentId: partD, position: 0, target });

    const next = await native.call(
      'GET',
      `${path}/occurrences/${promotedChapter}/navigation?kind=structure&revisionId=${finalRevisionId}&direction=next&limit=5`,
    );
    const previous = await native.call(
      'GET',
      `${path}/occurrences/${children[0]}/navigation?kind=structure&revisionId=${finalRevisionId}&direction=previous&limit=2`,
    );
    expect(next.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      rootAnchor,
      ...children.slice(0, 4),
    ]);
    expect(previous.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      rootAnchor,
      promotedChapter,
    ]);

    expect(await readAllPages(`${path}/children?kind=structure&revisionId=${oldDraftRevisionId}`)).toEqual(
      oldDraftRoot,
    );
    expect(
      await readAllPages(`${path}/children?kind=structure&revisionId=${oldDraftRevisionId}&parentId=${partA}`),
    ).toEqual(oldDraftPartChildren);
    expect(await native.call('GET', occurrenceUrl(path, promotedChapter, oldDraftRevisionId, 'structure'))).toEqual(
      oldDraftChapterLink,
    );
    expect(await native.call('GET', occurrenceUrl(path, children[0]!, oldDraftRevisionId, 'structure'))).toEqual(
      oldDraftDescendantLink,
    );
    expect(await native.call('GET', occurrenceUrl(path, promotedChapter, oldPublicationId, 'publication'))).toEqual(
      oldReleaseChapterLink,
    );
    expect(await native.call('GET', occurrenceUrl(path, children[0]!, oldPublicationId, 'publication'))).toEqual(
      oldReleaseDescendantLink,
    );
  } finally {
    await observer.close();
  }
});
