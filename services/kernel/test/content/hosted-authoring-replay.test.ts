import { expect, setDefaultTimeout, test } from 'bun:test';
import { SESSION_HEADER } from '@rezics/operations/protocol';
import readChain from '../../src/content/read-chain.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql, type SqlExecution } from './support/sql-observer.ts';
import { hostedChaptersFixture } from './support/hosted-chapters-fixture.ts';

setDefaultTimeout(180_000);

test('hosted authoring receipts replay after source erasure without source probes or new writes', async () => {
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
    const initialOccurrenceId = f.newOccurrenceIdFor(catalogueId);
    const createInput = {
      postId: catalogueId,
      threadId: catalogue.id,
      placements: [
        {
          occurrenceId: initialOccurrenceId,
          parentId: null,
          position: 0,
          title: 'First chapter',
          kind: 'chapter',
          target,
        },
      ],
    };
    const createKey = crypto.randomUUID();
    const initial = await send('/v1/hostedCatalogues', createInput, createKey);
    expect(initial.status, JSON.stringify(initial.value)).toBe(201);

    const reviseInput = {
      expectedRevisionId: initial.value.revisionId,
      placements: [{ ...createInput.placements[0], title: 'Revised first chapter' }],
    };
    const reviseKey = crypto.randomUUID();
    const revised = await send(`${path}:revise`, reviseInput, reviseKey);
    expect(revised.status, JSON.stringify(revised.value)).toBe(200);

    const occurrenceId = f.newOccurrenceIdFor(catalogueId);
    const insertInput = {
      expectedRevisionId: revised.value.revisionId,
      occurrenceId,
      parentId: null,
      beforeOccurrenceId: null,
      title: 'Opening',
      placement: { kind: 'chapter', target },
    };
    const insertKey = crypto.randomUUID();
    const inserted = await send(`${path}:insertDraftPoint`, insertInput, insertKey);
    expect(inserted.status, JSON.stringify(inserted.value)).toBe(200);

    const appendInput = {
      expectedRevisionId: inserted.value.revisionId,
      occurrenceId: f.newOccurrenceIdFor(catalogueId),
      title: 'Appended chapter',
      target,
    };
    const appendKey = crypto.randomUUID();
    const appended = await send(`${path}:appendRootChapter`, appendInput, appendKey);
    expect(appended.status, JSON.stringify(appended.value)).toBe(200);

    const publicationInput = {
      expectedRevisionId: appended.value.revisionId,
      expectedPublicationId: null,
      occurrenceIds: [initialOccurrenceId, appendInput.occurrenceId, occurrenceId],
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
      title: 'Revised opening',
      target: revisedTarget,
    };
    const updateKey = crypto.randomUUID();
    const updated = await send(`${path}:updateDraftPoint`, updateInput, updateKey);
    expect(updated.status, JSON.stringify(updated.value)).toBe(200);

    const later = await send(
      `${path}:updateDraftPoint`,
      { ...updateInput, expectedRevisionId: updated.value.revisionId, title: 'Later opening' },
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
      records.filter((row) =>
        /FROM content\.hosted_(?!catalogue\b)/.test(row.statement),
      );
    const receiptPosition = async (kind: string, revisionId: string) => {
      const result = await f.native.pool.query<{
        epoch: number;
        position: string;
        transaction_id: string;
      }>(
        `SELECT epoch,position::text,transaction_id::text FROM core.receipt
         WHERE principal_kind='account' AND principal_id=$1 AND command_kind=$2
           AND response->>'revisionId'=$3`,
        [f.native.author.actor.accountId, kind, revisionId],
      );
      expect(result.rows).toHaveLength(1);
      return result.rows[0]!;
    };
    const counts = async () => {
      const result = await f.native.pool.query<{
        revisions: string;
        events: string;
        position: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM content.hosted_structure_revision
             WHERE route=$1 AND catalogue_id=$2) AS revisions,
           (SELECT count(*)::text FROM core.outbox
             WHERE partition_no=$3 AND type LIKE 'com.rezics.content.hosted-catalogue.%'
               AND data->>'catalogueId'=$2) AS events,
           (SELECT position::text FROM core.partition WHERE partition_no=$3) AS position`,
        [route, catalogueId, partition],
      );
      return result.rows[0]!;
    };

    const originalReceipts = [
      await receiptPosition('content.hosted-catalogue.create', initial.value.revisionId),
      await receiptPosition('content.hosted-catalogue.revise', revised.value.revisionId),
      await receiptPosition('content.hosted-catalogue.append', appended.value.revisionId),
      await receiptPosition('content.hosted-catalogue.insert-draft-point', inserted.value.revisionId),
      await receiptPosition('content.hosted-catalogue.publish', published.value.revisionId),
      await receiptPosition('content.hosted-catalogue.update-draft-point', updated.value.revisionId),
    ];
    const beforeReplay = await counts();
    const replayStart = observer.records.length;
    const createReplay = await send('/v1/hostedCatalogues', createInput, createKey);
    const reviseReplay = await send(`${path}:revise`, reviseInput, reviseKey);
    const appendReplay = await send(`${path}:appendRootChapter`, appendInput, appendKey);
    const insertReplay = await send(`${path}:insertDraftPoint`, insertInput, insertKey);
    const publishReplay = await send(`${path}:publish`, publicationInput, publicationKey);
    const updateReplay = await send(`${path}:updateDraftPoint`, updateInput, updateKey);
    expect(createReplay.status).toBe(201);
    expect(reviseReplay.status).toBe(200);
    expect(appendReplay.status).toBe(200);
    expect(insertReplay.status).toBe(200);
    expect(publishReplay.status).toBe(200);
    expect(updateReplay.status).toBe(200);
    expect(createReplay.value).toEqual(initial.value);
    expect(reviseReplay.value).toEqual(revised.value);
    expect(appendReplay.value).toEqual(appended.value);
    expect(insertReplay.value).toEqual(inserted.value);
    expect(publishReplay.value).toEqual(published.value);
    expect(updateReplay.value).toEqual(updated.value);
    expect(createReplay.session).toBe(initial.session);
    expect(reviseReplay.session).toBe(revised.session);
    expect(appendReplay.session).toBe(appended.session);
    expect(insertReplay.session).toBe(inserted.session);
    expect(publishReplay.session).toBe(published.session);
    expect(updateReplay.session).toBe(updated.session);
    const replayRecords = observer.records.slice(replayStart);
    expect(sourceProbes(replayRecords)).toEqual([]);
    expect(selectionProbes(replayRecords)).toEqual([]);
    expect(await counts()).toEqual(beforeReplay);
    expect(await receiptPosition('content.hosted-catalogue.create', initial.value.revisionId)).toEqual(
      originalReceipts[0],
    );
    expect(await receiptPosition('content.hosted-catalogue.revise', revised.value.revisionId)).toEqual(
      originalReceipts[1],
    );
    expect(await receiptPosition('content.hosted-catalogue.append', appended.value.revisionId)).toEqual(
      originalReceipts[2],
    );
    expect(await receiptPosition('content.hosted-catalogue.insert-draft-point', inserted.value.revisionId)).toEqual(
      originalReceipts[3],
    );
    expect(await receiptPosition('content.hosted-catalogue.publish', published.value.revisionId)).toEqual(
      originalReceipts[4],
    );
    expect(await receiptPosition('content.hosted-catalogue.update-draft-point', updated.value.revisionId)).toEqual(
      originalReceipts[5],
    );

    const failuresStart = observer.records.length;
    const unauthorized = await send(`${path}:insertDraftPoint`, insertInput, insertKey, true);
    expect(unauthorized.status).toBe(403);
    const conflict = await send(
      `${path}:insertDraftPoint`,
      { ...insertInput, title: 'Different request' },
      insertKey,
    );
    expect(conflict.status).toBe(409);
    const freshCreate = await send('/v1/hostedCatalogues', createInput, crypto.randomUUID());
    const freshRevise = await send(`${path}:revise`, reviseInput, crypto.randomUUID());
    const freshAppend = await send(`${path}:appendRootChapter`, appendInput, crypto.randomUUID());
    const freshInsert = await send(`${path}:insertDraftPoint`, insertInput, crypto.randomUUID());
    const freshPublish = await send(`${path}:publish`, publicationInput, crypto.randomUUID());
    const freshUpdate = await send(
      `${path}:updateDraftPoint`,
      { ...updateInput, expectedRevisionId: later.value.revisionId },
      crypto.randomUUID(),
    );
    expect([
      freshCreate.status,
      freshRevise.status,
      freshAppend.status,
      freshInsert.status,
      freshPublish.status,
      freshUpdate.status,
    ]).toEqual([404, 404, 404, 404, 404, 404]);
    const failures = observer.records.slice(failuresStart);
    expect(sourceProbes(failures).length).toBeGreaterThan(0);
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
