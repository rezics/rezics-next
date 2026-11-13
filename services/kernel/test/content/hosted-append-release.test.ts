import { expect, setDefaultTimeout, test } from 'bun:test';
import { appendHostedRootChapter, type HostedCommandDependencies } from '../../src/content/hosted-chapters-commands.ts';
import { listHostedAuthorOutline, resolveHostedOccurrence } from '../../src/content/hosted-chapters-reads.ts';
import { HOSTED_APPEND_DESCRIPTOR_SELECT } from '../../src/content/hosted-chapters-append.ts';
import { HOSTED_PLACEMENT_SELECT } from '../../src/content/hosted-chapters-store.ts';
import appendRelease from '../../src/content/hosted-append-release-selected.sql';
import readChain from '../../src/content/read-chain.sql';
import { routeOf } from '../../src/route/route.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';
import { observeSql } from './support/sql-observer.ts';

setDefaultTimeout(180_000);

test('mixed publication reads selected pinned members only and keeps immutable releases and exact replay', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    const deps: HostedCommandDependencies = {
      pool: f.native.pool,
      access: f.native.system.access,
      tokens: f.native.system.tokenKeys,
      routeKey: f.native.system.routeKey,
      clock: () => new Date(),
    };
    const context = { actor: f.native.author.actor, deadline: Date.now() + 120_000 };
    const source = await f.native.thread(),
      hidden = await f.native.thread();
    const target = f.target(source);
    const [part, child, omitted, root, appended, later] = Array.from({ length: 6 }, () => f.newOccurrenceId()) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const path = `/v1/hostedCatalogues/${f.catalogueId}`;
    const base = (
      await f.native.command('/v1/hostedCatalogues', {
        postId: f.catalogueId,
        threadId: f.threadId,
        placements: [
          { occurrenceId: part, parentId: null, position: 0, title: 'Part', kind: 'part' },
          { occurrenceId: child, parentId: part, position: 0, title: 'Nested', kind: 'chapter', target },
          {
            occurrenceId: omitted,
            parentId: null,
            position: 1,
            title: 'Private',
            kind: 'chapter',
            target: f.target(hidden),
          },
          { occurrenceId: root, parentId: null, position: 2, title: 'Root', kind: 'chapter', target },
        ],
      })
    ).revisionId as string;
    const legacy = (
      await f.native.command(
        `${path}:publish`,
        {
          expectedRevisionId: base,
          expectedPublicationId: null,
          occurrenceIds: [root],
        },
        200,
      )
    ).revisionId as string;
    const oldLink = await resolveHostedOccurrence(deps, f.catalogueId, root, { revisionId: legacy }, context);
    await f.native.command(`/v1/posts/${hidden.firstPost.id}:erase`, { reason: 'Unselected private chapter' }, 200);
    // Attachment admission must retain this old exact revision after the Post head changes.
    expect((await f.native.revise(source.firstPost, {})).status).toBe(200);
    const append = async (expectedRevisionId: string, occurrenceId: string) =>
      (
        await appendHostedRootChapter(
          deps,
          context.actor,
          f.catalogueId,
          {
            expectedRevisionId,
            occurrenceId,
            title: 'Appended',
            target,
          },
          { idempotencyKey: crypto.randomUUID(), deadline: context.deadline, requestId: crypto.randomUUID() },
        )
      ).value.revisionId;
    const pinned = await append(base, appended);
    const input = {
      expectedRevisionId: pinned,
      expectedPublicationId: legacy,
      occurrenceIds: [appended, root, child, part],
    };
    const baseSql = `${HOSTED_PLACEMENT_SELECT} AND p.occurrence_id = ANY($4::uuid[]) ORDER BY p.ordinal`;
    const sourceReads = (start: number) =>
      observer.records
        .slice(start)
        .filter((row) => /FROM content.hosted_(placement|append\b|append_descriptor\b)/.test(row.statement));
    const assertSelectedReads = (start: number, ids: string[]) => {
      const reads = sourceReads(start);
      expect(reads.map((row) => row.statement)).toEqual([HOSTED_APPEND_DESCRIPTOR_SELECT, baseSql, appendRelease.sql]);
      expect(reads[0]!.parameters).toEqual([routeOf(f.catalogueId), f.catalogueId, pinned]);
      expect(reads[1]!.parameters).toEqual([routeOf(f.catalogueId), f.catalogueId, base, ids]);
      const values = reads[2]!.parameters;
      for (const [name, value] of Object.entries({
        route: routeOf(f.catalogueId),
        catalogue_id: f.catalogueId,
        stream_id: base,
        occurrence_ids: ids,
        high_water: '0',
      }))
        expect(values[appendRelease.params.indexOf(name)]).toEqual(value);
      const nativeReads = observer.records.slice(start).filter((row) => row.statement === readChain.sql);
      expect(nativeReads.length).toBeGreaterThan(0);
      expect(nativeReads.every((row) => row.parameters[readChain.params.indexOf('include_body')] === false)).toBe(true);
      expect(
        nativeReads.some((row) =>
          [hidden.firstPost.id, hidden.firstPost.revisionId].includes(
            row.parameters[readChain.params.indexOf('id')] as string,
          ),
        ),
      ).toBe(false);
    };
    const denied = observer.records.length;
    expect((await f.native.call('POST', `${path}:publish`, input, { other: true })).status).toBe(403);
    expect(sourceReads(denied)).toEqual([]);
    const key = crypto.randomUUID(),
      start = observer.records.length;
    const published = await f.native.call('POST', `${path}:publish`, input, { key });
    expect(published.status, JSON.stringify(published.value)).toBe(200);
    assertSelectedReads(start, input.occurrenceIds);
    const releaseId = published.value.revisionId as string;
    const outline = await listHostedAuthorOutline(deps, f.catalogueId, { revisionId: releaseId }, context);
    expect(outline.value.sourceRevisionId).toBe(pinned);
    expect(outline.value.items.map((row) => [row.occurrenceId, row.parentId, row.position])).toEqual([
      [part, null, 0],
      [child, part, 0],
      [root, null, 1],
      [appended, null, 2],
    ]);
    expect(outline.value.items.slice(1).map((row) => (row.availability === 'available' ? row.target : null))).toEqual([
      target,
      target,
      target,
    ]);
    const exact = await resolveHostedOccurrence(deps, f.catalogueId, appended, { revisionId: releaseId }, context);
    const head = await append(pinned, later);
    // A physically present later stream row is unknown to the pinned source, even before stale-head CAS.
    for (const ids of [[later], [appended, appended], [child], [f.newOccurrenceId()]]) {
      const before = observer.records.length;
      expect((await f.native.call('POST', `${path}:publish`, { ...input, occurrenceIds: ids })).status).toBe(400);
      assertSelectedReads(before, ids);
    }
    const stale = observer.records.length;
    expect((await f.native.call('POST', `${path}:publish`, input)).status).toBe(412);
    assertSelectedReads(stale, input.occurrenceIds);
    const withdrawal = observer.records.length;
    await f.native.command(
      `${path}:publish`,
      {
        expectedRevisionId: head,
        expectedPublicationId: releaseId,
        occurrenceIds: [],
      },
      200,
    );
    expect(sourceReads(withdrawal)).toEqual([]);
    const retry = observer.records.length;
    expect(await f.native.call('POST', `${path}:publish`, input, { key })).toEqual(published);
    assertSelectedReads(retry, input.occurrenceIds);
    expect((await f.native.call('GET', `${path}/children`)).value.items).toEqual([]);
    expect(
      (await resolveHostedOccurrence(deps, f.catalogueId, appended, { revisionId: releaseId }, context)).value,
    ).toEqual(exact.value);
    expect((await resolveHostedOccurrence(deps, f.catalogueId, root, { revisionId: legacy }, context)).value).toEqual(
      oldLink.value,
    );
  } finally {
    await observer.close();
    await f.close();
  }
});
