import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DROP SCHEMA IF EXISTS growth_capture_test CASCADE');
  await db.admin.query('CREATE SCHEMA growth_capture_test');
  await db.admin.query('CREATE TABLE growth_capture_test.parent (id integer PRIMARY KEY)');
  await db.admin.query(
    'CREATE TABLE growth_capture_test.child (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES growth_capture_test.parent(id))',
  );
  await db.admin.query('INSERT INTO growth_capture_test.parent (id) VALUES (1)');
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query('DROP SCHEMA IF EXISTS growth_capture_test CASCADE');
  await db.close();
});

test('captures each application statement and its executed plan from the production pool', async () => {
  const database = db!;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query('BEGIN');
      await client.query('SELECT 41 AS answer');
      await client.query('SELECT 42 AS answer');
      await client.query('COMMIT');
      return 'done';
    }),
  );

  expect(result.value).toBe('done');
  expect(result.capture.statements).toEqual(['BEGIN', 'SELECT 41 AS answer', 'SELECT 42 AS answer', 'COMMIT']);
  expect(result.capture.plans).toHaveLength(2);
  for (const plan of result.capture.plans)
    expect(plan).toMatchObject({
      Plan: {
        'Shared Hit Blocks': expect.any(Number),
        'Actual Rows': expect.any(Number),
      },
    });
});

test('captures nested statements such as a foreign key check', async () => {
  const database = db!;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query('INSERT INTO growth_capture_test.child (id, parent_id) VALUES (1, 1)');
    }),
  );

  expect(result.capture.statements).toEqual(['INSERT INTO growth_capture_test.child (id, parent_id) VALUES (1, 1)']);
  expect(
    result.capture.plans.some(
      (plan) =>
        typeof plan === 'object' &&
        plan !== null &&
        'Query Text' in plan &&
        typeof plan['Query Text'] === 'string' &&
        plan['Query Text'].includes('growth_capture_test.parent'),
    ),
  ).toBe(true);
});

test('captures statements from every connection the operation checks out', async () => {
  const database = db!;
  const result = await capture(database, async () => {
    const first = await withConnection(database.pool, async (client) => {
      const { rows } = await client.query('SELECT 51 AS answer');
      return rows[0]?.answer;
    });
    const second = await withConnection(database.pool, async (client) => {
      const { rows } = await client.query('SELECT 52 AS answer');
      return rows[0]?.answer;
    });
    return [first, second];
  });

  expect(result.value).toEqual([51, 52]);
  expect(result.capture.statements).toEqual(['SELECT 51 AS answer', 'SELECT 52 AS answer']);
  expect(result.capture.plans).toHaveLength(2);
});

test('records nothing outside a capture and refuses overlapping captures', async () => {
  const database = db!;
  await withConnection(database.pool, (client) => client.query('SELECT 61 AS outside'));

  let startOperation!: () => void;
  let finishOperation!: () => void;
  const started = new Promise<void>((resolve) => {
    startOperation = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    finishOperation = resolve;
  });

  const activeCapture = capture(database, async () => {
    await withConnection(database.pool, (client) => client.query('SELECT 62 AS inside'));
    startOperation();
    await blocked;
  });
  await started;
  await expect(capture(database, async () => 'overlap')).rejects.toThrow(/already active/i);
  finishOperation();

  const result = await activeCapture;
  await withConnection(database.pool, (client) => client.query('SELECT 63 AS outside'));
  expect(result.capture.statements).toEqual(['SELECT 62 AS inside']);
  expect(result.capture.plans).toHaveLength(1);
});

test('fails at open when the database cannot report plans', async () => {
  const database = db!;
  const role = `growth_capture_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const password = Bun.randomUUIDv7();

  await database.admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  try {
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = password;
    await expect(openGrowthDatabase(url.toString())).rejects.toThrow(
      /auto_explain plans were not reported.*superuser test database/i,
    );
  } finally {
    await database.admin.query(`DROP ROLE "${role}"`);
  }
});
