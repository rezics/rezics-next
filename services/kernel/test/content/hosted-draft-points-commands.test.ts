import { expect, setDefaultTimeout, spyOn, test } from 'bun:test';
import {
  insertHostedDraftPoint,
  removeHostedDraftPoint,
  type HostedCommandDependencies,
} from '../../src/content/hosted-chapters-commands.ts';
import { RevisionPreconditionError } from '../../src/content/commands.ts';
import {
  InvalidHostedStructureError,
  type HostedDraftPointInsertInput,
} from '../../src/content/hosted-chapters-model.ts';
import * as reads from '../../src/content/reads.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

test('native draft point writes replay receipts, reject stale heads, and preserve historical snapshots', async () => {
  const f = await hostedChaptersFixture();
  try {
    const created = await f.native.command('/v1/hostedCatalogues', {
      postId: f.catalogueId,
      threadId: f.threadId,
      placements: [],
    });
    const path = `/v1/hostedCatalogues/${f.catalogueId}`;
    const source = await f.native.thread();
    const target = f.target(source);
    const dependencies: HostedCommandDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    const context = () => ({
      idempotencyKey: crypto.randomUUID(),
      deadline: Date.now() + 120_000,
      requestId: crypto.randomUUID(),
    });
    const insert = (input: HostedDraftPointInsertInput, key = crypto.randomUUID(), other = false) =>
      insertHostedDraftPoint(
        dependencies,
        (other ? f.native.system.actors.other : f.native.author).actor,
        f.catalogueId,
        input,
        { ...context(), idempotencyKey: key },
      );
    const remove = (expectedRevisionId: string, occurrenceId: string, key = crypto.randomUUID()) =>
      removeHostedDraftPoint(
        dependencies,
        f.native.author.actor,
        f.catalogueId,
        { expectedRevisionId, occurrenceId },
        { ...context(), idempotencyKey: key },
      );

    const nonempty = await f.native.thread();
    const nonemptyCreated = await f.native.command('/v1/hostedCatalogues', {
      postId: nonempty.firstPost.id,
      threadId: nonempty.id,
      placements: [
        {
          occurrenceId: f.newOccurrenceIdFor(nonempty.firstPost.id),
          parentId: null,
          position: 0,
          title: 'Legacy',
          kind: 'part',
        },
      ],
    });
    await expect(
      insertHostedDraftPoint(
        dependencies,
        f.native.author.actor,
        nonempty.firstPost.id,
        {
          expectedRevisionId: nonemptyCreated.revisionId,
          occurrenceId: f.newOccurrenceIdFor(nonempty.firstPost.id),
          parentId: null,
          beforeOccurrenceId: null,
          title: 'Too late',
          placement: { kind: 'part' },
        },
        context(),
      ),
    ).rejects.toBeInstanceOf(InvalidHostedStructureError);

    const partId = f.newOccurrenceId();
    const emptyPartId = f.newOccurrenceId();
    const chapterId = f.newOccurrenceId();
    const nestedId = f.newOccurrenceId();
    const partInput: HostedDraftPointInsertInput = {
      expectedRevisionId: created.revisionId,
      occurrenceId: partId,
      parentId: null,
      beforeOccurrenceId: null,
      title: 'Part One',
      placement: { kind: 'part' },
    };
    const key = crypto.randomUUID();
    const first = await insert(partInput, key);
    expect(first.value).toEqual({ catalogueId: f.catalogueId, revisionId: expect.any(String) });
    expect(await insert(partInput, key)).toMatchObject({ value: first.value, replayed: true });
    await expect(insert({ ...partInput, title: 'Changed' }, key)).rejects.toThrow('Idempotency');

    const emptyPart = await insert({
      expectedRevisionId: first.value.revisionId,
      occurrenceId: emptyPartId,
      parentId: null,
      beforeOccurrenceId: null,
      title: 'Empty part',
      placement: { kind: 'part' },
    });
    await expect(
      insert({
        expectedRevisionId: emptyPart.value.revisionId,
        occurrenceId: f.newOccurrenceId(),
        parentId: null,
        beforeOccurrenceId: null,
        title: 'Broken attachment',
        placement: { kind: 'chapter', target: { ...target, sha256: '0'.repeat(64) } },
      }),
    ).rejects.toThrow();

    const originalRead = reads.readPostMetadata;
    let changedSource = false;
    const retained = spyOn(reads, 'readPostMetadata').mockImplementation(async (...args) => {
      const result = await originalRead(...args);
      if (args[2] === target.postId && !changedSource) {
        changedSource = true;
        expect((await f.native.revise(source.firstPost, {})).status).toBe(200);
      }
      return result;
    });
    try {
      await expect(
        insert({
          expectedRevisionId: emptyPart.value.revisionId,
          occurrenceId: f.newOccurrenceId(),
          parentId: partId,
          beforeOccurrenceId: null,
          title: 'Stale source',
          placement: { kind: 'chapter', target },
        }),
      ).rejects.toThrow();
      expect(changedSource).toBe(true);
    } finally {
      retained.mockRestore();
    }
    const fresh = f.target(await f.native.thread());
    const chapter = await insert({
      expectedRevisionId: emptyPart.value.revisionId,
      occurrenceId: chapterId,
      parentId: partId,
      beforeOccurrenceId: null,
      title: 'Nested chapter',
      placement: { kind: 'chapter', target: fresh },
    });
    const nested = await insert({
      expectedRevisionId: chapter.value.revisionId,
      occurrenceId: nestedId,
      parentId: partId,
      beforeOccurrenceId: chapterId,
      title: 'Before the chapter',
      placement: { kind: 'part' },
    });

    const children = await f.native.call('GET', `${path}/children?kind=structure`);
    expect(children.status).toBe(200);
    expect(children.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      partId,
      emptyPartId,
    ]);
    const nestedChildren = await f.native.call('GET', `${path}/children?kind=structure&parentId=${partId}`);
    expect(nestedChildren.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      nestedId,
      chapterId,
    ]);
    const historical = await f.native.call('GET', `${path}/children?kind=structure&revisionId=${created.revisionId}`);
    expect(historical.value.items).toEqual([]);
    const resolved = await f.native.call('GET', `${path}/occurrences/${chapterId}?kind=structure`);
    expect(resolved.status).toBe(200);
    expect(resolved.value.occurrence).toMatchObject({
      occurrenceId: chapterId,
      parentId: partId,
      kind: 'chapter',
      availability: 'available',
      target: fresh,
    });

    const candidates: HostedDraftPointInsertInput[] = [
      {
        expectedRevisionId: nested.value.revisionId,
        occurrenceId: f.newOccurrenceId(),
        parentId: null,
        beforeOccurrenceId: null,
        title: 'Race A',
        placement: { kind: 'part' },
      },
      {
        expectedRevisionId: nested.value.revisionId,
        occurrenceId: f.newOccurrenceId(),
        parentId: null,
        beforeOccurrenceId: null,
        title: 'Race B',
        placement: { kind: 'part' },
      },
    ];
    const race = await Promise.allSettled(candidates.map((candidate) => insert(candidate)));
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const loser = race.find((result) => result.status === 'rejected');
    expect(loser?.status === 'rejected' && loser.reason instanceof RevisionPreconditionError).toBe(true);
    const winner = race.find((result) => result.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('Missing race winner');
    const head = winner.value.value.revisionId;
    await expect(insert(partInput)).rejects.toBeInstanceOf(RevisionPreconditionError);

    const removed = await remove(head, partId);
    const afterRemove = await f.native.call('GET', `${path}/children?kind=structure`);
    expect(afterRemove.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([emptyPartId]);
    expect((await f.native.call('GET', `${path}/occurrences/${chapterId}?kind=structure`)).status).toBe(404);
    const pinned = await f.native.call(
      'GET',
      `${path}/children?kind=structure&parentId=${partId}&revisionId=${nested.value.revisionId}`,
    );
    expect(pinned.status).toBe(200);
    expect(pinned.value.items.map((item: { occurrenceId: string }) => item.occurrenceId)).toEqual([
      nestedId,
      chapterId,
    ]);
    await expect(insert({ ...partInput, expectedRevisionId: removed.value.revisionId })).rejects.toBeInstanceOf(
      InvalidHostedStructureError,
    );

    const events = await f.native.pool.query<{ type: string; data: Record<string, unknown> }>(
      `SELECT type,data FROM core.outbox WHERE subject=$1 AND type='com.rezics.content.hosted-catalogue.revise.v1'
       ORDER BY position,event_seq`,
      [f.catalogueId],
    );
    expect(events.rows.length).toBeGreaterThan(0);
    expect(events.rows.every((row) => Object.keys(row.data).sort().join() === 'catalogueId,revisionId')).toBe(true);
  } finally {
    await f.close();
  }
});
