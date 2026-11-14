import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { pageVersionedHostedPlacements } from '../../src/content/hosted-chapters-version-reads.ts';
import { readHostedDraftPointSnapshot } from '../../src/content/hosted-version-draft-write.ts';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readOccurrences from '../../src/content/hosted-version-read-occurrences.sql';
import readNodes from '../../src/content/hosted-version-read-nodes.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';
import readSiblingRoots from '../../src/content/hosted-version-read-sibling-roots.sql';
import type { HostedVersionSnapshot } from '../../src/content/hosted-version-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql, type SqlObserver } from './support/sql-observer.ts';

setDefaultTimeout(360_000);
let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let observer: SqlObserver | undefined;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await observer?.close();
  await f?.close();
});

async function convertDraft(path: string, expectedRevisionId: string): Promise<string> {
  const route = `${path}:convertDraft`;
  const captured = await f.native.command(route, { step: 'capture', expectedRevisionId }, 200);
  const inputId = captured.inputId as string;
  const advance = (step: string, cursor?: unknown) =>
    f.native.command(route, { step, inputId, expectedRevisionId, ...(cursor === undefined ? {} : { cursor }) }, 200);
  let progress = await advance('begin');
  while (progress.nextStep === 'page') progress = await advance('page', progress.frontier);
  progress = await advance('seal');
  progress = await advance('materialize');
  while (progress.nextStep === 'materializePage') progress = await advance('materializePage');
  return (await advance('commit')).revisionId as string;
}

