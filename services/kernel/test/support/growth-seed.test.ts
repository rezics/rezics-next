import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from './growth.ts';
import { placement, seed, type Population } from './growth-seed.ts';
import { SEED_BATCH_BYTE_LIMIT, SEED_BATCH_ROW_LIMIT } from './growth-seed-batches.ts';

let database: GrowthDatabase;
let pool: GrowthDatabase['pool'];
const schemas = [
  'growth_seed_test',
  'growth_seed_cumulative_a',
  'growth_seed_cumulative_b',
  'growth_seed_write',
  'growth_seed_mutable_rows',
];
type MutablePopulation = { -readonly [Key in keyof Population]: Population[Key] };

beforeAll(async () => {
  database = await openGrowthDatabase();
  pool = database.pool;
  for (const schema of schemas) {
    await database.admin.query(`CREATE SCHEMA ${schema}`);
    await database.admin.query(`CREATE TABLE ${schema}.parent (
      route integer NOT NULL, id integer NOT NULL, payload jsonb NOT NULL DEFAULT '{}', PRIMARY KEY (route, id)
    )`);
    await database.admin.query(`CREATE TABLE ${schema}.child (
      route integer NOT NULL, id integer NOT NULL, parent_id integer NOT NULL, PRIMARY KEY (route, id),
      FOREIGN KEY (route, parent_id) REFERENCES ${schema}.parent (route, id)
    )`);
  }
  await database.admin.query(`CREATE TABLE growth_seed_test.padding (
    route integer NOT NULL, id integer NOT NULL, payload text NOT NULL, PRIMARY KEY (route, id)
  )`);
});

afterAll(async () => {
  for (const schema of schemas) await database.admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await database.close();
});

function rows(schema: string, name = schema): Population {
  return {
    name,
    hotPartition: 23,
    rows: ({ ordinal, route }) => ({
      [`${schema}.parent`]: [{ route, id: ordinal }],
      [`${schema}.child`]: [{ route, id: ordinal, parent_id: ordinal }],
    }),
  };
}

function spaceRevisionFamily(route: number, spaceId: string, revisionId: string, authorId: string) {
  return {
    'community.space': [
      {
        route,
        space_id: spaceId,
        state: 'active',
        head_revision_id: revisionId,
        created_at: '2026-11-12T00:00:00.000Z',
        creator: authorId,
      },
    ],
    'community.space_revision': [
      {
        route,
        space_id: spaceId,
        revision_id: revisionId,
        predecessor: null,
        title: 'Growth seed host',
        summary: '',
        created_at: '2026-11-12T00:00:00.000Z',
        author: authorId,
      },
    ],
  };
}

test('places the declared share of ordinals in the hot partition and spreads the rest elsewhere', () => {
  const population: Population = { name: 'placement', hotPartition: 9, hotShare: 0.5 };
  const values = Array.from({ length: 1_000 }, (_, ordinal) => placement(population, ordinal));
  expect(values.filter((value) => value.hot)).toHaveLength(500);
  expect(values.every((value) => value.hot === (value.route >>> 4 === 9))).toBe(true);
  expect(values).toEqual(Array.from({ length: 1_000 }, (_, ordinal) => placement(population, ordinal)));
});

test('inserts the rows of each ordinal range once, in table order, and refreshes planner statistics', async () => {
  const population = rows('growth_seed_test');
  await seed({ pool, admin: database.admin }, population, { from: 0, to: 20 });
  const parents = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM growth_seed_test.parent');
  const children = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM growth_seed_test.child');
  expect(parents.rows[0]!.count).toBe('20');
  expect(children.rows[0]!.count).toBe('20');
  const stats = await pool.query<{ reltuples: number }>(
    `SELECT reltuples FROM pg_class WHERE oid = 'growth_seed_test.parent'::regclass`,
  );
  expect(stats.rows[0]!.reltuples).toBe(20);
});

