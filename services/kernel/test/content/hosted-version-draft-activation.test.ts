import { expect, setDefaultTimeout, test } from 'bun:test';
import {
  appendHostedRootChapter,
  insertHostedDraftPoint,
  type HostedCommandDependencies,
} from '../../src/content/hosted-chapters-commands.ts';
import {
  advanceHostedMigrationInput,
  captureHostedMigrationInput,
  releaseHostedMigrationInput,
} from '../../src/content/hosted-migration-input.ts';
import {
  applyHostedVersionBuilderPage,
  beginHostedVersionBuilder,
  sealHostedVersionBuilder,
} from '../../src/content/hosted-version-builder.ts';
import {
  applyHostedVersionDraftActivationPage,
  beginHostedVersionDraftActivation,
  commitHostedVersionDraftActivation,
  HostedVersionDraftActivationError,
  readHostedVersionDraftActivation,
} from '../../src/content/hosted-version-draft-activation.ts';
import type { HostedVersionDraftActivationValue } from '../../src/content/hosted-version-draft-activation-model.ts';
import { resolveHostedVersionRevision } from '../../src/content/hosted-version-revision.ts';
import { readHostedVersionOccurrence, readHostedVersionSnapshot } from '../../src/content/hosted-version-store.ts';
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
  catalogue = { postId: fixture.catalogueId, threadId: fixture.threadId },
): Promise<string> {
  return (
    await fixture.native.command('/v1/hostedCatalogues', {
      postId: catalogue.postId,
      threadId: catalogue.threadId,
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

async function pointers(fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>, catalogueId = fixture.catalogueId) {
  return (
    await fixture.native.pool.query<{ head_revision_id: string; publication_id: string | null }>(
      `SELECT head_revision_id,publication_id FROM content.hosted_catalogue
       WHERE route=$1 AND catalogue_id=$2`,
      [routeOf(catalogueId), catalogueId],
    )
  ).rows[0]!;
}

async function sealBuilder(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  sourceRevisionId: string,
  catalogueId = fixture.catalogueId,
) {
  const deps = dependencies(fixture);
  const captured = await captureHostedMigrationInput(
    deps,
    fixture.native.author.actor,
    { catalogueId, expectedRevisionId: sourceRevisionId },
    context(),
  );
  await transaction(fixture, (tx) => beginHostedVersionBuilder(tx, captured.value));
  let fromFrontier = captured.value.frontier;
  type BuilderPage = Parameters<typeof applyHostedVersionBuilderPage>[1];
  let finalPage: BuilderPage | null = null;
  while (finalPage === null) {
    const result = await advanceHostedMigrationInput(
      deps,
      fixture.native.author.actor,
      catalogueId,
      captured.value.inputId,
      { frontier: fromFrontier, limit: 20 },
      context(),
    );
    const page = { inputId: captured.value.inputId, fromFrontier, result };
    await transaction(fixture, (tx) => applyHostedVersionBuilderPage(tx, page));
    fromFrontier = result.frontier;
    if (result.coverage.complete) finalPage = page;
  }
  if (finalPage === null) throw new Error('Hosted version source did not reach complete coverage');
  await transaction(fixture, (tx) => sealHostedVersionBuilder(tx, finalPage!));
  return captured.value;
}

async function activatePages(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  inputId: string,
  replayFirst = false,
  catalogueId = fixture.catalogueId,
) {
  let replayed = false;
  for (;;) {
    const state = await transaction(fixture, (tx) => readHostedVersionDraftActivation(tx, catalogueId, inputId));
    if (state.status === 'complete' || state.status === 'activated') return { state, replayed };
    const from = state.cursor;
    const applied = await transaction(fixture, (tx) =>
      applyHostedVersionDraftActivationPage(tx, catalogueId, inputId, from),
    );
    expect(applied.replayed).toBe(false);
    expect(applied.work.occurrencesWritten).toBeLessThanOrEqual(20);
    expect(applied.work.nodesWritten).toBeLessThanOrEqual(20);
    expect(applied.work.siblingRootsWritten).toBeLessThanOrEqual(20);
    if (applied.state.status === 'materializing') {
      expect(
        applied.work.occurrencesWritten + applied.work.nodesWritten + applied.work.siblingRootsWritten,
      ).toBeGreaterThan(0);
    }
    if (replayFirst && !replayed) {
      const replay = await transaction(fixture, (tx) =>
        applyHostedVersionDraftActivationPage(tx, catalogueId, inputId, from),
      );
      expect(replay.replayed).toBe(true);
      expect(replay.work.occurrencesWritten).toBe(0);
      replayed = true;
    }
  }
}

test('activates a 513-entry sealed builder and accepts the first ordered point write', async () => {
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
    const captured = await sealBuilder(fixture, sourceRevisionId);
    const before = await pointers(fixture);
    expect(before.head_revision_id).toBe(sourceRevisionId);
    expect(before.publication_id).toBeNull();

    const begun = await transaction(fixture, (tx) =>
      beginHostedVersionDraftActivation(tx, fixture.catalogueId, captured.inputId),
    );
    expect(begun.status).toBe('materializing');
    expect(begun.placementCount).toBe(513n);
    const pages = await activatePages(fixture, captured.inputId, true);
    expect(pages.replayed).toBe(true);
    expect(pages.state.status).toBe('complete');
    expect(pages.state.coverageComplete).toBe(true);

    const committed = await transaction(fixture, (tx) =>
      commitHostedVersionDraftActivation(tx, fixture.catalogueId, captured.inputId, {
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
      }),
    );
    expect(committed.replayed).toBe(false);
    expect(committed.snapshot.placementCount).toBe(513n);
    expect(committed.snapshot.chapterCount).toBe(513n);
    expect(committed.snapshot.generationKind).toBe('draft');
    const replayedCommit = await transaction(fixture, (tx) =>
      commitHostedVersionDraftActivation(tx, fixture.catalogueId, captured.inputId, {
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
      }),
    );
    expect(replayedCommit.replayed).toBe(true);
    expect(replayedCommit.revisionId).toBe(committed.revisionId);

    const after = await pointers(fixture);
    expect(after.head_revision_id).toBe(committed.revisionId);
    expect(after.publication_id).toBeNull();
    expect(after.head_revision_id).not.toBe(sourceRevisionId);

    const mapped = await resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, committed.revisionId);
    expect(mapped.kind).toBe('ordered');
    const legacy = await resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, sourceRevisionId);
    expect(legacy.kind).toBe('compatibility');
    const oldChildren = await fixture.native.call(
      'GET',
      `/v1/hostedCatalogues/${fixture.catalogueId}/children?kind=structure&revisionId=${sourceRevisionId}`,
    );
    expect(oldChildren.status).toBe(200);
    expect((oldChildren.value.items as { occurrenceId: string }[]).length).toBeGreaterThan(0);

    const inserted = await insertHostedDraftPoint(
      dependencies(fixture),
      fixture.native.author.actor,
      fixture.catalogueId,
      {
        expectedRevisionId: committed.revisionId,
        occurrenceId: fixture.newOccurrenceId(),
        parentId: null,
        beforeOccurrenceId: null,
        title: 'First ordered chapter',
        placement: { kind: 'chapter', target },
      },
      context(),
    );
    expect(inserted.value.revisionId).not.toBe(committed.revisionId);
    const next = await resolveHostedVersionRevision(
      fixture.native.pool,
      fixture.catalogueId,
      inserted.value.revisionId,
    );
    expect(next.kind).toBe('ordered');
    if (next.kind === 'ordered') {
      expect(next.snapshot.generationId).toBe(committed.snapshot.generationId);
      expect(next.snapshot.sequence).toBe(committed.snapshot.sequence + 1n);
    }
    expect((await pointers(fixture)).publication_id).toBeNull();
  } finally {
    await fixture.close();
  }
});

test('keeps subtree counts, withholds redacted titles, and inserts under the ordered successor', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread());
    const partId = fixture.newOccurrenceId();
    const childA = fixture.newOccurrenceId();
    const childB = fixture.newOccurrenceId();
    const secret = 'Secret redacted title';
    const baseRevisionId = await createStructure(fixture, [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Part', kind: 'part' },
      { occurrenceId: childA, parentId: partId, position: 0, title: secret, kind: 'chapter', target },
      { occurrenceId: childB, parentId: partId, position: 1, title: 'Visible', kind: 'chapter', target },
    ]);
    const captured = await sealBuilder(fixture, baseRevisionId);
    await fixture.native.pool.query(
      `UPDATE content.hosted_version_builder_point SET title=NULL
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND occurrence_id=$4`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, captured.inputId, childA],
    );
    await transaction(fixture, (tx) => beginHostedVersionDraftActivation(tx, fixture.catalogueId, captured.inputId));
    await activatePages(fixture, captured.inputId);
    const committed = await transaction(fixture, (tx) =>
      commitHostedVersionDraftActivation(tx, fixture.catalogueId, captured.inputId, {
        recordedTransactionId: crypto.randomUUID(),
        recordedAt: new Date().toISOString(),
      }),
    );
    const part = await readHostedVersionOccurrence<HostedVersionDraftActivationValue>(
      fixture.native.pool,
      committed.snapshot,
      partId,
    );
    expect(part).toMatchObject({ parentOccurrenceId: null, subtreeSize: 3n });
    expect(part?.value).toMatchObject({ kind: 'part', title: 'Part', subtreeHeight: 1, chapterCount: 2n });
    const hidden = await readHostedVersionOccurrence<HostedVersionDraftActivationValue>(
      fixture.native.pool,
      committed.snapshot,
      childA,
    );
    expect(hidden?.value.title).toBeNull();
    expect(JSON.stringify(hidden?.value)).not.toContain(secret);
    expect(hidden?.value.target).toMatchObject(target);

    const nested = await insertHostedDraftPoint(
      dependencies(fixture),
      fixture.native.author.actor,
      fixture.catalogueId,
      {
        expectedRevisionId: committed.revisionId,
        occurrenceId: fixture.newOccurrenceId(),
        parentId: partId,
        beforeOccurrenceId: null,
        title: 'Nested ordered chapter',
        placement: { kind: 'chapter', target },
      },
      context(),
    );
    const afterInsert = await resolveHostedVersionRevision(
      fixture.native.pool,
      fixture.catalogueId,
      nested.value.revisionId,
    );
    expect(afterInsert.kind).toBe('ordered');
    if (afterInsert.kind === 'ordered') {
      const snapshot = await readHostedVersionSnapshot(
        fixture.native.pool,
        fixture.catalogueId,
        afterInsert.snapshot.generationId,
        afterInsert.snapshot.sequence,
      );
      const updated = await readHostedVersionOccurrence<HostedVersionDraftActivationValue>(
        fixture.native.pool,
        snapshot!,
        partId,
      );
      expect(updated?.subtreeSize).toBe(4n);
      expect(updated?.value.chapterCount).toBe(3n);
    }
    expect((await pointers(fixture)).publication_id).toBeNull();
  } finally {
    await fixture.close();
  }
});

