import { expect, test } from 'bun:test';
import type { CloudEvent } from '../../src/events/log.ts';
import { advanceCollectionOrderRepair } from '../../src/library/collection-order-work.ts';
import { COLLECTION_ORDER_WORKFLOW, type CollectionOrderLocator } from '../../src/library/collection-order.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createCollectionBatchFixture, entryKey } from './support/collection-batch-fixture.ts';

// One maintained native outcome using the existing HTTP fixture, default Library
// composition, real outbox effect and DBOS maintenance queue. No alternate rank
// engine, work provider or growth harness supplies the result.
test('Large Collections keep bounded point edits and resumable order repair', async () => {
  const f = await createCollectionBatchFixture();
  let client: Awaited<ReturnType<typeof createWorkClient>> | undefined;
  let worker: Awaited<ReturnType<typeof composeWork>> | undefined;
  try {
    const collection = await f.make();
    const route = routeOf(collection.id)!;
    const subject = await f.createSubject('game');
    const first = await f.add(collection.id, subject, 'first occurrence');
    const deleted = await f.add(collection.id, subject, 'retained Undo');
    const removed = await f.commands.removeMember(
      f.owner.actor,
      collection.id,
      deleted.id,
      (await f.current(collection.id)).revision,
      entryKey(),
    );
    const ids = [first.id, ...Array.from({ length: 5000 }, () => newId(route))];
    const dense = ids.map((id, index) => ({ id, key: `a0${'V'.repeat(30)}${index.toString(36).padStart(4, '0')}V` }));
    // Data-only existing-population fixture. Every identity, subject, parent and
    // grant above entered through its ordinary native boundary. Stored 48-byte
    // keys model a migrated dense order; commands cannot submit rank strings.
    const connection = await f.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        'UPDATE library.collection_member SET ordinal_key=$4 WHERE route=$1 AND collection_id=$2 AND member_id=$3',
        [route, collection.id, first.id, dense[0]!.key],
      );
      await connection.query(
        `INSERT INTO library.collection_member(route,collection_id,member_id,subject_id,note,ordinal_key,added_at,transaction_id)
         SELECT $1,$2,item.id,$3,'duplicate occurrence',item.key,now(),$5 FROM
         jsonb_to_recordset($4::jsonb) AS item(id uuid,key text)`,
        [route, collection.id, subject, JSON.stringify(dense.slice(1)), entryKey()],
      );
      await connection.query(
        'UPDATE library.collection SET member_count=$3,source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
        [route, collection.id, ids.length],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    const tombstone = async () =>
      (
        await f.pool.query(
          'SELECT to_jsonb(m) AS row FROM library.collection_member m WHERE route=$1 AND collection_id=$2 AND member_id=$3',
          [route, collection.id, deleted.id],
        )
      ).rows;
    const retained = await tombstone();
    const snapshot = async () =>
      (
        await f.pool.query(
          `SELECT member_id,subject_id,note,added_at,member_revision FROM library.collection_member
       WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL ORDER BY ordinal_key,member_id`,
          [route, collection.id],
        )
      ).rows;
    const original = await snapshot();
    expect(original.map((row) => row.member_id)).toEqual(ids);
    const page = await f.send(f.owner.bearer, 'GET', `/v1/collections/${collection.id}/members?limit=1`);
    expect(page.status).toBe(200);
    const cursor = (await page.json()).next as string;
    expect(cursor).toEqual(expect.any(String));

    // The attempted add is beyond 5,000. Admission is honest and has no success
    // receipt/member row; a different, authorized repair-begin command commits.
    const key = entryKey();
    const draft = { subjectId: subject, note: 'original intent', after: ids[2500]! };
    const add = () => f.send(f.owner.bearer, 'POST', `/v1/collections/${collection.id}/members`, draft, key);
    const preparing = await add();
    expect(preparing.status, await preparing.clone().text()).toBe(503);
    expect((await preparing.json()).code).toBe('dependency_unavailable');
    expect((await f.current(collection.id)).memberCount).toBe(5001);
    expect(await snapshot()).toEqual(original);
    const capture = (
      await f.pool.query(
        'SELECT repair_id,step,processed,lower_key,upper_key,original_minimum FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2',
        [route, collection.id],
      )
    ).rows[0]!;
    expect(capture.processed).toBe(0);
    expect(capture.upper_key < capture.original_minimum).toBe(true);
    const locator: CollectionOrderLocator = { collectionId: collection.id, repairId: capture.repair_id, step: 0 };
    // Commit one page and stop before delivering its continuation. Resumption is
    // from this native cursor, not from a test-side replacement repair algorithm.
    await advanceCollectionOrderRepair({ pool: f.pool, clock: () => new Date() }, locator);
    expect(await snapshot()).toEqual(original);
    const progress = (
      await f.pool.query(
        'SELECT step,processed,after_key FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2',
        [route, collection.id],
      )
    ).rows[0]!;
    expect(progress).toMatchObject({ step: 1, processed: 128 });
    expect(progress.after_key).toBe(dense[127]!.key);
    expect((await advanceCollectionOrderRepair({ pool: f.pool, clock: () => new Date() }, locator)).value.state).toBe(
      'stale',
    );
    expect((await add()).status).toBe(503);
    const stale = await f.send(
      f.owner.bearer,
      'GET',
      `/v1/collections/${collection.id}/members?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('stale_cursor');

    client = await createWorkClient(process.env.DATABASE_URL!);
    worker = await composeWork([libraryWorkModule], {
      databaseUrl: process.env.DATABASE_URL!,
      pool: f.pool,
      client,
      env: {},
    });
    await worker.launch();
    // Deliver committed envelopes through the production effect, as in the
    // existing Collection HTTP suite. The registered workflow owns every page.
    for (let step = 1; step < 50; step++) {
      const found = (
        await f.pool.query(
          'SELECT step FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3',
          [route, collection.id, locator.repairId],
        )
      ).rows[0];
      if (!found) break;
      expect(found.step).toBe(step);
      const row = (
        await f.pool.query(
          `SELECT * FROM core.outbox WHERE partition_no=$1 AND subject=$2
         AND type='com.rezics.library.collection.order-repair.advanced.v1'
         AND data->>'repairId'=$3 AND data->>'step'=$4 LIMIT 1`,
          [partitionOf(route), collection.id, locator.repairId, String(step)],
        )
      ).rows[0]!;
      expect(row).toBeDefined();
      const event: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
        type: row.type,
        subject: collection.id,
        time: row.recorded_at.toISOString(),
        sequence: String(row.position).padStart(19, '0'),
        datacontenttype: 'application/json',
        data: row.data,
      };
      await (
        await client.enqueue(
          {
            workflowName: 'effect',
            queueName: 'effects',
            queuePartitionKey: String(partitionOf(route)),
            workflowID: entryKey(),
          },
          'library_collection_order_repair',
          event,
        )
      ).getResult({ pollingIntervalMs: 10 });
      await client
        .retrieveWorkflow(`${COLLECTION_ORDER_WORKFLOW}:${locator.repairId}:${step}`)
        .getResult({ pollingIntervalMs: 10 });
      expect(await snapshot()).toEqual(original);
      expect(await tombstone()).toEqual(retained);
    }
    expect(
      (
        await f.pool.query('SELECT 1 FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2', [
          route,
          collection.id,
        ])
      ).rows,
    ).toEqual([]);
    expect((await advanceCollectionOrderRepair({ pool: f.pool, clock: () => new Date() }, locator)).value.state).toBe(
      'stale',
    );
    const applied = await add();
    expect(applied.status, await applied.clone().text()).toBe(201);
    const inserted = (await applied.json()).member;
    expect(inserted).toMatchObject({ subjectId: subject, note: draft.note });
    expect((await f.current(collection.id)).memberCount).toBe(5002);
    expect((await snapshot()).map((row) => row.member_id)).toEqual([
      ...ids.slice(0, 2501),
      inserted.id,
      ...ids.slice(2501),
    ]);
    expect((await (await add()).json()).member).toEqual(inserted);
    const moved = await f.commands.moveMember(f.owner.actor, collection.id, ids[5000]!, { after: null }, entryKey());
    expect(moved.value.id).toBe(ids[5000]!);
    const restored = await f.commands.restoreMember(
      f.owner.actor,
      collection.id,
      deleted.id,
      { deletionId: removed.value.deletionId, revision: removed.value.revision },
      entryKey(),
    );
    expect(restored.value).toMatchObject({ id: deleted.id, note: deleted.note, addedAt: deleted.addedAt });
    const source = await f.make();
    const selected = await f.add(source.id, subject, 'transferred occurrence');
    const transferred = await f.commands.transferMembers(
      f.owner.actor,
      source.id,
      {
        revision: (await f.current(source.id)).revision,
        memberIds: [selected.id],
        destinationCollectionId: collection.id,
        destinationRevision: (await f.current(collection.id)).revision,
        after: first.id,
      },
      entryKey(),
    );
    expect(transferred.value.members[0]).toMatchObject({
      id: selected.id,
      note: selected.note,
      addedAt: selected.addedAt,
    });
    expect(transferred.value.destination.memberCount).toBe(5004);
  } finally {
    await worker?.shutdown();
    await client?.close();
    await f.close();
  }
}, 180_000);
