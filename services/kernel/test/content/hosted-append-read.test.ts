import { expect, setDefaultTimeout, test } from 'bun:test';
import { Value } from 'typebox/value';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import { hostedCursorBinding, writeHostedCursor } from '../../src/content/hosted-chapters-cursor.ts';
import { HostedPageSchema, HostedReviseSchema } from '../../src/content/hosted-chapters-schemas.ts';
import {
  listHostedAuthorOutline,
  listHostedChildren,
  navigateHostedChapters,
  resolveHostedOccurrence,
  resolveHostedOccurrenceMetadata,
} from '../../src/content/hosted-chapters-reads.ts';
import type { HostedChildrenInput, HostedPlacement } from '../../src/content/hosted-chapters-model.ts';
import readChain from '../../src/content/read-chain.sql';
import appendNext from '../../src/content/hosted-append-read-next.sql';
import appendPrevious from '../../src/content/hosted-append-read-previous.sql';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

test('pinned mixed drafts retain raw slots, exact links, authority and bounded segment reads', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    let now = Date.now();
    const deps: HostedCommandDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(now),
    };
    const context = { actor: f.native.author.actor, deadline: Date.now() + 120_000 };
    const source = await f.native.thread(),
      concealed = await f.native.thread();
    const ids = Array.from({ length: 512 }, () => f.newOccurrenceId());
    const placements: HostedPlacement[] = ids.map((occurrenceId, i) => ({
      occurrenceId,
      parentId: i === 1 ? ids[0]! : null,
      position: i < 2 ? 0 : i - 1,
      title: `Base ${i}`,
      ...(i === 0 ? { kind: 'part' as const } : { kind: 'chapter' as const, target: f.target(source) }),
    }));
    const base = (
      await f.native.command('/v1/hostedCatalogues', { postId: f.catalogueId, threadId: f.threadId, placements })
    ).revisionId as string;
    const release = (
      await f.native.command(
        `/v1/hostedCatalogues/${f.catalogueId}:publish`,
        { expectedRevisionId: base, expectedPublicationId: null, occurrenceIds: [ids[511]] },
        200,
      )
    ).revisionId as string;
    const oldLink = await resolveHostedOccurrence(deps, f.catalogueId, ids[511]!, { revisionId: release }, context);
    const appended = Array.from({ length: 3 }, () => f.newOccurrenceId());
    const append = async (expectedRevisionId: string, i: number) =>
      (
        await appendHostedRootChapter(
          deps,
          context.actor,
          f.catalogueId,
          {
            expectedRevisionId,
            occurrenceId: appended[i]!,
            title: `Append ${i}`,
            target: f.target(i === 0 ? concealed : source),
          },
          { idempotencyKey: crypto.randomUUID(), deadline: context.deadline, requestId: crypto.randomUUID() },
        )
      ).value.revisionId;
    const first = await append(base, 0),
      pinned = await append(first, 1);
    await f.native.command(`/v1/posts/${concealed.firstPost.id}:erase`, { reason: 'Conceal retained chapter' }, 200);
    const children = (input: HostedChildrenInput) => listHostedChildren(deps, f.catalogueId, input, context);
    const initial = await children({ kind: 'structure', limit: 2 });
    const token = (mode: 'children' | 'outline', after: number) =>
      writeHostedCursor(
        deps,
        hostedCursorBinding(
          f.catalogueId,
          mode === 'children' ? { kind: 'structure' } : { revisionId: pinned },
          context,
          { mode, parentId: null, occurrenceId: null, limit: 2 },
        ),
        { revisionId: pinned, after, origin: -1, issuedAt: now, epoch: initial.anchors[0]!.epoch },
      );
    const cursor = token('children', 509);
    const outline = (cursor?: string) =>
      listHostedAuthorOutline(deps, f.catalogueId, { revisionId: pinned, limit: 2, cursor }, context);
    const metadata = (revisionId: string, occurrenceId: string) =>
      resolveHostedOccurrenceMetadata(deps, f.catalogueId, occurrenceId, { revisionId }, context);
    const navigate = (occurrenceId: string, direction: 'next' | 'previous') =>
      navigateHostedChapters(deps, f.catalogueId, { revisionId: pinned, occurrenceId, direction, limit: 2 }, context);
    await append(pinned, 2);
    const start = observer.records.length;
    const mixed = await children({ kind: 'structure', limit: 2, cursor });
    expect(mixed.value.revisionId).toBe(pinned);
    expect(mixed.value.items).toEqual([
      expect.objectContaining({ occurrenceId: ids[511], position: 510, availability: 'available' }),
      { occurrenceId: appended[0], parentId: null, position: 511, kind: 'chapter', availability: 'unavailable' },
    ]);
    expect(mixed.value.nextCursor).toEqual(expect.any(String));
    const continued = await children({ kind: 'structure', limit: 2, cursor: mixed.value.nextCursor! });
    expect(continued.value.items).toEqual([expect.objectContaining({ occurrenceId: appended[1], position: 512 })]);
    expect(continued.value.nextCursor).toBeNull();
    expect(Value.Check(HostedPageSchema, continued.value)).toBe(true);
    expect(
      Value.Check(HostedReviseSchema, {
        expectedRevisionId: pinned,
        placements: [{ ...placements[511], position: 512 }],
      }),
    ).toBe(false);
    expect((await navigate(ids[511]!, 'next')).value.items.map((item) => item.occurrenceId)).toEqual(
      appended.slice(0, 2),
    );
    expect((await navigate(appended[1]!, 'previous')).value.items.map((item) => item.occurrenceId)).toEqual([
      appended[0],
      ids[511],
    ]);
    const authorPage = await outline(token('outline', 510));
    expect(authorPage.value.items.map((item) => item.occurrenceId)).toEqual([ids[511], appended[0]]);
    expect((await outline(authorPage.value.nextCursor!)).value.items[0]!.occurrenceId).toBe(appended[1]!);
    await expect(metadata(first, appended[1]!)).rejects.toThrow();
    await expect(metadata(base, appended[0]!)).rejects.toThrow();
    expect((await metadata(pinned, appended[1]!)).value.occurrence).toMatchObject({
      occurrenceId: appended[1],
      position: 512,
      target: f.target(source),
    });
    const reads = observer.records.slice(start);
    expect(
      reads.filter(
        (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
      ),
    ).toHaveLength(0);
    const segmentReads = reads.filter(
      (row) => row.statement === appendNext.sql || row.statement === appendPrevious.sql,
    );
    expect(segmentReads.length).toBeGreaterThan(0);
    for (const row of segmentReads) {
      const sql = row.statement === appendNext.sql ? appendNext : appendPrevious;
      expect(row.parameters[sql.params.indexOf('limit')]).toBe(3);
      expect(row.parameters[sql.params.indexOf('high_water')]).toBe('1');
    }
    const beforeNested = observer.records.length;
    expect(
      (await children({ revisionId: pinned, parentId: ids[0] })).value.items.map((item) => item.occurrenceId),
    ).toEqual([ids[1]]);
    expect(
      observer.records.slice(beforeNested).some((row) => row.statement.includes('FROM content.hosted_append a')),
    ).toBe(false);
    const beforeLegacy = observer.records.length;
    expect((await children({ revisionId: base })).value.items[0]!.occurrenceId).toBe(ids[0]!);
    expect(
      (await resolveHostedOccurrence(deps, f.catalogueId, ids[511]!, { revisionId: release }, context)).value,
    ).toEqual(oldLink.value);
    expect(
      observer.records.slice(beforeLegacy).some((row) => row.statement.includes('FROM content.hosted_append a')),
    ).toBe(false);
    const bodyStart = observer.records.length;
    expect(
      (await resolveHostedOccurrence(deps, f.catalogueId, appended[1]!, { revisionId: pinned }, context)).value.document
        ?.sha256,
    ).toBe(f.target(source).sha256);
    expect(
      observer.records
        .slice(bodyStart)
        .filter(
          (row) => row.statement === readChain.sql && row.parameters[readChain.params.indexOf('include_body')] === true,
        ),
    ).toHaveLength(1);
    now += 15 * 60_000 + 1;
    await expect(children({ kind: 'structure', limit: 2, cursor: mixed.value.nextCursor! })).rejects.toThrow('cursor');
    now -= 15 * 60_000 + 1;
    await f.native.command(`/v1/posts/${f.catalogueId}:erase`, { reason: 'Revoke catalogue disclosure' }, 200);
    await expect(children({ kind: 'structure', limit: 2, cursor })).rejects.toThrow();
  } finally {
    await observer.close();
    await f.close();
  }
});
