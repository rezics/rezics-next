import { expect, setDefaultTimeout, test } from 'bun:test';
import readChain from '../../src/content/read-chain.sql';
import readOccurrence from '../../src/content/hosted-version-read-occurrence.sql';
import type { HostedRootAppendInput } from '../../src/content/hosted-chapters-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { hostedRootAppendBase } from './support/hosted-root-append-setup.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';

setDefaultTimeout(360_000);

async function readAllPages(f: Awaited<ReturnType<typeof hostedChaptersFixture>>, url: string) {
  let page = await f.native.call('GET', `${url}&limit=20`);
  const items: Record<string, unknown>[] = [...page.value.items];
  let cursor: string | null | undefined = page.value.nextCursor;
  while (cursor) {
    page = await f.native.call('GET', `${url}&limit=20&cursor=${encodeURIComponent(cursor)}`);
    items.push(...page.value.items);
    cursor = page.value.nextCursor;
  }
  return items;
}

async function convertDraft(
  f: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  path: string,
  expectedRevisionId: string,
): Promise<string> {
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

function assertNoLegacyRows(records: readonly SqlExecution[]) {
  expect(
    records.some((record) =>
      /(?:FROM|INSERT INTO|UPDATE) content\.hosted_(?:placement|append(?:_descriptor)?)/i.test(record.statement),
    ),
  ).toBe(false);
}

function assertNoBodies(records: readonly SqlExecution[]) {
  const bodyIndex = readChain.params.indexOf('include_body');
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  expect(
    records
      .filter((record) => record.statement === readChain.sql)
      .some((record) => record.parameters[bodyIndex] === true),
  ).toBe(false);
}

test('ordered root appends preserve history and publish exact bounded selections', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    const { path, target, placements, created, published } = await hostedRootAppendBase(f);
    const oldChapterId = placements[511]!.occurrenceId;
    const oldReleaseBefore = await f.native.call(
      'GET',
      `${path}/children?kind=publication&revisionId=${published.revisionId}`,
      undefined,
      { anonymous: true },
    );
    const oldChapterBefore = await f.native.call(
      'GET',
      `${path}/occurrences/${oldChapterId}?kind=structure&revisionId=${created.revisionId}`,
    );
    const orderedRevisionId = await convertDraft(f, path, created.revisionId);

    const firstInput: HostedRootAppendInput = {
      expectedRevisionId: orderedRevisionId,
      occurrenceId: f.newOccurrenceId(),
      title: 'First ordered append',
      target,
    };
    const firstStart = observer.records.length;
    const first = await f.native.command(`${path}:appendRootChapter`, firstInput, 200);
    const firstRecords = observer.records.slice(firstStart);
    assertNoLegacyRows(firstRecords);
    assertNoBodies(firstRecords);

    const secondInput: HostedRootAppendInput = {
      ...firstInput,
      expectedRevisionId: first.revisionId as string,
      occurrenceId: f.newOccurrenceId(),
      title: 'Second ordered append',
    };
    const secondStart = observer.records.length;
    const second = await f.native.command(`${path}:appendRootChapter`, secondInput, 200);
    const secondRecords = observer.records.slice(secondStart);
    assertNoLegacyRows(secondRecords);
    assertNoBodies(secondRecords);

    const head = second.revisionId as string;
    const roots = await readAllPages(f, `${path}/children?kind=structure&revisionId=${head}`);
    expect(roots).toHaveLength(499);
    expect(roots.slice(-2)).toMatchObject([
      { occurrenceId: firstInput.occurrenceId, parentId: null, position: 497, title: firstInput.title },
      { occurrenceId: secondInput.occurrenceId, parentId: null, position: 498, title: secondInput.title },
    ]);

    const outline = await readAllPages(f, `${path}/outline?kind=structure&revisionId=${head}`);
    expect(outline).toHaveLength(514);
    expect(outline.slice(-2).map((item) => item.occurrenceId)).toEqual([
      firstInput.occurrenceId,
      secondInput.occurrenceId,
    ]);
    const navigation = await f.native.call(
      'GET',
      `${path}/occurrences/${oldChapterId}/navigation?kind=structure&revisionId=${head}&direction=next&limit=5`,
    );
    expect(navigation.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      firstInput.occurrenceId,
      secondInput.occurrenceId,
    ]);

    const publishStart = observer.records.length;
    const nextPublication = await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: head,
        expectedPublicationId: published.revisionId,
        occurrenceIds: [oldChapterId, firstInput.occurrenceId],
      },
      200,
    );
    const publishRecords = observer.records.slice(publishStart);
    assertNoBodies(publishRecords);
    expect(
      publishRecords.filter((record) => record.statement === readOccurrence.sql).map((record) => record.parameters[3]),
    ).toEqual([oldChapterId, firstInput.occurrenceId]);
    expect(
      publishRecords.some((record) =>
        /FROM content\.hosted_(?:placement|append(?:_descriptor)?)/i.test(record.statement),
      ),
    ).toBe(false);

    const releasedBeforeEdit = await f.native.call('GET', `${path}/children`, undefined, { anonymous: true });
    expect(releasedBeforeEdit.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      oldChapterId,
      firstInput.occurrenceId,
    ]);
    expect(
      (
        await f.native.call('GET', `${path}/children?kind=publication&revisionId=${published.revisionId}`, undefined, {
          anonymous: true,
        })
      ).value,
    ).toEqual(oldReleaseBefore.value);
    expect(
      (
        await f.native.call(
          'GET',
          `${path}/occurrences/${oldChapterId}?kind=structure&revisionId=${created.revisionId}`,
        )
      ).value,
    ).toEqual(oldChapterBefore.value);

    const update = await f.native.command(
      `${path}:updateDraftPoint`,
      {
        expectedRevisionId: head,
        occurrenceId: firstInput.occurrenceId,
        title: 'Updated after publication',
        target,
      },
      200,
    );
    const updatedOutline = await readAllPages(
      f,
      `${path}/outline?kind=structure&revisionId=${update.revisionId as string}`,
    );
    expect(updatedOutline).toHaveLength(514);
    expect(updatedOutline.find((item) => item.occurrenceId === firstInput.occurrenceId)).toMatchObject({
      title: 'Updated after publication',
      target,
    });
    expect(updatedOutline.filter((item) => item.occurrenceId !== firstInput.occurrenceId)).toEqual(
      outline.filter((item) => item.occurrenceId !== firstInput.occurrenceId),
    );

    const frozenPublication = await f.native.call(
      'GET',
      `${path}/children?kind=publication&revisionId=${nextPublication.revisionId as string}`,
      undefined,
      { anonymous: true },
    );
    expect(frozenPublication.value.items).toMatchObject([
      { occurrenceId: oldChapterId },
      { occurrenceId: firstInput.occurrenceId, title: firstInput.title, target },
    ]);
    const currentPublication = await f.native.call('GET', `${path}/children`, undefined, { anonymous: true });
    expect(currentPublication.value.items).toEqual(frozenPublication.value.items);
    expect(
      currentPublication.value.items.some(
        (item: { occurrenceId: string }) => item.occurrenceId === secondInput.occurrenceId,
      ),
    ).toBe(false);
  } finally {
    await observer.close();
    await f.close();
  }
});
