import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import type { HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import {
  captureHostedPublicBaselineInput,
  readHostedPublicBaselineInputPage,
} from '../../src/content/hosted-public-baseline-input.ts';
import {
  HostedPublicBaselineInputIncompleteError,
  HostedPublicBaselineInputUnavailableError,
} from '../../src/content/hosted-public-baseline-input-model.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(360_000);
const context = () => ({
  deadline: Date.now() + 120_000,
  idempotencyKey: crypto.randomUUID(),
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

async function publish(
  fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>,
  placements: readonly Record<string, unknown>[],
) {
  const path = `/v1/hostedCatalogues/${fixture.catalogueId}`;
  const created = await fixture.native.command('/v1/hostedCatalogues', {
    postId: fixture.catalogueId,
    threadId: fixture.threadId,
    placements,
  });
  const released = await fixture.native.command(
    `${path}:publish`,
    {
      expectedRevisionId: created.revisionId,
      expectedPublicationId: null,
      occurrenceIds: placements.map((placement) => placement.occurrenceId),
    },
    200,
  );
  return { headId: created.revisionId as string, publicationId: released.revisionId as string };
}

test('captures the old public manifest after a newer private draft edit', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const targetThread = await fixture.native.thread('published');
    const target = fixture.target(targetThread);
    const partId = fixture.newOccurrenceId();
    const chapterId = fixture.newOccurrenceId();
    const original = await publish(fixture, [
      { occurrenceId: partId, parentId: null, position: 0, title: 'Released section', kind: 'part' },
      { occurrenceId: chapterId, parentId: partId, position: 0, title: 'Released chapter', kind: 'chapter', target },
    ]);
    const laterId = fixture.newOccurrenceId();
    const revised = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:revise`,
      {
        expectedRevisionId: original.headId,
        placements: [
          { occurrenceId: partId, parentId: null, position: 0, title: 'Draft section', kind: 'part' },
          { occurrenceId: chapterId, parentId: partId, position: 0, title: 'Draft chapter', kind: 'chapter', target },
          { occurrenceId: laterId, parentId: null, position: 1, title: 'Never copy this', kind: 'part' },
        ],
      },
      200,
    );
    expect(revised.revisionId).not.toBe(original.headId);

    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
      context(),
    );
    expect(captured.value.source).toMatchObject({
      catalogueId: fixture.catalogueId,
      threadId: fixture.threadId,
      publicationId: original.publicationId,
      expectedPlacementCount: 2,
    });

    const page = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: captured.value.frontier, limit: 10 },
      context(),
    );
    expect(page.items).toEqual([
      expect.objectContaining({
        publicationId: original.publicationId,
        occurrenceId: partId,
        parentId: null,
        position: 0,
        ordinal: 0,
        availability: 'available',
        kind: 'part',
        title: 'Released section',
      }),
      expect.objectContaining({
        publicationId: original.publicationId,
        occurrenceId: chapterId,
        parentId: partId,
        position: 0,
        ordinal: 1,
        availability: 'available',
        kind: 'chapter',
        title: 'Released chapter',
        target,
      }),
    ]);
    expect(page.items.map((item) => item.occurrenceId)).not.toContain(laterId);
    expect(page.sourceCurrent).toBe(true);
    expect(page.coverage).toEqual({ visited: 2, expected: 2, complete: true });
  } finally {
    await fixture.close();
  }
});

test('pages exact preorder rows and advances raw coverage across unavailable targets', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const targetThread = await fixture.native.thread('published');
    const target = fixture.target(targetThread);
    const privateThreadResponse = await fixture.native.call(
      'POST',
      '/v1/threads',
      {
        title: 'Private target',
        body: fromPlainText('Private target body'),
        licence: 'MIT',
        subjectIds: [],
        boardId: fixture.native.board.id,
        visibility: 'protected',
      },
      { other: true },
    );
    expect(privateThreadResponse.status).toBe(201);
    const unavailableTarget = fixture.target(privateThreadResponse.value.thread as never);
    const ids = Array.from({ length: 5 }, () => fixture.newOccurrenceId());
    const release = await publish(
      fixture,
      ids.map((occurrenceId, position) => ({
        occurrenceId,
        parentId: null,
        position,
        title: `Released ${position}`,
        kind: 'chapter',
        target: position === 2 ? unavailableTarget : target,
      })),
    );
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: release.publicationId },
      context(),
    );

    const first = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: captured.value.frontier, limit: 2 },
      context(),
    );
    expect(first.items.map((item) => item.ordinal)).toEqual([0, 1]);
    expect(first.frontier).toEqual({ afterOrdinal: 1 });
    expect(first.coverage).toEqual({ visited: 2, expected: 5, complete: false });

    const second = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: first.frontier, limit: 2 },
      context(),
    );
    expect(second.items).toEqual([
      expect.objectContaining({
        publicationId: release.publicationId,
        occurrenceId: ids[2],
        ordinal: 2,
        availability: 'unavailable',
      }),
      expect.objectContaining({
        publicationId: release.publicationId,
        occurrenceId: ids[3],
        ordinal: 3,
        availability: 'available',
      }),
    ]);
    expect(second.items[0]).not.toHaveProperty('title');
    expect(second.items[0]).not.toHaveProperty('target');
    expect(second.coverage).toEqual({ visited: 4, expected: 5, complete: false });

    const last = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: second.frontier, limit: 2 },
      context(),
    );
    expect(last.items.map((item) => item.occurrenceId)).toEqual([ids[4]!]);
    expect(last.coverage).toEqual({ visited: 5, expected: 5, complete: true });
  } finally {
    await fixture.close();
  }
});

test('keeps a stale release identity after another publication becomes active', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const firstId = fixture.newOccurrenceId();
    const secondId = fixture.newOccurrenceId();
    const original = await publish(fixture, [
      { occurrenceId: firstId, parentId: null, position: 0, title: 'Release A', kind: 'part' },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
      context(),
    );
    const next = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:revise`,
      {
        expectedRevisionId: original.headId,
        placements: [{ occurrenceId: secondId, parentId: null, position: 0, title: 'Release B', kind: 'part' }],
      },
      200,
    );
    const replacement = await fixture.native.command(
      `/v1/hostedCatalogues/${fixture.catalogueId}:publish`,
      {
        expectedRevisionId: next.revisionId,
        expectedPublicationId: original.publicationId,
        occurrenceIds: [secondId],
      },
      200,
    );

    const stale = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: captured.value.frontier, limit: 10 },
      context(),
    );
    expect(stale.source.publicationId).toBe(original.publicationId);
    expect(stale.sourceCurrent).toBe(false);
    expect(stale.items.map((item) => item.occurrenceId)).toEqual([firstId]);
    expect(stale.items[0]).toMatchObject({ publicationId: original.publicationId, title: 'Release A' });
    expect(stale.items.map((item) => item.occurrenceId)).not.toContain(secondId);

    await expect(
      captureHostedPublicBaselineInput(
        deps,
        actor,
        { catalogueId: fixture.catalogueId, expectedPublicationId: original.publicationId },
        context(),
      ),
    ).rejects.toThrow('Revision precondition failed');
    expect(replacement.revisionId).not.toBe(original.publicationId);
  } finally {
    await fixture.close();
  }
});

test('distinguishes an empty public release from missing or incomplete input', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const release = await publish(fixture, []);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedPublicBaselineInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedPublicationId: release.publicationId },
      context(),
    );
    const empty = await readHostedPublicBaselineInputPage(
      deps,
      actor,
      captured.value.source,
      { frontier: captured.value.frontier },
      context(),
    );
    expect(empty.items).toEqual([]);
    expect(empty.coverage).toEqual({ visited: 0, expected: 0, complete: true });

    await expect(
      readHostedPublicBaselineInputPage(
        deps,
        actor,
        { ...captured.value.source, publicationId: fixture.newOccurrenceId() },
        { frontier: captured.value.frontier },
        context(),
      ),
    ).rejects.toBeInstanceOf(HostedPublicBaselineInputUnavailableError);
    await expect(
      readHostedPublicBaselineInputPage(
        deps,
        actor,
        { ...captured.value.source, expectedPlacementCount: 1 },
        { frontier: captured.value.frontier },
        context(),
      ),
    ).rejects.toBeInstanceOf(HostedPublicBaselineInputIncompleteError);
  } finally {
    await fixture.close();
  }
});
