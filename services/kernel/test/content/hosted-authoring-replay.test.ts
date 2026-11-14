import { expect, setDefaultTimeout, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import readChain from '../../src/content/read-chain.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

test('hosted authoring receipts replay after source erasure without probes or new writes', async () => {
  const f = await hostedChaptersFixture();
  const observer = observeSql(f.native.pool);
  try {
    const catalogue = await f.native.thread();
    const source = await f.native.thread();
    const catalogueId = catalogue.firstPost.id;
    const route = routeOf(catalogueId)!;
    const partition = partitionOf(route);
    const path = `/v1/hostedCatalogues/${catalogueId}`;
    const send = async (targetPath: string, body: unknown, key: string, other = false) => {
      const actor = other ? f.native.system.actors.other : f.native.author;
      const response = await f.native.system.kernel.handle(
        new Request(`https://content.test${targetPath}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${actor.bearer}`,
            'content-type': 'application/json',
            'idempotency-key': JSON.stringify(key),
          },
          body: JSON.stringify(body),
        }),
      );
      return {
        status: response.status,
        value: (await response.json()) as Record<string, any>,
        session: response.headers.get(SESSION_HEADER),
      };
    };
    const target = f.target(source);
    const createInput = {
      postId: catalogueId,
      threadId: catalogue.id,
      placements: [
        {
          occurrenceId: f.newOccurrenceIdFor(catalogueId),
          parentId: null,
          position: 0,
          title: 'Opening',
          kind: 'chapter',
          target,
        },
      ],
    };
    const createKey = crypto.randomUUID();
    const created = await send('/v1/hostedCatalogues', createInput, createKey);
    expect(created.status, JSON.stringify(created.value)).toBe(201);

    const occurrenceId = f.newOccurrenceIdFor(catalogueId);
    const insertInput = {
      expectedRevisionId: created.value.revisionId,
      occurrenceId,
      parentId: null,
      beforeOccurrenceId: null,
      title: 'Second chapter',
      placement: { kind: 'chapter', target },
    };
    const insertKey = crypto.randomUUID();
    const inserted = await send(`${path}:insertDraftPoint`, insertInput, insertKey);
    expect(inserted.status, JSON.stringify(inserted.value)).toBe(200);

    const appendInput = {
      expectedRevisionId: inserted.value.revisionId,
      occurrenceId: f.newOccurrenceIdFor(catalogueId),
      title: 'Third chapter',
      target,
    };
    const appendKey = crypto.randomUUID();
    const appended = await send(`${path}:appendRootChapter`, appendInput, appendKey);
    expect(appended.status, JSON.stringify(appended.value)).toBe(200);

    const publicationInput = {
      expectedRevisionId: appended.value.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [createInput.placements[0]!.occurrenceId, occurrenceId, appendInput.occurrenceId],
    };
    const publicationKey = crypto.randomUUID();
    const published = await send(`${path}:publish`, publicationInput, publicationKey);
    expect(published.status, JSON.stringify(published.value)).toBe(200);

    const revisedSource = await f.native.revise(source.firstPost, {});
    expect(revisedSource.status).toBe(200);
    const revisedTarget = {
      ...target,
      revisionId: revisedSource.value.post.revisionId,
      sha256: revisedSource.value.post.sha256,
    };
    const updateInput = {
      expectedRevisionId: appended.value.revisionId,
      occurrenceId,
      title: 'Revised chapter',
      target: revisedTarget,
    };
    const updateKey = crypto.randomUUID();
    const updated = await send(`${path}:updateDraftPoint`, updateInput, updateKey);
    expect(updated.status, JSON.stringify(updated.value)).toBe(200);
    const later = await send(
      `${path}:updateDraftPoint`,
      { ...updateInput, expectedRevisionId: updated.value.revisionId, title: 'Later chapter' },
      crypto.randomUUID(),
    );
    expect(later.status, JSON.stringify(later.value)).toBe(200);
    await f.native.command(`/v1/posts/${target.postId}:erase`, { reason: 'Erase hosted chapter source' }, 200);

    const sourceIds = new Set([target.postId, target.revisionId, revisedTarget.revisionId]);
    const sourceProbes = (records: readonly SqlExecution[]) => {
      const idIndex = readChain.params.indexOf('id');
      return records.filter(
        (row) => row.statement === readChain.sql && sourceIds.has(row.parameters[idIndex] as string),
      );
    };
    const selectionProbes = (records: readonly SqlExecution[]) =>
      records.filter((row) => /FROM content\.hosted_(?!catalogue\b)/.test(row.statement));
    const counts = async () => {
      const result = await f.native.pool.query<{ revisions: string; events: string; position: string }>(
        `SELECT
           ((SELECT count(*) FROM content.hosted_structure_revision WHERE route=$1 AND catalogue_id=$2) +
            (SELECT count(*) FROM content.hosted_version_revision WHERE route=$1 AND catalogue_id=$2))::text AS revisions,
           (SELECT count(*)::text FROM core.outbox
             WHERE partition_no=$3 AND type LIKE 'com.rezics.content.hosted-catalogue.%'
               AND data->>'catalogueId'=$2) AS events,
           (SELECT position::text FROM core.partition WHERE partition_no=$3) AS position`,
        [route, catalogueId, partition],
      );
      return result.rows[0]!;
    };
    const commands = [
      { path: '/v1/hostedCatalogues', input: createInput, key: createKey, result: created, status: 201 },
      { path: `${path}:insertDraftPoint`, input: insertInput, key: insertKey, result: inserted, status: 200 },
      { path: `${path}:appendRootChapter`, input: appendInput, key: appendKey, result: appended, status: 200 },
      { path: `${path}:publish`, input: publicationInput, key: publicationKey, result: published, status: 200 },
      { path: `${path}:updateDraftPoint`, input: updateInput, key: updateKey, result: updated, status: 200 },
    ];

    const beforeReplay = await counts();
    const replayStart = observer.records.length;
    for (const command of commands) {
      const replay = await send(command.path, command.input, command.key);
      expect(replay.status).toBe(command.status);
      expect(replay.value).toEqual(command.result.value);
      expect(replay.session).toBe(command.result.session);
    }
    const replayRecords = observer.records.slice(replayStart);
    expect(sourceProbes(replayRecords)).toEqual([]);
    expect(selectionProbes(replayRecords)).toEqual([]);
    expect(await counts()).toEqual(beforeReplay);

    const failuresStart = observer.records.length;
    const unauthorized = await send(`${path}:insertDraftPoint`, insertInput, insertKey, true);
    expect(unauthorized.status).toBe(403);
    const conflict = await send(
      `${path}:insertDraftPoint`,
      { ...insertInput, title: 'Different request' },
      insertKey,
    );
    expect(conflict.status).toBe(409);
    const freshStatuses: number[] = [];
    for (const command of commands)
      freshStatuses.push((await send(command.path, command.input, crypto.randomUUID())).status);
    expect(freshStatuses).toEqual(commands.map(() => 404));
    expect(sourceProbes(observer.records.slice(failuresStart)).length).toBeGreaterThan(0);
    expect(await counts()).toEqual(beforeReplay);

    const minimized = await f.native.pool.query(
      `UPDATE core.receipt SET response='null'::jsonb,payload_state='minimized'
       WHERE principal_id=$1 AND command_kind='content.hosted-catalogue.publish'
         AND response->>'revisionId'=$2`,
      [f.native.author.actor.accountId, published.value.revisionId],
    );
    expect(minimized.rowCount).toBe(1);
    const erasedReceiptStart = observer.records.length;
    const erasedReceipt = await send(`${path}:publish`, publicationInput, publicationKey);
    expect(erasedReceipt.status).toBe(410);
    expect(erasedReceipt.value.code).toBe('command_result_erased');
    expect(sourceProbes(observer.records.slice(erasedReceiptStart))).toEqual([]);
  } finally {
    await observer.close();
    await f.close();
  }
});