test('refuses stale CAS, cancelled source and empty activation without moving the live head', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const target = fixture.target(await fixture.native.thread());
    const staleRevisionId = await createStructure(fixture, [
      { occurrenceId: fixture.newOccurrenceId(), parentId: null, position: 0, title: 'Stale', kind: 'chapter', target },
    ]);
    const staleCapture = await sealBuilder(fixture, staleRevisionId);
    await transaction(fixture, (tx) =>
      beginHostedVersionDraftActivation(tx, fixture.catalogueId, staleCapture.inputId),
    );
    await activatePages(fixture, staleCapture.inputId);
    await appendHostedRootChapter(
      dependencies(fixture),
      fixture.native.author.actor,
      fixture.catalogueId,
      {
        expectedRevisionId: staleRevisionId,
        occurrenceId: fixture.newOccurrenceId(),
        title: 'Racing append',
        target,
      },
      context(),
    );
    const staleHead = (await pointers(fixture)).head_revision_id;
    expect(staleHead).not.toBe(staleRevisionId);
    await expect(
      transaction(fixture, (tx) =>
        commitHostedVersionDraftActivation(tx, fixture.catalogueId, staleCapture.inputId, {
          recordedTransactionId: crypto.randomUUID(),
          recordedAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'stale-source' } satisfies Partial<HostedVersionDraftActivationError>);
    expect((await pointers(fixture)).head_revision_id).toBe(staleHead);
    expect((await pointers(fixture)).publication_id).toBeNull();
    const unmapped = await resolveHostedVersionRevision(fixture.native.pool, fixture.catalogueId, staleHead);
    expect(unmapped.kind).toBe('compatibility');

    const cancelledThread = await fixture.native.thread();
    const cancelledPlacements = [
      {
        occurrenceId: fixture.newOccurrenceIdFor(cancelledThread.firstPost.id),
        parentId: null,
        position: 0,
        title: 'Cancel',
        kind: 'part' as const,
      },
    ];
    const cancelledRevisionId = await createStructure(fixture, cancelledPlacements, {
      postId: cancelledThread.firstPost.id,
      threadId: cancelledThread.id,
    });
    const cancelled = await sealBuilder(fixture, cancelledRevisionId, cancelledThread.firstPost.id);
    await transaction(fixture, (tx) =>
      beginHostedVersionDraftActivation(tx, cancelledThread.firstPost.id, cancelled.inputId),
    );
    await releaseHostedMigrationInput(
      dependencies(fixture),
      fixture.native.author.actor,
      cancelledThread.firstPost.id,
      cancelled.inputId,
      { disposition: 'cancelled' },
      context(),
    );
    await expect(
      transaction(fixture, (tx) =>
        applyHostedVersionDraftActivationPage(tx, cancelledThread.firstPost.id, cancelled.inputId),
      ),
    ).rejects.toMatchObject({ code: 'unavailable-source' } satisfies Partial<HostedVersionDraftActivationError>);
    expect((await pointers(fixture, cancelledThread.firstPost.id)).head_revision_id).toBe(cancelledRevisionId);

    const emptyThread = await fixture.native.thread();
    const emptyRevisionId = await createStructure(fixture, [], {
      postId: emptyThread.firstPost.id,
      threadId: emptyThread.id,
    });
    const empty = await sealBuilder(fixture, emptyRevisionId, emptyThread.firstPost.id);
    await expect(
      transaction(fixture, (tx) => beginHostedVersionDraftActivation(tx, emptyThread.firstPost.id, empty.inputId)),
    ).rejects.toMatchObject({ code: 'empty-source' } satisfies Partial<HostedVersionDraftActivationError>);
    expect((await pointers(fixture, emptyThread.firstPost.id)).head_revision_id).toBe(emptyRevisionId);
    expect((await pointers(fixture, emptyThread.firstPost.id)).publication_id).toBeNull();
  } finally {
    await fixture.close();
  }
});
