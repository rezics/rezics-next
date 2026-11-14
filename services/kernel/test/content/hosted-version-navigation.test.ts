import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { AccessClient } from '../../src/request/access.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { readHostedDraftPointSnapshot, type HostedVersionPointValue } from '../../src/content/hosted-version-draft-write.ts';
import { readHostedVersionChapterPage } from '../../src/content/hosted-version-read-pages.ts';
import type { HostedVersionReadIndex } from '../../src/content/hosted-version-read-pages-model.ts';
import { createHostedVersionWrite, hostedVersionSequence } from '../../src/content/hosted-version-store.ts';

setDefaultTimeout(360_000);

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
});
afterAll(async () => {
  await f?.close();
});

type NavigationPage = Readonly<{
  items: readonly Readonly<{ occurrenceId: string }>[];
  nextCursor: string | null;
}>;

async function convertDraft(path: string, expectedRevisionId: string): Promise<string> {
  const conversion = `${path}:convertDraft`;
  const capture = await f.native.command(conversion, { step: 'capture', expectedRevisionId }, 200);
  const inputId = capture.inputId as string;
  let progress = await f.native.command(conversion, { step: 'begin', inputId, expectedRevisionId }, 200);
  while (progress.nextStep === 'page') {
    progress = await f.native.command(
      conversion,
      { step: 'page', inputId, expectedRevisionId, cursor: progress.frontier },
      200,
    );
  }
  progress = await f.native.command(conversion, { step: 'seal', inputId, expectedRevisionId }, 200);
  progress = await f.native.command(conversion, { step: 'materialize', inputId, expectedRevisionId }, 200);
  while (progress.nextStep === 'materializePage') {
    progress = await f.native.command(conversion, { step: 'materializePage', inputId, expectedRevisionId }, 200);
  }
  const committed = await f.native.command(conversion, { step: 'commit', inputId, expectedRevisionId }, 200);
  return committed.revisionId as string;
}

