import { afterAll, beforeAll, expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { PROVIDER_REVIEW_PROJECTED, providerReviewProjection } from '../../src/semantic/provider-review-queue.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { attributionFixture, source } from './support/source-record-attribution.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('provider relay commits copied roles at its receiving position and replays the same origins', async () => {
  const f = await attributionFixture(db);
  const provider = `queue_${crypto.randomUUID().slice(0, 8)}`;
  let book: Awaited<ReturnType<typeof f.create>>;
  do {
    book = await f.create(source(crypto.randomUUID(), provider));
  } while (partitionOf(routeOf(book.id)!) === 0);
  const candidate = await f.propose(book.id, book.origin);
  const route = routeOf(book.id)!;
  const home = partitionOf(route);
  const projection = providerReviewProjection(db.pool);
  const original = async () =>
    (
      await db.admin.query(
        `SELECT k.recorded_transaction_id AS tx,b.position,r.account_id,r.role,r.origin_key
       FROM semantic.provider_review_queue_key k
       JOIN editorial.write_basis b ON b.partition_no=$1 AND b.transaction_id=k.recorded_transaction_id
       JOIN semantic.erasure_source_record r ON r.partition_no=$1 AND r.store='provider_review_queue_key'
         AND r.record_key=k.erasure_key AND r.source_transaction_id=b.transaction_id AND r.source_position=b.position
       WHERE k.route=$2 AND k.source=$3 AND k.subject_id=$4 AND k.candidate_id=$5 ORDER BY r.account_id,r.role`,
        [home, route, provider, book.id, candidate],
      )
    ).rows;
  const sourceRoles = await original();
  expect(sourceRoles.length).toBeGreaterThan(0);
  for (const role of sourceRoles) expect(role.origin_key).toBe(`${role.tx}/${role.position}`);

  const received = async () =>
    (
      await db.admin.query(
        `SELECT e.recorded_transaction_id AS tx,b.position,r.account_id,r.role,r.origin_key
       FROM semantic.provider_review_queue_entry e
       JOIN editorial.write_basis b ON b.partition_no=0 AND b.transaction_id=e.recorded_transaction_id
       JOIN semantic.erasure_source_commit sc USING(partition_no,transaction_id,epoch,position)
       JOIN core.outbox o ON o.partition_no=0 AND o.epoch=b.epoch AND o.position=b.position AND o.type=$4
       JOIN semantic.erasure_source_record r ON r.partition_no=0 AND r.store='provider_review_queue_entry'
         AND r.record_key=e.erasure_key AND r.source_transaction_id=b.transaction_id
         AND r.source_position=b.position AND r.delivery_position=b.position
       WHERE e.route=0 AND e.source=$1 AND e.subject_id=$2 AND e.candidate_id=$3
         AND e.xmin=b.xmin AND sc.xmin=b.xmin AND o.xmin=b.xmin AND r.xmin=b.xmin ORDER BY r.account_id,r.role`,
        [provider, book.id, candidate, PROVIDER_REVIEW_PROJECTED],
      )
    ).rows;
  expect((await projection.run(home)).status).toBe('read');
  const receipt = await received();
  expect(receipt.map(({ account_id, role }) => [account_id, role])).toEqual(
    sourceRoles.map(({ account_id, role }) => [account_id, role]),
  );
  for (const role of receipt) {
    expect(role.tx).not.toBe(sourceRoles[0]!.tx);
    expect(role.origin_key).toBe(`${role.tx}/${role.position}`);
  }

  // Replay the interval after the receiving commit and before the source-home acknowledgement.
  expect(
    (
      await db.admin.query(
        `UPDATE semantic.provider_review_queue_key SET published=false
     WHERE route=$1 AND source=$2 AND subject_id=$3 AND candidate_id=$4 AND published`,
        [route, provider, book.id, candidate],
      )
    ).rowCount,
  ).toBe(1);
  const replay = await projection.run(home);
  expect(replay.status).toBe('read');
  const progress = await db.admin.query(
    `SELECT k.published,c.position>k.captured_position AS advanced FROM semantic.provider_review_queue_key k
     JOIN core.consumer_checkpoint c ON c.partition_no=$1 AND c.consumer=$2
     WHERE k.route=$3 AND k.source=$4 AND k.subject_id=$5 AND k.candidate_id=$6`,
    [home, projection.consumer, route, provider, book.id, candidate],
  );
  expect(progress.rows).toEqual([{ published: true, advanced: true }]);
  expect(await received()).toEqual(receipt);
  expect(await original()).toEqual(sourceRoles);
  // An authentic foreign transaction cannot stand in for this home's command fence.
  await expect(
    db.admin.query(
      `INSERT INTO semantic.erasure_source_commit(partition_no,transaction_id,epoch,position)
     SELECT partition_no,$1,epoch,position+1 FROM core.partition WHERE partition_no=0`,
      [sourceRoles[0]!.tx],
    ),
  ).rejects.toMatchObject({ code: '23514', message: 'Semantic Source receipt lacks same-command native custody' });
  await expect(
    db.admin.query('SELECT semantic.erasure_original_role_position(0,$1)', [sourceRoles[0]!.tx]),
  ).rejects.toMatchObject({ code: '23514' });
}, 120_000);
