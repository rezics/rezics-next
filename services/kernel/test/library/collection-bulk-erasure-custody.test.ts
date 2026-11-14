import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import bulkTarget from '../../src/library/erasure-owned-bulk-target.sql';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('unrelated local bulk cleanup advances while a remote receipt waits for History custody', async () => {
  const route = 0x1300;
  const accountId = newId(route);
  const localOperationId = newId(route);
  const remoteOperationId = newId(route);
  const localSubjectId = newId(route);
  const remoteSubjectId = newId(route);
  const remoteCollectionId = newId(0x2500);
  const now = new Date();
  const expiration = new Date(now.getTime() + 86_400_000);
  const resultsExpiration = new Date(expiration.getTime() + 86_400_000);

  for (const [operationId, request] of [
    [localOperationId, { action: 'set_status', state: 'completed', selection: { kind: 'explicit' } }],
    [
      remoteOperationId,
      { action: 'add_to_collection', collectionId: remoteCollectionId, selection: { kind: 'explicit' } },
    ],
  ] as const) {
    await db.admin.query(
      `INSERT INTO library.bulk_operation
        (route,operation_id,account_id,request,initiator,creation_receipt,source_digest,target_count,phase,
         admitted_at,expires_at,results_expire_at)
       VALUES($1,$2,$3,$4::jsonb,'{}','{}',$5,1,'applying',$6,$7,$8)`,
      [route, operationId, accountId, JSON.stringify(request), 'ef'.repeat(32), now, expiration, resultsExpiration],
    );
  }
  for (const [operationId, ordinal, subjectId, target] of [
    [localOperationId, 0, localSubjectId, { kind: 'subject' }],
    [remoteOperationId, 0, remoteSubjectId, { kind: 'subject', collectionId: remoteCollectionId }],
  ] as const) {
    await db.admin.query(
      `INSERT INTO library.bulk_target
        (route,operation_id,ordinal,account_id,subject_id,target_kind,target,source_digest,receipt,
         created_transaction_id,state,chunk_index)
       VALUES($1,$2,$3,$4,$5,'subject',$6::jsonb,$7,$8::jsonb,$9,'pending',0)`,
      [
        route,
        operationId,
        ordinal,
        accountId,
        subjectId,
        JSON.stringify(target),
        'ef'.repeat(32),
        JSON.stringify({
          partition: 0x250,
          principalKind: 'account',
          principalId: accountId,
          commandKind: 'library.collectionBulk.target',
          key: `${operationId}:0`,
          digest: 'cd'.repeat(32),
        }),
        newId(route),
      ],
    );
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const localPage = await bulkTarget.run(client, { route, account_id: accountId, settled: '[]' });
    await client.query('COMMIT');
    expect(localPage).toHaveLength(1);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect(
    (
      await db.admin.query(
        'SELECT operation_id FROM library.bulk_target WHERE route=$1 AND account_id=$2 ORDER BY operation_id',
        [route, accountId],
      )
    ).rows.map((row) => row.operation_id),
  ).toEqual([remoteOperationId]);

  const retry = await db.pool.connect();
  try {
    await retry.query('BEGIN');
    const remotePage = await bulkTarget.run(retry, {
      route,
      account_id: accountId,
      settled: JSON.stringify([{ operation_id: remoteOperationId, ordinal: '0' }]),
    });
    await retry.query('COMMIT');
    expect(remotePage).toHaveLength(1);
  } catch (error) {
    await retry.query('ROLLBACK');
    throw error;
  } finally {
    retry.release();
  }
  expect(
    (await db.admin.query('SELECT 1 FROM library.bulk_target WHERE route=$1 AND account_id=$2', [route, accountId]))
      .rows,
  ).toEqual([]);
});
