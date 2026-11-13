import { expect, setDefaultTimeout, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import {
  captureHostedMigrationInput,
  advanceHostedMigrationInput,
  releaseHostedMigrationInput,
} from '../../src/content/hosted-migration-input.ts';
import { HostedMigrationInputIncompleteError } from '../../src/content/hosted-migration-input-model.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountDeletionRuntime, deletePersona } from '../support/account-deletion.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import markAuthorErased from '../../src/content/account-erasure-authored-mark.sql';
import disposeItem from '../../src/content/account-erasure-authored-item.sql';
import { redactHostedLifecyclePlacements } from '../../src/content/hosted-append-lifecycle.ts';

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
) {
  return (
    await fixture.native.command('/v1/hostedCatalogues', {
      postId: fixture.catalogueId,
      threadId: fixture.threadId,
      placements,
    })
  ).revisionId as string;
}

async function referenceCount(fixture: Awaited<ReturnType<typeof hostedChaptersFixture>>, inputId: string) {
  const result = await fixture.native.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM content.hosted_migration_input_reference
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
    [routeOf(fixture.catalogueId), fixture.catalogueId, inputId],
  );
  return Number(result.rows[0]!.count);
}

test('captures a legacy snapshot, replays its committed interval, and never follows a later append', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const targetThread = await fixture.native.thread();
    const target = fixture.target(targetThread);
    const part = fixture.newOccurrenceId();
    const nested = fixture.newOccurrenceId();
    const final = fixture.newOccurrenceId();
    const base = await createStructure(fixture, [
      { occurrenceId: part, parentId: null, position: 0, title: 'Part', kind: 'part' },
      { occurrenceId: nested, parentId: part, position: 0, title: 'Nested', kind: 'chapter', target },
      { occurrenceId: final, parentId: null, position: 1, title: 'Final', kind: 'chapter', target },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );
    expect(captured.value.source).toMatchObject({
      revisionId: base,
      kind: 'snapshot',
      baseRevisionId: base,
      basePlacementCount: '3',
      expectedPlacementCount: '3',
      highWater: '-1',
    });
    expect(await referenceCount(fixture, captured.value.inputId)).toBe(1);

    const firstKey = context();
    const first = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      captured.value.inputId,
      { frontier: captured.value.frontier, limit: 2 },
      firstKey,
    );
    expect(first.items.map((item) => item.occurrenceId)).toEqual([part, nested]);
    expect(first.items[0]).toMatchObject({ address: { segment: 'base', ordinal: 0 }, parentId: null });
    expect(first.items[1]).toMatchObject({ address: { segment: 'base', ordinal: 1 }, parentId: part, target });
    expect(first.coverage).toEqual({ visited: '2', expected: '3', complete: false });

    const appendedId = fixture.newOccurrenceId();
    const appended = await appendHostedRootChapter(
      deps,
      actor,
      fixture.catalogueId,
      {
        expectedRevisionId: base,
        occurrenceId: appendedId,
        title: 'After capture',
        target,
      },
      context(),
    );
    expect(appended.value.revisionId).not.toBe(base);

    const replay = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      captured.value.inputId,
      { frontier: captured.value.frontier, limit: 2 },
      firstKey,
    );
    expect(replay.items).toEqual(first.items);
    expect(replay.frontier).toEqual(first.frontier);
    expect(replay.coverage.visited).toBe('2');
    expect(replay.sourceCurrent).toBe(false);

    const last = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      captured.value.inputId,
      { frontier: first.frontier, limit: 2 },
      context(),
    );
    expect(last.items.map((item) => item.occurrenceId)).toEqual([final]);
    expect(last.coverage).toEqual({ visited: '3', expected: '3', complete: true });
    expect(last.items.some((item) => item.occurrenceId === appendedId)).toBe(false);

    await expect(
      captureHostedMigrationInput(
        deps,
        actor,
        { catalogueId: fixture.catalogueId, expectedRevisionId: base },
        context(),
      ),
    ).rejects.toThrow('Revision precondition failed');
    const consumed = await releaseHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      captured.value.inputId,
      { disposition: 'consumed' },
      context(),
    );
    expect(consumed.value).toMatchObject({ status: 'consumed', coverage: { complete: true } });
    expect(await referenceCount(fixture, captured.value.inputId)).toBe(0);
  } finally {
    await fixture.close();
  }
});

