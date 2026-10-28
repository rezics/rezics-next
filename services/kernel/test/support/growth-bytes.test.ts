import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  checkGrowth,
  costOf,
  GrowthBoundError,
  medianCost,
  openGrowthDatabase,
  type GrowthCheck,
  type GrowthDatabase,
} from './growth.ts';
import { capture } from './growth-capture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_bytes_test';
const table = `${schema}.records`;
const bounds = { rows: 'constant', blocks: 'constant', statements: 'constant' } as const;
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY, payload text[] NOT NULL)`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test('counts prepared request values and protocol response payloads exactly', async () => {
  const database = db!;
  const query = 'SELECT $1::text AS ascii, $2::text AS multibyte, $3::bytea AS payload, $4::text AS missing';
  const namedQuery = 'SELECT $1::text AS value';
  const measured = await capture(database, async () => {
    await database.pool.query(query, ['abc', '雪', Buffer.from([0x10, 0x20, 0xff]), null]);
    await database.pool.query({ name: 'growth_bytes_named', text: namedQuery, values: ['x'] });
    await database.pool.query({ name: 'growth_bytes_named', text: namedQuery, values: ['雪'] });
  });

  expect(measured.capture.statements).toEqual([query, namedQuery, namedQuery]);
  expect(measured.capture.requestBytes).toEqual([
    Buffer.byteLength(query, 'utf8') + 3 + Buffer.byteLength('雪', 'utf8') + 3,
    Buffer.byteLength(namedQuery, 'utf8') + 1,
    Buffer.byteLength('雪', 'utf8'),
  ]);
  expect(measured.capture.responseBytes).toEqual([9, 1, Buffer.byteLength('雪', 'utf8')]);
  const cost = costOf(measured.capture);
  expect(cost.requestBytes).toBe(measured.capture.requestBytes!.reduce((sum, value) => sum + value, 0));
  expect(cost.responseBytes).toBe(13);

  const empty = costOf({ statements: [], plans: [] });
  expect(
    medianCost([
      {
        ...empty,
        requestBytes: 31,
        responseBytes: 13,
        backgroundStatements: 1,
        backgroundRequestBytes: 31,
        backgroundResponseBytes: 13,
      },
      {
        ...empty,
        requestBytes: 11,
        responseBytes: 7,
        backgroundStatements: 1,
        backgroundRequestBytes: 11,
        backgroundResponseBytes: 7,
      },
      {
        ...empty,
        requestBytes: 21,
        responseBytes: 9,
        backgroundStatements: 1,
        backgroundRequestBytes: 21,
        backgroundResponseBytes: 9,
      },
    ]),
  ).toMatchObject({
    requestBytes: 21,
    responseBytes: 9,
    backgroundRequestBytes: 21,
    backgroundResponseBytes: 9,
  });
});

test('records bytes per statement for every instrumented pool and separates background work', async () => {
  const database = db!;
  const libraryPool = database.openPool({ max: 1 });
  let startBackground!: () => void;
  let finishBackground!: () => void;
  const backgroundStarted = new Promise<void>((resolve) => (startBackground = resolve));
  const backgroundFinished = new Promise<void>((resolve) => (finishBackground = resolve));
  const backgroundWork = (async () => {
    await backgroundStarted;
    try {
      await database.pool.query('SELECT $1::text AS value', ['background']);
      await libraryPool.query('SELECT $1::text AS value', ['worker']);
    } finally {
      finishBackground();
    }
  })();

  const measured = await capture(database, async () => {
    await database.pool.query('SELECT $1::text AS value', ['foreground']);
    await libraryPool.query('SELECT $1::text AS value', ['library']);
    startBackground();
    await backgroundFinished;
  });
  await backgroundWork;

  expect(measured.capture.statements).toEqual(['SELECT $1::text AS value', 'SELECT $1::text AS value']);
  expect(measured.capture.requestBytes).toEqual([
    Buffer.byteLength('SELECT $1::text AS value', 'utf8') + Buffer.byteLength('foreground', 'utf8'),
    Buffer.byteLength('SELECT $1::text AS value', 'utf8') + Buffer.byteLength('library', 'utf8'),
  ]);
  expect(measured.capture.responseBytes).toEqual([10, 7]);
  expect(measured.capture.backgroundStatements).toEqual(['SELECT $1::text AS value', 'SELECT $1::text AS value']);
  expect(measured.capture.backgroundRequestBytes).toEqual([
    Buffer.byteLength('SELECT $1::text AS value', 'utf8') + Buffer.byteLength('background', 'utf8'),
    Buffer.byteLength('SELECT $1::text AS value', 'utf8') + Buffer.byteLength('worker', 'utf8'),
  ]);
  expect(measured.capture.backgroundResponseBytes).toEqual([10, 6]);
  expect(costOf(measured.capture)).toMatchObject({
    requestBytes: expect.any(Number),
    responseBytes: 17,
    backgroundRequestBytes:
      Buffer.byteLength('SELECT $1::text AS value', 'utf8') * 2 + Buffer.byteLength('backgroundworker', 'utf8'),
    backgroundResponseBytes: 16,
  });
});

async function reset(database: GrowthDatabase): Promise<void> {
  await database.admin.query(`TRUNCATE ${table}`);
  await database.admin.query(`INSERT INTO ${table} (id, payload) VALUES (1, ARRAY[]::text[])`);
}

function arrayCheck(byteBounds?: GrowthCheck['byteBounds']): GrowthCheck {
  return {
    name: 'one growing array row',
    scales: [1, 8, 64],
    repetitions: 1,
    bounds,
    ...(byteBounds === undefined ? {} : { byteBounds }),
    grow: async (growthDb, scale, previous) => {
      await growthDb.admin.query(
        `UPDATE ${table}
            SET payload = payload || array_fill('x'::text, ARRAY[$1::integer - $2::integer])
          WHERE id = 1`,
        [scale, previous],
      );
    },
    operation: async (growthDb) =>
      (await growthDb.pool.query(`SELECT payload FROM ${table} WHERE id = 1`)).rows[0]?.payload,
  };
}

test('enforces a declared response byte bound while checks without byte bounds remain unchanged', async () => {
  const database = db!;
  await reset(database);
  let error: unknown;
  try {
    await checkGrowth(database, arrayCheck({ responseBytes: 'constant' }));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GrowthBoundError);
  expect(error).toMatchObject({
    byteBounds: { responseBytes: 'constant' },
    violations: expect.arrayContaining([expect.objectContaining({ metric: 'responseBytes', bound: 'constant' })]),
  });
  const growthError = error as GrowthBoundError;
  expect(growthError.samples.map(({ cost }) => cost.responseBytes)).toEqual([3, 17, 129]);

  await reset(database);
  await expect(
    checkGrowth(database, {
      ...arrayCheck({ responseBytes: 'constant' }),
      rule: 'series',
      repetitions: 1,
    }),
  ).rejects.toMatchObject({
    name: 'GrowthBoundError',
    byteBounds: { responseBytes: 'constant' },
    message: expect.stringContaining('responseBytes violates constant growth bound'),
  });

  await reset(database);
  const report = await checkGrowth(database, arrayCheck());
  expect(report).not.toHaveProperty('byteBounds');
  expect(report.samples.map(({ cost }) => cost.responseBytes)).toEqual([3, 17, 129]);

  await reset(database);
  const overridden = await checkGrowth(database, {
    ...arrayCheck({ responseBytes: 'constant' }),
    slack: { responseBytes: { absolute: 0, relative: 50 } },
  });
  expect(overridden.byteBounds).toEqual({ responseBytes: 'constant' });
}, 60_000);