test('keeps a deferred Space head and revision in one transaction across row and byte splits', async () => {
  for (const split of ['rows', 'bytes'] as const) {
    const populationIdentity: Population = {
      name: `deferred-space-${split}`,
      hotPartition: 23,
      hotShare: 1,
      rows: () => ({}),
    };
    const paddingRoute = placement(populationIdentity, 0).route;
    const spaceRoute = placement(populationIdentity, 1).route;
    const spaceId = newId(spaceRoute);
    const revisionId = newId(spaceRoute);
    const authorId = newId(spaceRoute);
    const family = spaceRevisionFamily(spaceRoute, spaceId, revisionId, authorId);
    const emptyPadding = { route: paddingRoute, id: split === 'rows' ? 0 : 10_000, payload: '' };
    const paddingRows =
      split === 'rows'
        ? Array.from({ length: SEED_BATCH_ROW_LIMIT - 1 }, (_, id) => ({ ...emptyPadding, id }))
        : [
            {
              ...emptyPadding,
              payload: 'x'.repeat(
                SEED_BATCH_BYTE_LIMIT -
                  Buffer.byteLength(JSON.stringify(emptyPadding)) -
                  Buffer.byteLength(JSON.stringify(family['community.space'][0]!)) -
                  4,
              ),
            },
          ];
    const population: Population = {
      ...populationIdentity,
      rows: ({ ordinal, route }) =>
        ordinal === 0
          ? { 'growth_seed_test.padding': paddingRows }
          : ordinal === 1
            ? spaceRevisionFamily(route, spaceId, revisionId, authorId)
            : {},
    };

    await seed({ pool, admin: database.admin }, population, { from: 0, to: 2 });

    const persisted = await pool.query<{ head_revision_id: string; revision_id: string }>(
      `SELECT s.head_revision_id::text, r.revision_id::text
       FROM community.space s
       JOIN community.space_revision r
         ON r.route = s.route AND r.space_id = s.space_id AND r.revision_id = s.head_revision_id
       WHERE s.route = $1 AND s.space_id = $2`,
      [spaceRoute, spaceId],
    );
    expect(persisted.rows).toEqual([{ head_revision_id: revisionId, revision_id: revisionId }]);

    await pool.query('DELETE FROM community.space_revision WHERE route = $1 AND space_id = $2', [spaceRoute, spaceId]);
    await pool.query('DELETE FROM community.space WHERE route = $1 AND space_id = $2', [spaceRoute, spaceId]);
    await pool.query('DELETE FROM growth_seed_test.padding WHERE route = $1 AND id = ANY($2::integer[])', [
      paddingRoute,
      paddingRows.map(({ id }) => id),
    ]);
  }
});

test('grows cumulatively: seeding 0..8n after 0..n equals seeding 0..8n at once', async () => {
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_a', 'cumulative'), { from: 0, to: 10 });
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_a', 'cumulative'), { from: 10, to: 80 });
  await seed({ pool, admin: database.admin }, rows('growth_seed_cumulative_b', 'cumulative'), { from: 0, to: 80 });
  const counts = async (schema: string) =>
    pool.query<{ partition: number; count: string }>(
      `SELECT route / 16 AS partition, count(*)::int AS count FROM ${schema}.parent GROUP BY 1 ORDER BY 1`,
    );
  expect((await counts('growth_seed_cumulative_a')).rows).toEqual((await counts('growth_seed_cumulative_b')).rows);
});

test('seeds through a production write path when the population supplies write', async () => {
  let calls = 0;
  const population: Population = {
    name: 'write',
    hotPartition: 4,
    write: async ({ pool: writePool }, { ordinal, route }) => {
      calls++;
      await writePool.query('INSERT INTO growth_seed_write.parent (route, id) VALUES ($1, $2)', [route, ordinal]);
    },
  };
  await seed({ pool, admin: database.admin }, population, { from: 0, to: 12 });
  expect(calls).toBe(12);
  expect((await pool.query('SELECT count(*)::int AS count FROM growth_seed_write.parent')).rows[0]!.count).toBe(12);
});

