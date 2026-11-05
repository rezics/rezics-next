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
const route = 0x7b20,
  collectionRoute = 0x6a10;
type Table = 'subject_collection' | 'subject_collection_version' | 'subject_collection_source_fence';
const version = () => ({
  route,
  subject_id: newId(route),
  collection_id: newId(collectionRoute),
  collection_route: collectionRoute,
  source_partition: partitionOf(collectionRoute),
  source_epoch: 3,
  source_position: '9007199254740993',
  multiplicity: 0,
  updated_at: '2026-10-27T00:00:00Z',
  transaction_id: newId(route),
});
const fence = () => {
  const { route: target, subject_id, multiplicity, ...source } = version();
  return { ...source, partition_no: partitionOf(target), terminal: false };
};
const insert = (table: Table, row: object) =>
  db.admin.query(
    `INSERT INTO library.${table} SELECT * FROM jsonb_populate_record(NULL::library.${table}, $1::jsonb)`,
    [JSON.stringify(row)],
  );
const update = (table: Table, collectionId: string, patch: Record<string, unknown>) =>
  db.admin.query(
    `UPDATE library.${table} SET ${Object.keys(patch)
      .map((key, i) => `${key}=$${i + 2}`)
      .join(',')}
   WHERE collection_id=$1`,
    [collectionId, ...Object.values(patch)],
  );
const rows = async (sql: string, values: unknown[]) => (await db.admin.query(sql, values)).rows;

test('listing source and target routes, complete stamps and reverse indexes are exact', async () => {
  for (const table of ['subject_collection_version', 'subject_collection_source_fence'] as const) {
    const row = table === 'subject_collection_version' ? version() : fence();
    for (const patch of [
      { collection_route: collectionRoute + 1 },
      { collection_route: -1 },
      { collection_route: 65536 },
      { source_partition: partitionOf(collectionRoute) + 1 },
      { source_partition: null },
      { source_epoch: 0 },
      { source_epoch: null },
      { source_position: '-1' },
      { source_position: null },
      { updated_at: null },
      { transaction_id: null },
    ]) {
      await expect(insert(table, { ...row, ...patch })).rejects.toMatchObject({
        code: expect.stringMatching(/^235(02|14)$/),
      });
    }
    const patches =
      table === 'subject_collection_version'
        ? [{ route: route + 1 }, { route: -1 }, { route: 65536 }, { subject_id: null }, { multiplicity: -1 }]
        : [{ partition_no: -1 }, { partition_no: 4096 }, { terminal: null }];
    for (const patch of patches) await expect(insert(table, { ...row, ...patch })).rejects.toThrow();
    for (const edge of [0, 65535])
      await insert(table, {
        ...row,
        collection_id: newId(edge),
        collection_route: edge,
        source_partition: partitionOf(edge),
        source_epoch: 1,
        source_position: '0',
        ...(table === 'subject_collection_version'
          ? { route: edge, subject_id: newId(edge) }
          : { partition_no: partitionOf(edge) }),
      });
  }
  const row = { ...version(), multiplicity: 1 };
  await insert('subject_collection', row);
  for (const patch of [
    { source_partition: null },
    { source_epoch: null },
    { source_position: null },
    { source_partition: 0 },
    { source_epoch: 0 },
    { source_position: '-1' },
  ])
    await expect(update('subject_collection', row.collection_id, patch)).rejects.toMatchObject({ code: '23514' });
  await update('subject_collection', row.collection_id, {
    source_partition: null,
    source_epoch: null,
    source_position: null,
  });
  const indexes = await db.admin.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='library'");
  for (const name of ['subject_collection_reverse', 'subject_collection_version_reverse'])
    expect(indexes.rows.find((index) => index.indexname === name)?.indexdef).toContain(
      '(collection_route, collection_id, route, subject_id)',
    );
  const columns = await db.admin.query(
    "SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema='library' AND table_name='subject_collection' AND column_name LIKE 'source_%'",
  );
  expect(columns.rows).toEqual(Array(3).fill({ column_default: null, is_nullable: 'YES' }));
});

