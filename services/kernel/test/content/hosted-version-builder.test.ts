import { expect, setDefaultTimeout, test } from 'bun:test';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import { advanceHostedMigrationInput, captureHostedMigrationInput } from '../../src/content/hosted-migration-input.ts';
import {
  applyHostedVersionBuilderPage,
  beginHostedVersionBuilder,
  sealHostedVersionBuilder,
} from '../../src/content/hosted-version-builder.ts';
import { HostedVersionBuilderError } from '../../src/content/hosted-version-builder-model.ts';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);

const context = (idempotencyKey = crypto.randomUUID()) => ({
  deadline: Date.now() + 120_000,
  idempotencyKey,
  requestId: crypto.randomUUID(),
});

function dependencies(fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>): HostedCommandDependencies {
  return {
    pool: fixture.native.pool,
    access: fixture.native.system.access,
    tokens: fixture.native.system.tokenKeys,
    routeKey: fixture.native.system.routeKey,
    clock: () => new Date(),
  };
}

async function createStructure(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  placements: readonly unknown[],
): Promise<string> {
  return (
    await fixture.native.command('/v1/hostedCatalogues', {
      postId: fixture.catalogueId,
      threadId: fixture.threadId,
      placements,
    })
  ).revisionId as string;
}

async function transaction<T>(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  work: (tx: any) => Promise<T>,
) {
  const tx = await fixture.native.pool.connect();
  await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
}

test('resumes and replays 513 source entries in bounded pages without changing live pointers', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread());
    const placements = Array.from({ length: 512 }, (_, position) => ({
      occurrenceId: fixture.newOccurrenceId(),
      parentId: null,
      position,
      title: `Chapter ${position}`,
      kind: 'chapter',
      target,
    }));
    const baseRevisionId = await createStructure(fixture, placements);
    const appended = await appendHostedRootChapter(
      dependencies(fixture),
      fixture.native.author.actor,
      fixture.catalogueId,
      {
        expectedRevisionId: baseRevisionId,
        occurrenceId: fixture.newOccurrenceId(),
        title: 'Chapter 512',
        target,
      },
      context(),
    );
    const sourceRevisionId = appended.value.revisionId;
    const captured = await captureHostedMigrationInput(
      dependencies(fixture),
      fixture.native.author.actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: sourceRevisionId },
      context(),
    );
    expect(captured.value.source.expectedPlacementCount).toBe('513');
    await transaction(fixture, (tx) => beginHostedVersionBuilder(tx, captured.value));

    const before = await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    );
    let fromFrontier = captured.value.frontier;
    type BuilderPage = Parameters<typeof applyHostedVersionBuilderPage>[1];
    let finalPage: BuilderPage | null = null;
    let replayedFirstPage = false;
    while (finalPage === null) {
      const result = await advanceHostedMigrationInput(
        dependencies(fixture),
        fixture.native.author.actor,
        fixture.catalogueId,
        captured.value.inputId,
        { frontier: fromFrontier, limit: 20 },
        context(),
      );
      expect(result.items.length).toBeLessThanOrEqual(20);
      const page = { inputId: captured.value.inputId, fromFrontier, result };
      const applied = await transaction(fixture, (tx) => applyHostedVersionBuilderPage(tx, page));
      expect(applied.replayed).toBe(false);
      expect(applied.persistenceWork.sqlStatements).toBeGreaterThan(0);
      expect(applied.application?.logicalWork.pointFactsWritten).toBe(result.items.length);

      if (!replayedFirstPage) {
        replayedFirstPage = true;
        const replay = await transaction(fixture, (tx) => applyHostedVersionBuilderPage(tx, page));
        expect(replay.replayed).toBe(true);
        expect(replay.application).toBeNull();
      }
      fromFrontier = result.frontier;
      if (result.coverage.complete) finalPage = page;
    }

    if (finalPage === null) throw new Error('Hosted version source did not reach complete coverage');
    expect(finalPage.result.coverage).toEqual({ visited: '513', expected: '513', complete: true });
    const sealed = await transaction(fixture, (tx) => sealHostedVersionBuilder(tx, finalPage!));
    expect(sealed).toMatchObject({ placementCount: 513n, rootCount: 513n, chapterCount: 513n });
    const after = await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(fixture.catalogueId), fixture.catalogueId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(after.rows[0]?.head_revision_id).toBe(sourceRevisionId);
    expect(after.rows[0]?.head_revision_id).not.toBe(baseRevisionId);

    const stored = await fixture.native.pool.query<{ count: string; null_titles: string }>(
      `SELECT count(*)::text AS count,count(*) FILTER (WHERE title IS NULL)::text AS null_titles
       FROM content.hosted_version_builder_point
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, captured.value.inputId],
    );
    expect(stored.rows[0]).toEqual({ count: '513', null_titles: '0' });
  } finally {
    await fixture.close();
  }
});

test('refuses incomplete coverage and a migration page whose captured head is stale', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread());
    const firstId = fixture.newOccurrenceId();
    const secondId = fixture.newOccurrenceId();
    const baseRevisionId = await createStructure(fixture, [
      { occurrenceId: firstId, parentId: null, position: 0, title: 'One', kind: 'chapter', target },
      { occurrenceId: secondId, parentId: null, position: 1, title: 'Two', kind: 'chapter', target },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const incompleteCapture = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: baseRevisionId },
      context(),
    );
    await transaction(fixture, (tx) => beginHostedVersionBuilder(tx, incompleteCapture.value));
    const first = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      incompleteCapture.value.inputId,
      { frontier: incompleteCapture.value.frontier, limit: 1 },
      context(),
    );
    const incompletePage = {
      inputId: incompleteCapture.value.inputId,
      fromFrontier: incompleteCapture.value.frontier,
      result: first,
    };
    await transaction(fixture, (tx) => applyHostedVersionBuilderPage(tx, incompletePage));
    await expect(transaction(fixture, (tx) => sealHostedVersionBuilder(tx, incompletePage))).rejects.toMatchObject({
      code: 'incomplete-source',
    } satisfies Partial<HostedVersionBuilderError>);

    const staleCapture = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: baseRevisionId },
      context(),
    );
    await transaction(fixture, (tx) => beginHostedVersionBuilder(tx, staleCapture.value));
    await appendHostedRootChapter(
      deps,
      actor,
      fixture.catalogueId,
      { expectedRevisionId: baseRevisionId, occurrenceId: fixture.newOccurrenceId(), title: 'Later', target },
      context(),
    );
    const stale = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      staleCapture.value.inputId,
      { frontier: staleCapture.value.frontier, limit: 20 },
      context(),
    );
    expect(stale.sourceCurrent).toBe(false);
    await expect(
      transaction(fixture, (tx) =>
        applyHostedVersionBuilderPage(tx, {
          inputId: staleCapture.value.inputId,
          fromFrontier: staleCapture.value.frontier,
          result: stale,
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale-source' } satisfies Partial<HostedVersionBuilderError>);

    const state = await fixture.native.pool.query<{ frontier_segment: string }>(
      `SELECT frontier_segment FROM content.hosted_version_builder
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, staleCapture.value.inputId],
    );
    expect(state.rows[0]?.frontier_segment).toBe('base');
  } finally {
    await fixture.close();
  }
});
