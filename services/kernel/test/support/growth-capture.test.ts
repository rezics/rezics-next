import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase | undefined;
let dbClosed = false;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DROP SCHEMA IF EXISTS growth_capture_test CASCADE');
  await db.admin.query('CREATE SCHEMA growth_capture_test');
  await db.admin.query('CREATE TABLE growth_capture_test.lookup (id integer PRIMARY KEY)');
  await db.admin.query('INSERT INTO growth_capture_test.lookup (id) VALUES (1)');
  await db.admin.query('CREATE TABLE growth_capture_test.trigger_input (id integer PRIMARY KEY)');
  await db.admin.query(`
    CREATE FUNCTION growth_capture_test.observe_insert() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      PERFORM id FROM growth_capture_test.lookup WHERE id = NEW.id;
      RETURN NEW;
    END
    $function$
  `);
  await db.admin.query(`
    CREATE TRIGGER observe_insert AFTER INSERT ON growth_capture_test.trigger_input
    FOR EACH ROW EXECUTE FUNCTION growth_capture_test.observe_insert()
  `);
});

afterAll(async () => {
  if (!db || dbClosed) return;
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

test('captures nested statements run by a trigger function', async () => {
  const database = db!;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query('INSERT INTO growth_capture_test.trigger_input (id) VALUES (1)');
    }),
  );

  expect(result.capture.statements).toEqual(['INSERT INTO growth_capture_test.trigger_input (id) VALUES (1)']);
  expect(
    result.capture.plans.some(
      (plan) =>
        typeof plan === 'object' &&
        plan !== null &&
        'Query Text' in plan &&
        typeof plan['Query Text'] === 'string' &&
        plan['Query Text'].includes('SELECT id FROM growth_capture_test.lookup WHERE id = NEW.id'),
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

async function explainThreshold(client: Pick<PoolClient, 'query'>): Promise<string> {
  const result = await client.query<{
    'auto_explain.log_min_duration': string;
  }>('SHOW auto_explain.log_min_duration');
  return result.rows[0]!['auto_explain.log_min_duration'];
}

test('an instrumented connection explains statements only while a capture is active', async () => {
  const database = db!;
  await withConnection(database.pool, async (client) => {
    expect(await explainThreshold(client)).toBe('-1');
    const inside = await capture(database, async () => {
      const threshold = await explainThreshold(client);
      await client.query('SELECT 81 AS answer');
      return threshold;
    });
    expect(inside.value).toBe('0');
    expect(inside.capture.statements).toEqual(['SHOW auto_explain.log_min_duration', 'SELECT 81 AS answer']);
    expect(inside.capture.plans).toHaveLength(1);
    expect(await explainThreshold(client)).toBe('-1');
  });

  const libraryPool = database.openPool({ max: 1 });
  expect(await explainThreshold(libraryPool)).toBe('-1');
  const library = await capture(database, () => explainThreshold(libraryPool));
  expect(library.value).toBe('0');

  // A connection first used during a capture starts in the right state, and a capture that ends releases it.
  const opened = await capture(database, () => withConnection(database.pool, (client) => explainThreshold(client)));
  expect(opened.value).toBe('0');
  await withConnection(database.pool, async (client) => expect(await explainThreshold(client)).toBe('-1'));
});

test("a rolled-back switch is restored before the connection's next statement", async () => {
  const database = db!;

  // The switch on runs inside a transaction that is rolled back inside the capture.
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN');
    const inside = await capture(database, async () => {
      const first = await explainThreshold(client);
      await client.query('ROLLBACK');
      const second = await explainThreshold(client);
      await client.query('SELECT 91 AS answer');
      return [first, second];
    });
    expect(inside.value).toEqual(['0', '0']);
    expect(inside.capture.plans).toHaveLength(1);
    expect(await explainThreshold(client)).toBe('-1');
  });

  // The switch on runs after a savepoint that is rolled back to.
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN');
    await client.query('SAVEPOINT switch');
    const inside = await capture(database, async () => {
      const first = await explainThreshold(client);
      await client.query('ROLLBACK TO SAVEPOINT switch');
      const second = await explainThreshold(client);
      await client.query('SELECT 92 AS answer');
      return [first, second];
    });
    expect(inside.value).toEqual(['0', '0']);
    expect(inside.capture.plans).toHaveLength(1);
    await client.query('COMMIT');
    expect(await explainThreshold(client)).toBe('-1');
  });

  // The switch off runs inside a transaction opened during the capture and rolled back outside it.
  await withConnection(database.pool, async (client) => {
    await capture(database, async () => {
      await client.query('BEGIN');
      await client.query('SELECT 93 AS answer');
    });
    expect(await explainThreshold(client)).toBe('-1');
    await client.query('ROLLBACK');
    expect(await explainThreshold(client)).toBe('-1');
  });

  // A failed statement aborts the transaction; the rollback that follows undoes the switch.
  await withConnection(database.pool, async (client) => {
    await client.query('BEGIN');
    const inside = await capture(database, async () => {
      const first = await explainThreshold(client);
      await expect(client.query('SELECT 1 / 0')).rejects.toThrow();
      await client.query('ROLLBACK');
      return [first, await explainThreshold(client)];
    });
    expect(inside.value).toEqual(['0', '0']);
  });
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

test('captures and closes an extra library pool with the production pool', async () => {
  const database = db!;
  const libraryPool = database.openPool({ max: 2 });
  const result = await capture(database, async () => {
    await withConnection(database.pool, (client) => client.query('SELECT 71 AS answer'));
    await libraryPool.query('SELECT 72 AS answer');
  });

  expect(result.capture.statements).toEqual(['SELECT 71 AS answer', 'SELECT 72 AS answer']);
  expect(result.capture.plans).toHaveLength(2);

  await database.admin.query('DROP SCHEMA IF EXISTS growth_capture_test CASCADE');
  await database.close();
  dbClosed = true;
  await expect(libraryPool.query('SELECT 73 AS answer')).rejects.toThrow();
});