test('mounted chapter navigation pages exact nested snapshots in both directions', async () => {
  const catalogue = await f.native.thread();
  const path = `/v1/hostedCatalogues/${catalogue.firstPost.id}`;
  const source = await f.native.thread();
  const target = f.target(source);
  const chapterIds = Array.from({ length: 20 }, () => f.newOccurrenceIdFor(catalogue.firstPost.id));
  const originPartIds = Array.from({ length: chapterIds.length }, () => f.newOccurrenceIdFor(catalogue.firstPost.id));
  const chapterId = (rank: number) => chapterIds[rank]!;
  const outerPart = f.newOccurrenceIdFor(catalogue.firstPost.id);
  const chapter = (rank: number, position: number) => ({
    occurrenceId: chapterId(rank),
    parentId: outerPart,
    position,
    title: `Chapter ${rank}`,
    kind: 'chapter' as const,
    target,
  });
  const markerPart = (rank: number) => ({
    occurrenceId: originPartIds[rank]!,
    parentId: outerPart,
    position: rank * 2 + 1,
    title: `Navigation part ${rank}`,
    kind: 'part' as const,
  });
  const placements = [
    { occurrenceId: outerPart, parentId: null, position: 0, title: 'Nested chapters', kind: 'part' as const },
    ...chapterIds.flatMap((_, rank) => [chapter(rank, rank * 2), markerPart(rank)]),
  ];
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: catalogue.firstPost.id,
    threadId: catalogue.id,
    placements,
  });
  expect(created.status).toBe(201);
  const revisionId = await convertDraft(path, created.value.revisionId as string);

  async function navigate(
    originId: string,
    direction: 'previous' | 'next',
    selectedRevisionId = revisionId,
    limit = 20,
    cursor?: string,
  ): Promise<NavigationPage> {
    const query = new URLSearchParams({
      kind: 'structure',
      revisionId: selectedRevisionId,
      direction,
      limit: String(limit),
    });
    if (cursor) query.set('cursor', cursor);
    const result = await f.native.call('GET', `${path}/occurrences/${originId}/navigation?${query.toString()}`);
    expect(result.status).toBe(200);
    return result.value as NavigationPage;
  }

  const client: AccessClient = f.native.pool;
  const snapshot = await readHostedDraftPointSnapshot(client, catalogue.firstPost.id, revisionId);
  if (!snapshot?.chapterRootId || !snapshot.preorderRootId)
    throw new Error('Converted hosted catalogue revision has no selected sequence roots');
  const heightWrite = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
  const chapterIndex = hostedVersionSequence(heightWrite, 'chapter');
  const preorderIndex = hostedVersionSequence(heightWrite, 'preorder');
  const chapterRoot = await chapterIndex.readNode(snapshot.chapterRootId);
  const preorderRoot = await preorderIndex.readNode(snapshot.preorderRootId);
  if (!chapterRoot?.leftId || !chapterRoot.rightId || !preorderRoot)
    throw new Error('Converted hosted chapter sequence does not have an interior root');
  const rootRank = Number((await chapterIndex.readNode(chapterRoot.leftId))!.count);
  const nextPart = originPartIds[rootRank - 1]!;
  const previousPart = originPartIds[rootRank]!;

  const oneAtATime = await navigate(originPartIds[3]!, 'next', revisionId, 1);
  expect(oneAtATime.items.map((item) => item.occurrenceId)).toEqual([chapterId(4)]);
  expect(oneAtATime.nextCursor).toEqual(expect.any(String));
  const oneAtATimeContinuation = await navigate(originPartIds[3]!, 'next', revisionId, 1, oneAtATime.nextCursor!);
  expect(oneAtATimeContinuation.items.map((item) => item.occurrenceId)).toEqual([chapterId(5)]);

  const nextFirst = await navigate(originPartIds[3]!, 'next', revisionId, 3);
  expect(nextFirst.items.map((item) => item.occurrenceId)).toEqual([chapterId(4), chapterId(5), chapterId(6)]);
  expect(nextFirst.nextCursor).toEqual(expect.any(String));
  const nextSecond = await navigate(originPartIds[3]!, 'next', revisionId, 3, nextFirst.nextCursor!);
  expect(nextSecond.items.map((item) => item.occurrenceId)).toEqual([chapterId(7), chapterId(8), chapterId(9)]);
  expect(new Set([...nextFirst.items, ...nextSecond.items].map((item) => item.occurrenceId)).size).toBe(6);

  const reverseFirst = await navigate(previousPart, 'previous', revisionId, 3);
  expect(reverseFirst.items.map((item) => item.occurrenceId)).toEqual([
    chapterId(rootRank),
    chapterId(rootRank - 1),
    chapterId(rootRank - 2),
  ]);
  expect(reverseFirst.nextCursor).toEqual(expect.any(String));
  const reverseSecond = await navigate(previousPart, 'previous', revisionId, 3, reverseFirst.nextCursor!);
  expect(reverseSecond.items.map((item) => item.occurrenceId)).toEqual([
    chapterId(rootRank - 3),
    chapterId(rootRank - 4),
    chapterId(rootRank - 5),
  ]);
  expect(new Set([...reverseFirst.items, ...reverseSecond.items].map((item) => item.occurrenceId)).size).toBe(6);

  expect((await navigate(nextPart, 'next', revisionId, 1)).items.map((item) => item.occurrenceId)).toEqual([
    chapterId(rootRank),
  ]);
  expect(
    (await navigate(chapterId(rootRank - 1), 'next', revisionId, 1)).items.map((item) => item.occurrenceId),
  ).toEqual([chapterId(rootRank)]);
  expect(
    (await navigate(chapterId(rootRank + 1), 'previous', revisionId, 1)).items.map((item) => item.occurrenceId),
  ).toEqual([chapterId(rootRank)]);

  const fromOuterPart = await navigate(outerPart, 'next', revisionId, 2);
  expect(fromOuterPart.items.map((item) => item.occurrenceId)).toEqual([chapterId(0), chapterId(1)]);
  const beforeFirst = await navigate(chapterId(0), 'previous', revisionId, 2);
  const afterLast = await navigate(chapterId(19), 'next', revisionId, 2);
  expect(beforeFirst).toMatchObject({ items: [], nextCursor: null });
  expect(afterLast).toMatchObject({ items: [], nextCursor: null });

  const heightBoundWrite = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
  const preorderHeight = (await hostedVersionSequence(heightBoundWrite, 'preorder').readNode(snapshot.preorderRootId))!
    .height;
  const chapterHeight = (await hostedVersionSequence(heightBoundWrite, 'chapter').readNode(snapshot.chapterRootId))!
    .height;
  async function nativePage(direction: 'previous' | 'next', originNodeId: string) {
    const write = createHostedVersionWrite<HostedVersionPointValue>(client, snapshot);
    const preorder: HostedVersionReadIndex<HostedVersionPointValue> = {
      rootId: snapshot.preorderRootId,
      access: hostedVersionSequence(write, 'preorder'),
    };
    const chapters: HostedVersionReadIndex<HostedVersionPointValue> = {
      rootId: snapshot.chapterRootId,
      access: hostedVersionSequence(write, 'chapter'),
    };
    return readHostedVersionChapterPage(preorder, chapters, { originNodeId, direction, limit: 3 });
  }
  const nativeNext = await nativePage('next', nextPart);
  const nativePrevious = await nativePage('previous', previousPart);
  expect(nativeNext.candidates.map((candidate) => candidate.nodeId)).toEqual([
    chapterId(rootRank),
    chapterId(rootRank + 1),
    chapterId(rootRank + 2),
    chapterId(rootRank + 3),
  ]);
  expect(nativeNext.nextAnchorId).toBe(chapterId(rootRank + 2));
  expect(nativePrevious.candidates.map((candidate) => candidate.nodeId)).toEqual([
    chapterId(rootRank),
    chapterId(rootRank - 1),
    chapterId(rootRank - 2),
    chapterId(rootRank - 3),
  ]);
  expect(nativePrevious.nextAnchorId).toBe(chapterId(rootRank - 2));
  const visitBound = 8 * (preorderHeight + chapterHeight + 3 + 2) + 16;
  for (const page of [nativeNext, nativePrevious]) {
    expect(page.hasMore).toBe(true);
    expect(page.work.logicalNodeReadCalls).toBeLessThanOrEqual(visitBound);
    expect(page.work.distinctLogicalNodeVisits).toBeLessThanOrEqual(visitBound);
    expect(page.work.snapshotProbeCount).toBeLessThanOrEqual(visitBound);
  }

  const moved = await f.native.call('POST', `${path}:moveDraftPoint`, {
    expectedRevisionId: revisionId,
    occurrenceId: chapterId(4),
    parentId: outerPart,
    beforeOccurrenceId: null,
  });
  expect(moved.status).toBe(200);
  const movedRevisionId = moved.value.revisionId as string;
  const oldFirstAfterMove = await navigate(originPartIds[3]!, 'next', revisionId, 3);
  const oldContinuationAfterMove = await navigate(originPartIds[3]!, 'next', revisionId, 3, nextFirst.nextCursor!);
  const currentFirst = await navigate(originPartIds[3]!, 'next', movedRevisionId, 3);
  expect(oldFirstAfterMove.items.map((item) => item.occurrenceId)).toEqual([
    chapterId(4),
    chapterId(5),
    chapterId(6),
  ]);
  expect(oldContinuationAfterMove.items.map((item) => item.occurrenceId)).toEqual([
    chapterId(7),
    chapterId(8),
    chapterId(9),
  ]);
  expect(currentFirst.items.map((item) => item.occurrenceId)).toEqual([
    chapterId(5),
    chapterId(6),
    chapterId(7),
  ]);
});