test('keeps one admitted definition and range while concurrent writes are pending', async () => {
  const range = { from: 100, to: 108 };
  const original: Population = { name: 'mutable-write', hotPartition: 4, hotShare: 0.75 };
  const expected = Array.from({ length: 8 }, (_, offset) => placement(original, 100 + offset));
  const writes: ReturnType<typeof placement>[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  let signalStarted!: () => void;
  const fourStarted = new Promise<void>((resolve) => (signalStarted = resolve));
  let finishedRange: { from: number; to: number } | undefined;
  let replacementWrites = 0;
  let replacementFinishes = 0;
  const population: MutablePopulation = {
    ...original,
    write: async (_target, value) => {
      writes.push(value);
      if (writes.length === 4) signalStarted();
      await pending;
    },
    finish: async (_admin, value) => {
      finishedRange = value;
    },
  };
  const seeding = seed({ pool, admin: database.admin }, population, range);
  await fourStarted;
  population.name = 'changed';
  population.hotPartition = 11;
  population.hotShare = 0;
  population.write = async () => {
    replacementWrites++;
  };
  population.finish = async () => {
    replacementFinishes++;
  };
  range.from = 120;
  range.to = 104;
  release();
  await seeding;
  expect(writes).toEqual(expected);
  expect(replacementWrites).toBe(0);
  expect(replacementFinishes).toBe(0);
  expect(finishedRange).toEqual({ from: 100, to: 108 });
  expect(finishedRange).not.toBe(range);
});

test('keeps the admitted placement and rows callback when rows mutate the population', async () => {
  const original: Population = { name: 'mutable-rows', hotPartition: 7, hotShare: 0.5 };
  const expected = [placement(original, 210), placement(original, 211)];
  const placements: ReturnType<typeof placement>[] = [];
  let replacementRows = 0;
  let population!: MutablePopulation;
  population = {
    ...original,
    rows: (value) => {
      placements.push(value);
      if (value.ordinal === 210) {
        population.name = 'changed';
        population.hotPartition = 10;
        population.hotShare = 0;
        population.rows = ({ ordinal, route }) => {
          replacementRows++;
          return { 'growth_seed_mutable_rows.parent': [{ route, id: ordinal }] };
        };
      }
      return { 'growth_seed_mutable_rows.parent': [{ route: value.route, id: value.ordinal }] };
    },
  };
  await seed({ pool, admin: database.admin }, population, { from: 210, to: 212 });
  expect(placements).toEqual(expected);
  expect(replacementRows).toBe(0);
});

test('stops admitting production writes after failure and waits for admitted writes', async () => {
  const failure = new Error('write failed');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const ordinals: number[] = [];
  let finishCalls = 0;
  const population: Population = {
    name: 'failed-write',
    hotPartition: 4,
    write: async (_target, { ordinal }) => {
      ordinals.push(ordinal);
      if (ordinals.length === 4) signalStarted();
      if (ordinal === 0) throw failure;
      await pending;
    },
    finish: async () => {
      finishCalls++;
    },
  };
  const seeding = seed({ pool, admin: database.admin }, population, { from: 0, to: 8 });
  let settled = false;
  void seeding.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const settledBeforeRelease = settled;
  release();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await expect(seeding).rejects.toBe(failure);
  expect(settledBeforeRelease).toBe(false);
  expect(ordinals).toEqual([0, 1, 2, 3]);
  expect(finishCalls).toBe(0);
});

test('rejects rows whose columns differ within a table or name an invalid table', async () => {
  const mismatched: Population = {
    name: 'mismatched',
    hotPartition: 1,
    rows: ({ ordinal, route }) => ({ 'growth_seed_test.parent': [ordinal === 0 ? { route, id: ordinal } : { route }] }),
  };
  await expect(seed({ pool, admin: database.admin }, mismatched, { from: 0, to: 2 })).rejects.toThrow();
  const invalid: Population = { name: 'invalid', hotPartition: 1, rows: () => ({ 'bad-name.parent': [{ id: 1 }] }) };
  await expect(seed({ pool, admin: database.admin }, invalid, { from: 0, to: 1 })).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int AS count FROM growth_seed_test.parent')).rows[0]!.count).toBe(20);
});
