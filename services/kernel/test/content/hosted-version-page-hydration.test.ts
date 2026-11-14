import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { pageVersionedHostedPlacements } from '../../src/content/hosted-chapters-version-reads.ts';
import { readHostedDraftPointSnapshot } from '../../src/content/hosted-version-draft-write.ts';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import readOccurrences from '../../src/content/hosted-version-read-occurrences.sql';
import readSiblingRoot from '../../src/content/hosted-version-read-sibling-root.sql';
import readSiblingRoots from '../../src/content/hosted-version-read-sibling-roots.sql';
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
  const partId = f.newOccurrenceIdFor(catalogue.firstPost.id);
  const chapterIds = Array.from({ length: 20 }, () => f.newOccurrenceIdFor(catalogue.firstPost.id));
  const created = await f.native.call('POST', '/v1/hostedCatalogues', {
    postId: catalogue.firstPost.id,
    threadId: catalogue.id,
    placements: [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Chapters', kind: 'part' },
      ...chapterIds.map((occurrenceId, position) => ({
        occurrenceId,
        parentId: partId,
        position,
        title: `Chapter ${position}`,
        kind: 'chapter' as const,
        target,
      })),
    ],
  });
  expect(created.status).toBe(201);
  const revisionId = await convertDraft(path, created.value.revisionId as string);
  const client = f.native.pool;
  const snapshot = await readHostedDraftPointSnapshot(client, catalogue.firstPost.id, revisionId);
  if (!snapshot) throw new Error('Converted hosted catalogue has no exact ordered snapshot');
  observer = observeSql(f.native.pool);

  async function page(
    mode: 'outline' | 'next' | 'previous',
    occurrenceId: string | null,
    limit: number,
    ids: readonly string[],
    parentIds: readonly (string | null)[],
    cursorAfter: number | null = mode === 'outline' ? 0 : null,
  ) {
    const start = observer!.records.length;
    const result = await pageVersionedHostedPlacements(client, snapshot, {
      mode,
      parentId: null,
      occurrenceId,
      cursorAfter,
      limit,
    });
    const records = observer!.records.slice(start);
    const occurrences = records.filter(({ statement }) => statement === readOccurrences.sql);
    const roots = records.filter(({ statement }) => statement === readSiblingRoots.sql);
    expect(occurrences).toHaveLength(1);
    expect(roots).toHaveLength(1);
    expect(records.filter(({ statement }) => statement === readOccurrence.sql)).toHaveLength(0);
    expect(records.filter(({ statement }) => statement === readSiblingRoot.sql)).toHaveLength(0);
    expect(records.some(({ statement }) => /\b(?:FROM|JOIN) content\.post\b/.test(statement))).toBe(false);
    expect(occurrences[0]!.parameters[3]).toEqual(ids);
    expect(roots[0]!.parameters[3]).toEqual(parentIds);
    expect(occurrences[0]!.statement).toContain('occurrence.occurrence_id=ANY($4::uuid[])');
    expect(occurrences[0]!.statement).toContain('DISTINCT ON (occurrence.occurrence_id)');
    expect(occurrences[0]!.statement).toContain('occurrence.sequence <= $5');
    expect(roots[0]!.statement).toContain('FROM unnest($4::uuid[])');
    expect(roots[0]!.statement).toContain('root.sequence <= $6');
    expect(result.placements.map(({ occurrenceId }) => occurrenceId)).toEqual(ids);
    return result;
  }

  const outlineOne = await page('outline', null, 1, [chapterIds[0]!], [partId]);
  const outlineTen = await page('outline', null, 10, chapterIds.slice(0, 10), [partId]);
  const outlineRoots = await page('outline', null, 10, [partId, ...chapterIds.slice(0, 9)], [null, partId], null);
  expect(outlineOne.placements[0]).toMatchObject({
    occurrenceId: chapterIds[0],
    parentId: partId,
    position: 0,
    ordinal: 1,
  });
  expect(outlineTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal])).toEqual(
    chapterIds.slice(0, 10).map((id, index) => [id, index, index + 1]),
  );
  expect(
    outlineRoots.placements.map(({ occurrenceId, parentId, position, ordinal }) => [
      occurrenceId,
      parentId,
      position,
      ordinal,
    ]),
  ).toEqual([[partId, null, 0, 0], ...chapterIds.slice(0, 9).map((id, index) => [id, partId, index, index + 1])]);
  expect(outlineTen).toMatchObject({ lastAfter: 10, hasMore: true });

  const nextOne = await page('next', chapterIds[4]!, 1, [chapterIds[5]!], [partId]);
  const nextTen = await page('next', chapterIds[4]!, 10, chapterIds.slice(5, 15), [partId]);
  const previousOne = await page('previous', chapterIds[15]!, 1, [chapterIds[14]!], [partId]);
  const previousTen = await page('previous', chapterIds[15]!, 10, chapterIds.slice(5, 15).reverse(), [partId]);
  expect(nextOne).toMatchObject({ origin: 4, lastAfter: 5, hasMore: true });
  expect(nextTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal])).toEqual(
    chapterIds.slice(5, 15).map((id, index) => [id, index + 5, index + 5]),
  );
  expect(nextTen.lastAfter).toBe(14);
  expect(previousOne).toMatchObject({ origin: 15, lastAfter: 14, hasMore: true });
  expect(
    previousTen.placements.map(({ occurrenceId, position, ordinal }) => [occurrenceId, position, ordinal]),
  ).toEqual(
    chapterIds
      .slice(5, 15)
      .reverse()
      .map((id) => [id, chapterIds.indexOf(id), chapterIds.indexOf(id)]),
  );
  expect(previousTen.lastAfter).toBe(5);
});