test('proves an empty source complete and distinct from an unvisited input', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const base = await createStructure(fixture, []);
    const captured = await captureHostedMigrationInput(
      dependencies(fixture),
      fixture.native.author.actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );
    await expect(
      releaseHostedMigrationInput(
        dependencies(fixture),
        fixture.native.author.actor,
        fixture.catalogueId,
        captured.value.inputId,
        { disposition: 'consumed' },
        context(),
      ),
    ).rejects.toBeInstanceOf(HostedMigrationInputIncompleteError);
    const empty = await advanceHostedMigrationInput(
      dependencies(fixture),
      fixture.native.author.actor,
      fixture.catalogueId,
      captured.value.inputId,
      { frontier: captured.value.frontier },
      context(),
    );
    expect(empty.items).toEqual([]);
    expect(empty.status).toBe('complete');
    expect(empty.coverage).toEqual({ visited: '0', expected: '0', complete: true });
    const beforePage = await fixture.native.pool.query<{ state: string; coverage_complete: boolean }>(
      `SELECT state,coverage_complete FROM content.hosted_migration_input
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, captured.value.inputId],
    );
    expect(beforePage.rows[0]).toEqual({ state: 'complete', coverage_complete: true });
  } finally {
    await fixture.close();
  }
});

test('unavailable exact targets consume their raw slot without disclosing copied titles', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const targetResponse = await fixture.native.call(
      'POST',
      '/v1/threads',
      {
        title: 'Other author target',
        body: fromPlainText('Initial target revision'),
        licence: 'MIT',
        subjectIds: [],
        boardId: fixture.native.board.id,
        visibility: 'published',
      },
      { other: true },
    );
    expect(targetResponse.status).toBe(201);
    const targetThread = targetResponse.value.thread as { id: string; firstPost: { id: string; revisionId: string } };
    const target = fixture.target(targetThread as never);
    const revisedTarget = await fixture.native.revise(targetThread.firstPost as never, {}, { other: true });
    expect(revisedTarget.status).toBe(200);

    const occurrenceId = fixture.newOccurrenceId();
    const base = await createStructure(fixture, [
      { occurrenceId, parentId: null, position: 0, title: 'Do not copy after target erasure', kind: 'chapter', target },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const captured = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );

    const other = fixture.native.system.actors.other;
    const runtime = accountDeletionRuntime(fixture.native.system);
    await deletePersona(
      { version: 1, pool: fixture.native.pool, auth: runtime.auth },
      { accountId: other.actor.accountId, bearer: other.bearer },
    );
    await markAuthorErased.run(fixture.native.pool, {
      route: routeOf(target.postId),
      account_id: other.actor.accountId,
      item_kind: 'post',
      item_id: target.postId,
    });
    await disposeItem.run(fixture.native.pool, {
      route: routeOf(target.postId),
      account_id: other.actor.accountId,
      item_kind: 'post',
      item_id: target.postId,
      after_at: '-infinity',
      after_revision: '00000000-0000-0000-0000-000000000000',
      revision_limit: 100,
    });

    const page = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      captured.value.inputId,
      { frontier: captured.value.frontier, limit: 1 },
      context(),
    );
    expect(page.coverage).toEqual({ visited: '1', expected: '1', complete: true });
    expect(page.items).toEqual([
      expect.objectContaining({
        address: { segment: 'base', revisionId: base, ordinal: 0 },
        occurrenceId,
        availability: 'unavailable',
        kind: 'chapter',
      }),
    ]);
    expect(page.items[0]).not.toHaveProperty('title');
    expect(page.items[0]).not.toHaveProperty('target');
  } finally {
    await fixture.close();
  }
});

test('traverses a sealed prefix beyond 512 in bounded pages and excludes later offsets', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const targetThread = await fixture.native.thread();
    const target = fixture.target(targetThread);
    const placements = Array.from({ length: 512 }, (_, position) => ({
      occurrenceId: fixture.newOccurrenceId(),
      parentId: null,
      position,
      title: `Part ${position}`,
      kind: 'part',
    }));
    let head = await createStructure(fixture, placements);
    const baseIds = placements.map((item) => item.occurrenceId);
    const prefixIds: string[] = [];
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    for (let offset = 0; offset < 4; offset++) {
      const occurrenceId = fixture.newOccurrenceId();
      const appended = await appendHostedRootChapter(
        deps,
        actor,
        fixture.catalogueId,
        {
          expectedRevisionId: head,
          occurrenceId,
          title: `Prefix ${offset}`,
          target,
        },
        context(),
      );
      head = appended.value.revisionId;
      prefixIds.push(occurrenceId);
    }
    const captured = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: head },
      context(),
    );
    expect(captured.value.source).toMatchObject({ kind: 'prefix', highWater: '3', expectedPlacementCount: '516' });

    const laterId = fixture.newOccurrenceId();
    await appendHostedRootChapter(
      deps,
      actor,
      fixture.catalogueId,
      {
        expectedRevisionId: head,
        occurrenceId: laterId,
        title: 'Later offset',
        target,
      },
      context(),
    );

    let frontier = captured.value.frontier;
    let visited = 0;
    const received: string[] = [];
    let pageNumber = 0;
    while (true) {
      const key = context();
      const page = await advanceHostedMigrationInput(
        deps,
        actor,
        fixture.catalogueId,
        captured.value.inputId,
        { frontier, limit: 100 },
        key,
      );
      expect(page.items.length).toBeLessThanOrEqual(100);
      expect(page.sourceCurrent).toBe(false);
      received.push(...page.items.map((item) => item.occurrenceId));
      visited += page.items.length;
      if (pageNumber === 2) {
        const replay = await advanceHostedMigrationInput(
          deps,
          actor,
          fixture.catalogueId,
          captured.value.inputId,
          { frontier, limit: 100 },
          key,
        );
        expect(replay.items).toEqual(page.items);
        expect(replay.coverage.visited).toBe(page.coverage.visited);
      }
      frontier = page.frontier;
      pageNumber++;
      if (page.coverage.complete) break;
      expect(pageNumber).toBeLessThan(10);
    }
    expect(visited).toBe(516);
    expect(received).toEqual([...baseIds, ...prefixIds]);
    expect(received).not.toContain(laterId);
    const finalEntries = await fixture.native.pool.query<{ occurrence_id: string; ordinal: number }>(
      `SELECT a.occurrence_id,($3::bigint+a.append_offset)::integer AS ordinal
       FROM content.hosted_append a
       WHERE a.route=$1 AND a.catalogue_id=$2 AND a.stream_id=$4 AND a.append_offset<=$5::bigint
       ORDER BY a.append_offset`,
      [
        routeOf(fixture.catalogueId),
        fixture.catalogueId,
        captured.value.source.basePlacementCount,
        captured.value.source.baseRevisionId,
        captured.value.source.highWater,
      ],
    );
    expect(finalEntries.rows.map((row) => row.occurrence_id)).toEqual(prefixIds);
    expect(finalEntries.rows.map((row) => row.ordinal)).toEqual([512, 513, 514, 515]);
  } finally {
    await fixture.close();
  }
});

test('cancellation and expiry release only their hold and preserve source rows', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const occurrenceId = fixture.newOccurrenceId();
    const base = await createStructure(fixture, [
      { occurrenceId, parentId: null, position: 0, title: 'Retained part', kind: 'part' },
    ]);
    const deps = dependencies(fixture);
    const actor = fixture.native.author.actor;
    const cancelled = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );
    const cancelledResult = await releaseHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      cancelled.value.inputId,
      { disposition: 'cancelled' },
      context(),
    );
    expect(cancelledResult.value.status).toBe('cancelled');
    expect(await referenceCount(fixture, cancelled.value.inputId)).toBe(0);

    const expired = await captureHostedMigrationInput(
      deps,
      actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );
    await fixture.native.pool.query(
      `UPDATE content.hosted_migration_input SET created_at=transaction_timestamp()-interval '2 days',
         expires_at=transaction_timestamp()-interval '1 day'
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, expired.value.inputId],
    );
    const expiredResult = await advanceHostedMigrationInput(
      deps,
      actor,
      fixture.catalogueId,
      expired.value.inputId,
      { frontier: expired.value.frontier },
      context(),
    );
    expect(expiredResult).toMatchObject({ status: 'expired', items: [], coverage: { visited: '0', complete: false } });
    expect(await referenceCount(fixture, expired.value.inputId)).toBe(0);
    const source = await fixture.native.pool.query<{ occurrence_id: string; title: string | null }>(
      `SELECT occurrence_id,title FROM content.hosted_placement
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, base],
    );
    expect(source.rows).toEqual([{ occurrence_id: occurrenceId, title: 'Retained part' }]);
  } finally {
    await fixture.close();
  }
});

test('native source erasure overrides an active hold and retains no title payload', async () => {
  const fixture = await hostedChaptersFixture();
  try {
    const occurrenceId = fixture.newOccurrenceId();
    const base = await createStructure(fixture, [
      { occurrenceId, parentId: null, position: 0, title: 'Private source title', kind: 'part' },
    ]);
    const captured = await captureHostedMigrationInput(
      dependencies(fixture),
      fixture.native.author.actor,
      { catalogueId: fixture.catalogueId, expectedRevisionId: base },
      context(),
    );
    expect(await referenceCount(fixture, captured.value.inputId)).toBe(1);

    const runtime = accountDeletionRuntime(fixture.native.system);
    await deletePersona(
      { version: 1, pool: fixture.native.pool, auth: runtime.auth },
      { accountId: fixture.native.author.actor.accountId, bearer: fixture.native.author.bearer },
    );
    await markAuthorErased.run(fixture.native.pool, {
      route: routeOf(fixture.catalogueId),
      account_id: fixture.native.author.actor.accountId,
      item_kind: 'post',
      item_id: fixture.catalogueId,
    });
    const erasedInput = await fixture.native.pool.query<{ state: string; coverage_complete: boolean }>(
      `SELECT state,coverage_complete FROM content.hosted_migration_input
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, captured.value.inputId],
    );
    expect(erasedInput.rows[0]).toEqual({ state: 'source_erased', coverage_complete: false });
    expect(await referenceCount(fixture, captured.value.inputId)).toBe(0);

    await disposeItem.run(fixture.native.pool, {
      route: routeOf(fixture.catalogueId),
      account_id: fixture.native.author.actor.accountId,
      item_kind: 'post',
      item_id: fixture.catalogueId,
      after_at: '-infinity',
      after_revision: '00000000-0000-0000-0000-000000000000',
      revision_limit: 100,
    });
    await redactHostedLifecyclePlacements(
      fixture.native.pool,
      { catalogueId: fixture.catalogueId, authorAccountId: fixture.native.author.actor.accountId },
      { revisionId: base, afterOccurrence: null },
      { deadline: Date.now() + 120_000, idempotencyKey: crypto.randomUUID() },
    );
    const rows = await fixture.native.pool.query<{ title: string | null; title_redacted: boolean }>(
      `SELECT title,title_redacted FROM content.hosted_placement
       WHERE route=$1 AND catalogue_id=$2 AND revision_id=$3 AND occurrence_id=$4`,
      [routeOf(fixture.catalogueId), fixture.catalogueId, base, occurrenceId],
    );
    expect(rows.rows[0]).toEqual({ title: null, title_redacted: true });
    const columns = await fixture.native.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='content' AND table_name='hosted_migration_input'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('title');
  } finally {
    await fixture.close();
  }
});
