import { afterAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { insertCollection, insertMember } from '../../src/library/collection-store.ts';
import { createListingSourceObserver, observeListingSource } from '../../src/library/listing-source-observer.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = new pg.Pool({ connectionString: url, max: 2 });
afterAll(async () => {
  await Promise.all([pool.end(), admin.end()]);
});
const route = 0x6a10,
  subjectId = newId(0x7b20);
const context = { transactionId: newId(route), time: '2026-10-28T00:00:00Z' };

async function collection(visibility: 'private' | 'unlisted' | 'public') {
  const id = newId(route);
  await insertCollection(
    admin,
    route,
    {
      id,
      curatorAccountId: newId(route),
      title: 'Source',
      description: 'Private description',
      visibility,
    },
    context,
  );
  for (let i = 0; i < 3; i++)
    await insertMember(
      admin,
      route,
      id,
      {
        id: newId(route),
        subjectId: i < 2 ? subjectId : newId(0x7b20),
        note: 'Private note',
        ordinalKey: `a${i}`,
      },
      context,
    );
  return id;
}

test('native listing truth uses Collection partition and preserves exact stamps for every source state', async () => {
  const position = 9007199254740993n;
  await admin.query('UPDATE core.partition SET epoch=3,position=$2 WHERE partition_no=$1', [
    partitionOf(route),
    position,
  ]);
  await admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partitionOf(0x7b20)]);
  const check = async (collectionId: string, multiplicity: number, currentlyPublic: boolean, everPublic: boolean) => {
    expect(await observeListingSource(pool, { subjectId, collectionId })).toEqual({
      subjectId,
      collectionId,
      collectionRoute: route,
      stamp: { partition: partitionOf(route), epoch: 3, position },
      multiplicity,
      currentlyPublic,
      everPublic,
    });
  };
  await check(await collection('private'), 0, false, false);
  await check(await collection('unlisted'), 0, false, false);
  const published = await collection('public');
  await check(published, 2, true, true);
  await admin.query("UPDATE library.collection SET visibility='private' WHERE route=$1 AND collection_id=$2", [
    route,
    published,
  ]);
  await check(published, 0, false, true);
  const deleted = await collection('public');
  await admin.query("UPDATE library.collection SET state='deleted' WHERE route=$1 AND collection_id=$2", [
    route,
    deleted,
  ]);
  await check(deleted, 0, false, true);
  const physical = await collection('public'),
    quiet = await collection('private');
  await admin.query('DELETE FROM library.collection_member WHERE route=$1 AND collection_id=ANY($2::uuid[])', [
    route,
    [physical, quiet],
  ]);
  await admin.query('DELETE FROM library.collection WHERE route=$1 AND collection_id=ANY($2::uuid[])', [
    route,
    [physical, quiet],
  ]);
  await check(physical, 0, false, true);
  await check(quiet, 0, false, false);
  await check(newId(route), 0, false, false);
});

test('current public truth is learned evidence before provenance backfill without source writes', async () => {
  const collectionId = await collection('public');
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    // Model a legacy public row whose bit has not been backfilled.
    await client.query("SET LOCAL session_replication_role='replica'");
    await client.query('UPDATE library.collection SET listing_ever_public=false WHERE route=$1 AND collection_id=$2', [
      route,
      collectionId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  expect(await observeListingSource(pool, { subjectId, collectionId })).toMatchObject({
    multiplicity: 2,
    currentlyPublic: true,
    everPublic: true,
  });
  const bit = await admin.query(
    'SELECT listing_ever_public FROM library.collection WHERE route=$1 AND collection_id=$2',
    [route, collectionId],
  );
  expect(bit.rows[0].listing_ever_public).toBe(false);
});

test('listing source validates both routed ids before checking out a client', async () => {
  let connects = 0;
  const invalidPool = {
    connect: async () => {
      connects++;
      throw new Error('Unexpected checkout');
    },
  } as unknown as Pool;
  const observe = createListingSourceObserver({ pool: invalidPool });
  for (const key of [
    { subjectId: 'invalid', collectionId: newId(route) },
    { subjectId, collectionId: 'invalid' },
  ]) {
    await expect(observe(key)).rejects.toBeInstanceOf(TypeError);
  }
  expect(connects).toBe(0);
});

test('listing source query failures roll back and release without returning zero', async () => {
  for (const failAt of ['partition', 'truth']) {
    const sql: string[] = [],
      failure = new Error(`${failAt} query failed`);
    const client = {
      query: async (text: string) => {
        sql.push(text);
        return { rows: [] };
      },
      release: () => sql.push('release'),
    };
    const observe = createListingSourceObserver({
      pool: { connect: async () => client } as unknown as Pool,
      source: {
        readPartition: async () => {
          if (failAt === 'partition') throw failure;
          return {
            partitionNo: partitionOf(route),
            node: 'local',
            writeState: 'active',
            movedTo: null,
            epoch: 1,
            position: 1n,
          };
        },
        readTruth: async () => {
          throw failure;
        },
      },
    });
    await expect(observe({ subjectId, collectionId: newId(route) })).rejects.toBe(failure);
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
    expect(sql.at(-1)).toBe('release');
  }
});
