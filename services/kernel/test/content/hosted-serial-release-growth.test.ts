import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText, serializeDocument } from '@rezics/document';
import { decodeJwt } from 'jose';
import { materializeHostedSelection } from '../../src/content/hosted-direct-selection.ts';
import { HOSTED_PAGE_LIMIT } from '../../src/content/hosted-chapters-limits.ts';
import type { HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import { HOSTED_PUBLICATION_STAGING_STEP_LIMIT } from '../../src/content/hosted-publication-staging-model.ts';
import { HOSTED_VERSION_RELEASE_CANDIDATE_PAGE_MAX } from '../../src/content/hosted-version-release-candidate-model.ts';
import { withBoundedReadConnection } from '../../src/database/pool.ts';
import { routeOf } from '../../src/route/route.ts';
import { captureWithFoldedCost, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

let f: Awaited<ReturnType<typeof hostedChaptersFixture>>;
let growth: GrowthDatabase;
beforeAll(async () => {
  f = await hostedChaptersFixture();
  growth = await openGrowthDatabase(f.native.pool.options.connectionString);
}, 180_000);
afterAll(async () => {
  try {
    if (growth) {
      console.info('Hosted serial teardown: starting growth database close');
      await growth.close();
      console.info('Hosted serial teardown: completed growth database close');
    }
  } finally {
    await f?.close((phase, state) => console.info(`Hosted serial teardown: ${state} ${phase}`));
  }
}, 180_000);

test('a growing serial keeps exact public releases and advances preparation in bounded pages', async () => {
  const { native } = f;
  const access = native.system.createFreshAccess(undefined, growth.pool);
  const kernel = native.system.createKernelForPool(growth.pool, access);
  const measuredScales = {
    'first preparation page': [] as number[],
    'later preparation page': [] as number[],
    'point publication': [] as number[],
    'public TOC': [] as number[],
    'exact public body': [] as number[],
  };
  async function measureHttp(
    operation: keyof typeof measuredScales,
    scale: number,
    request: () => ReturnType<typeof native.call>,
  ) {
    const { value, capture } = await captureWithFoldedCost(growth, request);
    expect({ status: value.status, error: value.status === 200 ? null : value.value }).toEqual({
      status: 200,
      error: null,
    });
    const { rows, blocks, statements, plans, requestBytes, responseBytes, limitations } = capture.cost;
    expect(plans).toBeGreaterThan(0);
    measuredScales[operation].push(scale);
    const hostedRelations = Object.fromEntries(
      Object.entries(capture.cost.relations).filter(
        ([name, relation]) => relation.identity?.name.startsWith('hosted_') || name.startsWith('content.hosted_'),
      ),
    );
    expect(Object.keys(hostedRelations).length).toBeGreaterThan(0);
    console.info(
      'Hosted native physical growth',
      JSON.stringify({
        operation,
        scale,
        rows,
        blocks,
        statements,
        requestBytes,
        responseBytes,
        limitations,
        hostedRelations,
      }),
    );
    return { response: value, statements: capture.statements };
  }
  const path = `/v1/hostedCatalogues/${f.catalogueId}`;
  const originalBody = fromPlainText('Opening');
  const source = await native.thread('published', originalBody);
  const target = f.target(source);
  // Keep source diversity fixed across the size series, with more than one authority page.
  const sourceTargets = [target];
  for (let index = 1; index < 21; index++) {
    const chapter = await native.thread('published', fromPlainText(`Retained source ${index}`));
    sourceTargets.push(f.target(chapter));
  }
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
      target: sourceTargets[index % sourceTargets.length]!,
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

  const read = (suffix: string, through?: typeof kernel) =>
    native.call('GET', `${path}${suffix}`, undefined, { anonymous: true, ...(through ? { kernel: through } : {}) });
  const childrenPath = (parentId?: string) =>
    `/children?kind=publication&limit=${HOSTED_PAGE_LIMIT}${parentId ? `&parentId=${parentId}` : ''}`;
  const exact = (revision: string, through?: typeof kernel) =>
    read(`/occurrences/${nested}?kind=publication&revisionId=${revision}`, through);
  async function expectCurrent(revisionId: string | null, measureAtSize?: number) {
    const result =
      measureAtSize === undefined
        ? await read(childrenPath())
        : (await measureHttp('public TOC', measureAtSize, () => read(childrenPath(), kernel))).response;
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
        const branch = await read(childrenPath(parent));
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
        target: sourceTargets[draftChapters % sourceTargets.length]!,
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
    const laterStep = Math.floor((size + 2) / (2 * HOSTED_PUBLICATION_STAGING_STEP_LIMIT));
    const firstStep = { stepId: f.newOccurrenceId() };
    while (!progress.candidate?.coverageComplete) {
      expect(++steps).toBeLessThanOrEqual(maxSteps);
      const input = steps === 1 ? firstStep : { stepId: f.newOccurrenceId() };
      const advance = `${stagePath}:advance`;
      const next =
        steps === 1 || steps === laterStep
          ? (
              await measureHttp(steps === 1 ? 'first preparation page' : 'later preparation page', size, () =>
                native.call('POST', advance, input, { kernel }),
              )
            ).response.value
          : await native.command(advance, input, 200);
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
    const authorityTargetCount = String(sourceTargets.length + 1);
    expect(activation.totalTargetCount).toBe(authorityTargetCount);
    let authorityPages = 0;
    while (activation.state !== 'ready') {
      expect(authorityPages++).toBeLessThan(4);
      activation = await native.command(`${stagePath}:advanceActivation`, {}, 200);
    }
    expect(activation.checkedTargetCount).toBe(authorityTargetCount);
    expect(authorityPages).toBeGreaterThan(1);
    await expectCurrent(current);
    const result = await native.command(`${stagePath}:activate`, {}, 200);
    expect(result.state).toBe('activated');
    current = result.publicationId;
    await expectCurrent(current, size);
    console.info('Hosted serial preparation growth', {
      chapters: size,
      placements: size + 2,
      steps,
      authorityTargetCount,
      authorityPages,
    });
    return result.publicationId as string;
  }

  const bytes = (body: ReturnType<typeof fromPlainText>) =>
    Buffer.from(serializeDocument(body), 'utf8').toString('base64');

  async function publishLast(size: number) {
    const previous = current;
    await grow(size);
    await expectCurrent(previous);
    expect((await read(`/occurrences/${lastChapter}?kind=publication&revisionId=${previous}`)).status).toBe(404);
    const { response, statements } = await measureHttp('point publication', size, () =>
      native.call(
        'POST',
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
        { kernel },
      ),
    );
    current = response.value.revisionId;
    expect(
      statements.some((statement) => /(?:INSERT INTO|UPDATE) content\.hosted_(?:placement|append)\b/i.test(statement)),
    ).toBe(false);
    await expectCurrent(current);
    const chapter = await read(`/occurrences/${lastChapter}?kind=publication&revisionId=${current}`);
    expect(chapter.status).toBe(200);
    expect(chapter.value.occurrence.target).toEqual(target);
  }
  await grow(511);
  await expectCurrent(null);
  const originalPublicationId = await releaseWhole(511);
  const { response: original } = await measureHttp('exact public body', 511, () =>
    exact(originalPublicationId, kernel),
  );
  expect(original.value.occurrence.target).toEqual(target);
  expect(original.value.document.canonicalBytes).toBe(bytes(originalBody));

  for (const size of [512, 513]) await publishLast(size);
  for (const size of [1_000, 10_000]) {
    await provisionExistingDraft(size);
    const wholePublicationId = await releaseWhole(size);
    const { response: selected } = await measureHttp('exact public body', size, () =>
      exact(wholePublicationId, kernel),
    );
    expect(selected.value.occurrence.target).toEqual(target);
    expect(selected.value.document.canonicalBytes).toBe(original.value.document.canonicalBytes);
    await publishLast(size + 1);
    const retained = await exact(originalPublicationId);
    expect(retained.status).toBe(200);
    expect(retained.value.document.canonicalBytes).toBe(original.value.document.canonicalBytes);
  }
  await grow(10_002);
  const selectedBody = fromPlainText('Explicitly selected replacement');
  const reviseStartedAt = Date.now();
  const revised = await native.revise(source.firstPost, { body: selectedBody });
  if (revised.status !== 200) {
    const reviseEndedAt = Date.now();
    const { exp } = decodeJwt(native.author.bearer);
    const post = await withBoundedReadConnection(native.pool, reviseEndedAt + 3_000, (client) =>
      client.query(
        `SELECT p.head_revision_id=$4 AS original_head_current,p.author_account_id=$5 AS author_matches,
                p.visibility AS post_visibility,p.availability,t.visibility AS thread_visibility,
                p.security_revision IS NOT NULL AND t.security_revision IS NOT NULL AS security_revisions_present
         FROM content.post p JOIN content.thread t USING(route,thread_id)
         WHERE p.route=$1 AND p.thread_id=$2 AND p.post_id=$3`,
        [
          routeOf(source.firstPost.id),
          source.id,
          source.firstPost.id,
          source.firstPost.revisionId,
          native.author.actor.accountId,
        ],
      ),
    ).then(
      (result) => result.rows[0] ?? null,
      () => 'unavailable',
    );
    console.info('Hosted serial late source revise', {
      status: revised.status,
      code: revised.value.code,
      effectStatus: revised.value.effect_status,
      bearerRemainingAtStartMs: exp === undefined ? null : exp * 1_000 - reviseStartedAt,
      bearerRemainingAtEndMs: exp === undefined ? null : exp * 1_000 - reviseEndedAt,
      post,
    });
  }
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

  expect(measuredScales['first preparation page']).toEqual([511, 1_000, 10_000]);
  expect(measuredScales['later preparation page']).toEqual([511, 1_000, 10_000]);
  expect(measuredScales['point publication']).toEqual([512, 513, 1_001, 10_001]);
  expect(measuredScales['public TOC']).toEqual([511, 1_000, 10_000]);
  expect(measuredScales['exact public body']).toEqual([511, 1_000, 10_000]);
}, 480_000);