test('outline and chapter windows hydrate only visible rows with bounded temporal batches', async () => {
  const catalogue = await f.native.thread();
  const target = f.target(await f.native.thread());
  const path = `/v1/hostedCatalogues/${catalogue.firstPost.id}`;
  const partIds = Array.from({ length: 2 }, () => f.newOccurrenceIdFor(catalogue.firstPost.id));
  const chapterIds = partIds.map(() =>
    Array.from({ length: 10 }, () => f.newOccurrenceIdFor(catalogue.firstPost.id)),
  );
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: catalogue.firstPost.id,
    threadId: catalogue.id,
    placements: [
      ...partIds.map((occurrenceId, position) => ({
        occurrenceId,
        parentId: null,
        position,
        title: `Part ${position}`,
        kind: 'part' as const,
      })),
      ...chapterIds.flatMap((partChapters, partIndex) =>
        partChapters.map((occurrenceId, position) => ({
          occurrenceId,
          parentId: partIds[partIndex]!,
          position,
          title: `Chapter ${partIndex}-${position}`,
          kind: 'chapter' as const,
          target,
        })),
      ),
    ],
  });
  expect(created.status).toBe(201);
  const revisionId = await convertDraft(path, created.value.revisionId as string);
  const client = f.native.pool;
  const snapshot = await readHostedDraftPointSnapshot(client, catalogue.firstPost.id, revisionId);
  if (!snapshot) throw new Error('Converted hosted catalogue has no exact ordered snapshot');
  observer = observeSql(f.native.pool);

  async function page(
    selectedSnapshot: HostedVersionSnapshot,
    mode: 'outline' | 'next' | 'previous',
    occurrenceId: string | null,
    limit: number,
    ids: readonly string[],
    parentIds: readonly (string | null)[],
    cursorAfter: number | null,
  ) {
    const start = observer!.records.length;
    const result = await pageVersionedHostedPlacements(client, selectedSnapshot, {
      mode,
      parentId: null,
      occurrenceId,
      cursorAfter,
      limit,
    });
    const records = observer!.records.slice(start);
    const occurrences = records.filter(({ statement }) => statement === readOccurrences.sql);
    const roots = records.filter(({ statement }) => statement === readSiblingRoots.sql);
    const nodeBatches = records.filter(({ statement }) => statement === readNodes.sql);
    expect(records.filter(({ statement }) => statement === readOccurrence.sql)).toHaveLength(0);
    expect(records.filter(({ statement }) => statement === readSiblingRoot.sql)).toHaveLength(0);
    expect(records.some(({ statement }) => /\b(?:FROM|JOIN) content\.post\b/.test(statement))).toBe(false);
    if (ids.length === 0) {
      expect(occurrences).toHaveLength(0);
      expect(roots).toHaveLength(0);
      expect(nodeBatches).toHaveLength(0);
      expect(result.placements).toEqual([]);
      return result;
    }
    expect(occurrences).toHaveLength(1);
    expect(roots).toHaveLength(1);
    expect(nodeBatches.length).toBeGreaterThan(0);
    expect(occurrences[0]!.parameters[3]).toEqual(ids);
    expect(roots[0]!.parameters[3]).toEqual(parentIds);
    expect(occurrences[0]!.statement).toContain('occurrence.occurrence_id=ANY($4::uuid[])');
    expect(occurrences[0]!.statement).toContain('DISTINCT ON (occurrence.occurrence_id)');
    expect(occurrences[0]!.statement).toContain('occurrence.sequence <= $5');
    expect(roots[0]!.statement).toContain('FROM unnest($4::uuid[])');
    expect(roots[0]!.statement).toContain('root.sequence <= $6');
    expect(nodeBatches[0]!.statement).toContain('DISTINCT ON (node.node_id)');
    expect(nodeBatches[0]!.statement).toContain('node.route=$1 AND node.catalogue_id=$2 AND node.generation_id=$3');
    expect(nodeBatches[0]!.statement).toContain('node.index_kind=$4');
    expect(nodeBatches[0]!.statement).toContain('node.node_id=ANY($5::uuid[])');
    expect(nodeBatches[0]!.statement).toContain('node.sequence <= $6');
    const requestedNodeIds = nodeBatches.flatMap(({ parameters }) => parameters[4] as string[]);
    expect(requestedNodeIds).toHaveLength(new Set(requestedNodeIds).size);
    for (const batch of nodeBatches) {
      const batchIds = batch.parameters[4] as string[];
      expect(batchIds).toEqual([...new Set(batchIds)]);
      expect(batchIds.length).toBeLessThanOrEqual(ids.length * 2);
      expect(batch.parameters[0]).toBe(selectedSnapshot.route);
      expect(batch.parameters[1]).toBe(selectedSnapshot.catalogueId);
      expect(batch.parameters[2]).toBe(selectedSnapshot.generationId);
      expect(batch.parameters[3]).toBe('sibling');
      expect(batch.parameters[5]).toBe(selectedSnapshot.sequence.toString());
    }
    if (ids.length === 10) expect(nodeBatches.length).toBeLessThan(ids.length);
    expect(result.placements.map(({ occurrenceId }) => occurrenceId)).toEqual(ids);
    return result;
  }

  const firstPart = partIds[0]!;
  const secondPart = partIds[1]!;
  const firstChapters = chapterIds[0]!;
  const secondChapters = chapterIds[1]!;
  const outlineOne = await page(snapshot, 'outline', null, 1, [firstPart], [null], null);
  const outlineTen = await page(
    snapshot,
    'outline',
    null,
    10,
    [firstPart, ...firstChapters.slice(0, 9)],
    [null, firstPart],
    null,
  );
  const outlineMixed = await page(
    snapshot,
    'outline',
    null,
    10,
    [...firstChapters.slice(8), secondPart, ...secondChapters.slice(0, 7)],
    [firstPart, null, secondPart],
    8,
  );
  expect(outlineOne.placements[0]).toMatchObject({
    occurrenceId: firstPart,
    parentId: null,
    position: 0,
    ordinal: 0,
  });
  expect(outlineTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal])).toEqual([
    [firstPart, 0, 0],
    ...firstChapters.slice(0, 9).map((id, index) => [id, index, index + 1]),
  ]);
  const mixedOutlineCoordinates = outlineMixed.placements.map(({ occurrenceId, parentId, position, ordinal }) => [
    occurrenceId,
    parentId,
    position,
    ordinal,
  ]);
  expect(mixedOutlineCoordinates).toEqual([
    ...firstChapters.slice(8).map((id, index) => [id, firstPart, index + 8, index + 9]),
    [secondPart, null, 1, 11],
    ...secondChapters.slice(0, 7).map((id, index) => [id, secondPart, index, index + 12]),
  ]);
  expect(outlineTen).toMatchObject({ lastAfter: 9, hasMore: true });
  expect(outlineMixed).toMatchObject({ lastAfter: 18, hasMore: true });

  const nextTenIds = [...firstChapters.slice(5), ...secondChapters.slice(0, 5)];
  const nextTen = await page(snapshot, 'next', firstChapters[4]!, 10, nextTenIds, [firstPart, secondPart], null);
  const previousTenIds = [...secondChapters.slice(0, 5).reverse(), ...firstChapters.slice(5).reverse()];
  const previousTen = await page(
    snapshot,
    'previous',
    secondChapters[5]!,
    10,
    previousTenIds,
    [secondPart, firstPart],
    null,
  );
  const nextOne = await page(snapshot, 'next', firstChapters[4]!, 1, [firstChapters[5]!], [firstPart], null);
  const previousOne = await page(
    snapshot,
    'previous',
    secondChapters[5]!,
    1,
    [secondChapters[4]!],
    [secondPart],
    null,
  );
  expect(nextOne).toMatchObject({ origin: 4, lastAfter: 5, hasMore: true });
  expect(nextTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal])).toEqual(
    [
      ...firstChapters.slice(5).map((id, index) => [id, index + 5, index + 5]),
      ...secondChapters.slice(0, 5).map((id, index) => [id, index, index + 10]),
    ],
  );
  expect(nextTen.lastAfter).toBe(14);
  expect(previousOne).toMatchObject({ origin: 15, lastAfter: 14, hasMore: true });
  expect(previousTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal])).toEqual([
    ...secondChapters.slice(0, 5).reverse().map((id, index) => [id, 4 - index, 14 - index]),
    ...firstChapters.slice(5).reverse().map((id, index) => [id, 9 - index, 9 - index]),
  ]);
  expect(previousTen.lastAfter).toBe(5);
  expect(await page(snapshot, 'outline', null, 1, [], [], 21)).toMatchObject({
    placements: [],
    lastAfter: null,
    hasMore: false,
  });

  const movedPlacements = [
    ...partIds.map((occurrenceId, position) => ({
      occurrenceId,
      parentId: null,
      position,
      title: `Part ${position}`,
      kind: 'part' as const,
    })),
    ...firstChapters.slice(0, 9).map((occurrenceId, position) => ({
      occurrenceId,
      parentId: firstPart,
      position,
      title: `Chapter 0-${position}`,
      kind: 'chapter' as const,
      target,
    })),
    ...secondChapters.map((occurrenceId, position) => ({
      occurrenceId,
      parentId: secondPart,
      position,
      title: `Chapter 1-${position}`,
      kind: 'chapter' as const,
      target,
    })),
    {
      occurrenceId: firstChapters[9]!,
      parentId: secondPart,
      position: 10,
      title: 'Chapter 0-9',
      kind: 'chapter' as const,
      target,
    },
  ];
  const moved = await f.native.command(
    `${path}:revise`,
    { expectedRevisionId: revisionId, placements: movedPlacements },
    200,
  );
  const movedSnapshot = await readHostedDraftPointSnapshot(client, catalogue.firstPost.id, moved.revisionId as string);
  if (!movedSnapshot) throw new Error('Moved hosted catalogue has no exact ordered snapshot');
  const oldSnapshotPage = await page(snapshot, 'outline', null, 1, [firstChapters[9]!], [firstPart], 9);
  const movedSnapshotPage = await page(movedSnapshot, 'outline', null, 1, [firstChapters[9]!], [secondPart], 20);
  expect(oldSnapshotPage.placements[0]).toMatchObject({
    occurrenceId: firstChapters[9],
    parentId: firstPart,
    position: 9,
    ordinal: 10,
  });
  expect(movedSnapshotPage.placements[0]).toMatchObject({
    occurrenceId: firstChapters[9],
    parentId: secondPart,
    position: 10,
    ordinal: 21,
  });
});