test('versions and fences reject rebinding and regression but accept equal payloads and newer epochs', async () => {
  for (const table of ['subject_collection_version', 'subject_collection_source_fence'] as const) {
    const isVersion = table === 'subject_collection_version';
    const row = isVersion ? version() : fence();
    await insert(table, row);
    const identity = isVersion
      ? [{ route: route + 1, subject_id: newId(route + 1) }, { subject_id: newId(route) }, { multiplicity: 1 }]
      : [{ partition_no: partitionOf(route) + 1 }];
    for (const patch of [
      ...identity,
      { collection_id: newId(collectionRoute) },
      { source_partition: 0 },
      { collection_id: newId(0), collection_route: 0, source_partition: 0 },
      { source_epoch: 2, source_position: '9223372036854775807' },
      { source_position: '9007199254740992' },
    ])
      await expect(update(table, row.collection_id, patch)).rejects.toMatchObject({ code: '23514' });
    await update(table, row.collection_id, { updated_at: '2026-10-28T00:00:00Z', transaction_id: newId(route) });
    const payload = isVersion ? 'multiplicity' : 'terminal';
    const read = () =>
      rows(`SELECT source_epoch,source_position::text,${payload} FROM library.${table} WHERE collection_id=$1`, [
        row.collection_id,
      ]);
    expect(await read()).toEqual([
      { source_epoch: 3, source_position: row.source_position, [payload]: isVersion ? 0 : false },
    ]);
    await update(table, row.collection_id, { source_position: '9007199254740994', [payload]: isVersion ? 2 : false });
    await update(table, row.collection_id, { source_epoch: 4, source_position: '1', [payload]: isVersion ? 0 : true });
    if (!isVersion) {
      for (const patch of [{ terminal: false }, { terminal: false, source_epoch: 5, source_position: '0' }])
        await expect(update(table, row.collection_id, patch)).rejects.toMatchObject({ code: '23514' });
      await update(table, row.collection_id, { terminal: true });
    }
    expect(await read()).toEqual([{ source_epoch: 4, source_position: '1', [payload]: isVersion ? 0 : true }]);
  }
});

test('prepared legacy listing SQL still inserts updates and removes unstamped pairs before cutover', async () => {
  const input: Record<string, unknown> = {
    route,
    subject_id: newId(route),
    collection_id: newId(collectionRoute),
    collection_route: collectionRoute,
    time: '2026-10-27T00:00:00Z',
    transaction_id: newId(route),
    multiplicity: 2,
  };
  const keys: string[] = [];
  const text = (await Bun.file(new URL('../../src/library/listing-apply.sql', import.meta.url)).text()).replace(
    /(?<!:):([a-z_]+)/g,
    (_, key: string) => {
      if (!keys.includes(key)) keys.push(key);
      return `$${keys.indexOf(key) + 1}`;
    },
  );
  const client = await db.admin.connect();
  try {
    for (const [multiplicity, count, revision] of [
      [2, 1, 1],
      [3, 1, 2],
      [0, 0, 3],
    ]) {
      const result = await client.query({
        name: 'legacy-listing-apply',
        text,
        values: keys.map((key) => (key === 'multiplicity' ? multiplicity : input[key])),
      });
      expect(result.rows).toEqual([{ publicCollectionCount: count, revision }]);
      const pairs = await client.query(
        'SELECT multiplicity,source_partition,source_epoch,source_position FROM library.subject_collection WHERE subject_id=$1',
        [input.subject_id],
      );
      expect(pairs.rows).toEqual(
        multiplicity ? [{ multiplicity, source_partition: null, source_epoch: null, source_position: null }] : [],
      );
    }
    expect(
      (await client.query('SELECT * FROM library.subject_collection_version WHERE subject_id=$1', [input.subject_id]))
        .rows,
    ).toEqual([]);
  } finally {
    client.release();
  }
});
