import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { materializeHostedSelection } from '../../src/content/hosted-direct-selection.ts';
import { HOSTED_PAGE_LIMIT } from '../../src/content/hosted-chapters-limits.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { HOSTED_PUBLICATION_STAGING_STEP_LIMIT } from '../../src/content/hosted-publication-staging-model.ts';
import { HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX } from '../../src/content/hosted-version-release-candidate-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
beforeAll(async () => {
  f = await hostedChaptersFixture();
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 180_000);

test('a growing serial keeps exact public releases and advances preparation in bounded pages', async () => {
  const { native } = f;
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const originalBody = fromPlainText('Opening');
  const source = await native.thread('published', originalBody);
  const target = f.target(source);
  const root = f.newOccurrenceId();
  const part = f.newOccurrenceId();
  const nested = f.newOccurrenceId();
  const placements: HostedPlacement[] = [
    { occurrenceId: root, parentId: null, position: 0, title: 'Part', kind: 'part' },
    { occurrenceId: part, parentId: root, position: 0, title: 'Nested part', kind: 'part' },
    { occurrenceId: nested, parentId: part, position: 0, title: 'Nested chapter', kind: 'chapter', target },
    ...Array.from({ length: 508 }, (_, index): HostedPlacement => ({
      occurrenceId: f.newOccurrenceId(),
      parentId: null,
      position: index + 1,
      title: `Chapter ${index + 2}`,
      kind: 'chapter',
      target,
    })),
  ];
  let head: string = (
    await native.command('/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements,
    })
  ).revisionId;
  let draftChapters = placements.length - 2;
  let lastChapter = placements.at(-1)!.occurrenceId;
  let current: string | null = null;

  const read = (suffix: string) => native.call('GET', `${path}${suffix}`, undefined, { anonymous: true });
  const children = (parentId?: string) =>
    read(`/children?kind=publication&limit=${HOSTED_PAGE_LIMIT}${parentId ? `&parentId=${parentId}` : ''}`);
  const exact = (revision: string) => read(`/occurrences/${nested}?kind=publication&revisionId=${revision}`);
  async function expectCurrent(revisionId: string | null) {
    const result = await children();
    if (revisionId === null) {
      expect(result.status, JSON.stringify(result.value)).toBe(404);
    } else {
      expect(result.status).toBe(200);
      expect(result.value.revisionId).toBe(revisionId);
      expect(result.value.items.length).toBe(HOSTED_PAGE_LIMIT);
      expect(result.value.items[0].occurrenceId).toBe(root);
      for (const [parent, child] of [
        [root, part],
        [part, nested],
      ]) {
        const branch = await children(parent);
        expect(branch.status, JSON.stringify(branch.value)).toBe(200);
        expect(branch.value.revisionId).toBe(revisionId);
        expect(branch.value.items.map((row: { occurrenceId: string }) => row.occurrenceId)).toEqual([child]);
      }
    }
  }

  async function grow(size: number) {
    while (draftChapters < size) {
      lastChapter = f.newOccurrenceId();
      head = (
        await native.command(
          `${path}:appendRootChapter`,
          { expectedRevisionId: head, occurrenceId: lastChapter, title: `Chapter ${draftChapters + 1}`, target },
          200,
        )
      ).revisionId;
      placements.push({
        occurrenceId: lastChapter,
        parentId: null,
        position: draftChapters,
        title: `Chapter ${draftChapters + 1}`,
        kind: 'chapter',
        target,
      });
      draftChapters++;
    }
  }

  // Provision an existing large draft with the ordinary ordered generation writer.
  // The bounded HTTP preparation, visibility changes and point writes remain under test.
  async function provisionExistingDraft(size: number) {
    while (draftChapters < size) {
      lastChapter = f.newOccurrenceId();
      placements.push({
        occurrenceId: lastChapter,
        parentId: null,
        position: draftChapters,
        title: `Chapter ${draftChapters + 1}`,
        kind: 'chapter',
        target,
      });
      draftChapters++;
    }
    const revisionId = f.newOccurrenceId();
    const client = await native.pool.connect();
    try {
      await client.query('BEGIN');
      await materializeHostedSelection(
        client,
        f.catalogueId,
        placements.map((placement, ordinal) => ({ ...placement, ordinal })),
        {
          kind: 'structure',
          revisionId,
          expectedDraftRevisionId: head,
          recordedAt: new Date().toISOString(),
          transactionId: crypto.randomUUID(),
        },
      );
      await client.query('COMMIT');
      head = revisionId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function releaseWhole(size: number) {
    const stageId = f.newOccurrenceId();
    const stagePath = `${path}/publicationPreparations/${stageId}`;
    let progress = await native.command(
      `${path}:prepareRelease`,
      { stageId, expectedRevisionId: head, expectedPublicationId: current, mode: 'whole' },
      202,
    );
    let steps = 0;
    const maxSteps = Math.ceil((size + 2) / HOSTED_PUBLICATION_STAGING_STEP_LIMIT) * 2 + 10;
    const firstStep = { stepId: f.newOccurrenceId() };
    while (!progress.candidate?.coverageComplete) {
      expect(++steps).toBeLessThanOrEqual(maxSteps);
      const input = steps === 1 ? firstStep : { stepId: f.newOccurrenceId() };
      const next = await native.command(`${stagePath}:advance`, input, 200);
      expect(Number(next.stage.candidateCount) - Number(progress.stage.candidateCount)).toBeLessThanOrEqual(
        HOSTED_PUBLICATION_STAGING_STEP_LIMIT,
      );
      expect(
        Number(next.candidate?.placementCount ?? 0) - Number(progress.candidate?.placementCount ?? 0),
      ).toBeLessThanOrEqual(HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX);
      if (steps === 1) {
        await expectCurrent(current);
        const receipt = await native.command(`${stagePath}:advance`, firstStep, 200);
        expect(receipt).toEqual(next);
      }
      progress = next;
    }

    const sealed = await native.command(`${stagePath}:seal`, {}, 200);
    expect(sealed.candidate).toMatchObject({
      chapterCount: String(size),
      placementCount: String(size + 2),
      coverageComplete: true,
      sealed: true,
    });
    let activation = await native.command(`${stagePath}:startActivation`, {}, 200);
    for (let page = 0; activation.state !== 'ready'; page++) {
      expect(page).toBeLessThan(4);
      activation = await native.command(`${stagePath}:advanceActivation`, {}, 200);
    }
    await expectCurrent(current);
    const result = await native.command(`${stagePath}:activate`, {}, 200);
    expect(result.state).toBe('activated');
    current = result.publicationId;
    await expectCurrent(current);
    console.info('Hosted serial preparation growth', { chapters: size, placements: size + 2, steps });
    return result.publicationId as string;
  }

  const bytes = (body: ReturnType<typeof fromPlainText>) =>
    Buffer.from(serializeDocument(body), 'utf8').toString('base64');

  async function publishLast(size: number) {
    const previous = current;
    await grow(size);
    await expectCurrent(previous);
    expect((await read(`/occurrences/${lastChapter}?kind=publication&revisionId=${previous}`)).status).toBe(404);
    const observer = observeSql(native.pool);
    try {
      const published = await native.command(
        `${path}:publishChapter`,
        {
          expectedRevisionId: head,
          expectedPublicationId: previous,
          occurrenceId: lastChapter,
          target,
          parentId: null,
          beforeOccurrenceId: null,
          selectedAncestors: [],
        },
        200,
      );
      current = published.revisionId;
      expect(observer.records.length).toBeGreaterThan(0);
      expect(
        observer.records.some(({ statement }) =>
          /(?:INSERT INTO|UPDATE) content\.hosted_(?:placement|append)\b/i.test(statement),
        ),
      ).toBe(false);
      console.info('Hosted serial point publication growth', { chapters: size, statements: observer.records.length });
    } finally {
      await observer.close();
    }
    await expectCurrent(current);
    const chapter = await read(`/occurrences/${lastChapter}?kind=publication&revisionId=${current}`);
    expect(chapter.status).toBe(200);
    expect(chapter.value.occurrence.target).toEqual(target);
  }
  await grow(511);
  await expectCurrent(null);
  const originalPublicationId = await releaseWhole(511);
  const original = await exact(originalPublicationId);
  expect(original.status).toBe(200);
  expect(original.value.occurrence.target).toEqual(target);
  expect(original.value.document.canonicalBytes).toBe(bytes(originalBody));

  for (const size of [512, 513]) await publishLast(size);
  for (const size of [1_000, 10_000]) {
    await provisionExistingDraft(size);
    await releaseWhole(size);
    await publishLast(size + 1);
    const retained = await exact(originalPublicationId);
    expect(retained.status).toBe(200);
    expect(retained.value.document.canonicalBytes).toBe(original.value.document.canonicalBytes);
  }
  await grow(10_002);
  const selectedBody = fromPlainText('Explicitly selected replacement');
  const revised = await native.revise(source.firstPost, { body: selectedBody });
  expect(revised.status).toBe(200);
  const selectedTarget = { ...target, revisionId: revised.value.post.revisionId, sha256: revised.value.post.sha256 };
  head = (
    await native.command(
      `${path}:updateDraftPoint`,
      { expectedRevisionId: head, occurrenceId: nested, title: 'Nested chapter', target: selectedTarget },
      200,
    )
  ).revisionId;
  const newer = await native.revise(revised.value.post, { body: fromPlainText('Unselected newer source body') });
  expect(newer.status).toBe(200);
  const replacement = await native.command(
    `${path}:replacePublishedChapter`,
    { expectedRevisionId: head, expectedPublicationId: current, occurrenceId: nested, target: selectedTarget },
    200,
  );
  current = replacement.revisionId;
  const selected = await exact(replacement.revisionId);
  expect(selected.status).toBe(200);
  expect(selected.value.occurrence.target).toEqual(selectedTarget);
  expect(selected.value.document.canonicalBytes).toBe(bytes(selectedBody));
  expect((await exact(originalPublicationId)).value.document.canonicalBytes).toBe(
    original.value.document.canonicalBytes,
  );

  expect((await read(`/occurrences/${lastChapter}?kind=publication&revisionId=${current}`)).status).toBe(404);
  expect(
    (await native.call('GET', `${path}/occurrences/${lastChapter}?kind=structure&revisionId=${head}`)).status,
  ).toBe(200);
}, 480_000);
