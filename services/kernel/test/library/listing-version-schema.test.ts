import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId, partitionOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('listing versions preserve bigint order and immutable source bindings before pair cutover', async () => {
  const route = 0x7b20,
    collectionRoute = 0x6a10,
    subjectId = newId(route),
    collectionId = newId(collectionRoute),
    position = 9007199254740993n;
  await db.admin.query(
    `INSERT INTO library.subject_collection_version(route,subject_id,collection_id,collection_route,source_partition,source_epoch,source_position,multiplicity,updated_at,transaction_id) VALUES($1,$2,$3,$4,$5,3,$6,0,'2026-10-27T00:00:00Z',$7)`,
    [route, subjectId, collectionId, collectionRoute, partitionOf(collectionRoute), position.toString(), newId(route)],
  );
  const update = (epoch: number, pos: string, multiplicity: number) =>
    db.admin.query(
      'UPDATE library.subject_collection_version SET source_epoch=$4,source_position=$5,multiplicity=$6 WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
      [route, subjectId, collectionId, epoch, pos, multiplicity],
    );
  await expect(update(3, (position - 1n).toString(), 1)).rejects.toThrow();
  await expect(update(3, position.toString(), 1)).rejects.toThrow();
  const row = (
    await db.admin.query(
      'SELECT source_position::text AS position,multiplicity FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
      [route, subjectId, collectionId],
    )
  ).rows[0];
  expect(row).toEqual({ position: position.toString(), multiplicity: 0 });
  await update(4, '1', 1);
  expect(
    (
      await db.admin.query(
        'SELECT source_epoch,multiplicity FROM library.subject_collection_version WHERE route=$1 AND subject_id=$2 AND collection_id=$3',
        [route, subjectId, collectionId],
      )
    ).rows[0],
  ).toEqual({ source_epoch: 4, multiplicity: 1 });
});
