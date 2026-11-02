import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient, QueryConfig } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { capture, captureMeasuredRun, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import type { Capture } from './growth-cost.ts';
import { statementOccurrences } from './growth-report.ts';
import { checkGrowth } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase | undefined;
let dbClosed = false;

function nativePlanEntries(capture: Capture) {
  return capture.plans.flatMap((document, planIndex) => {
    const roots = Array.isArray(document) ? document : [document];
    return roots.flatMap((root) => {
      if (typeof root !== 'object' || root === null || Array.isArray(root) || !('Plan' in root)) return [];
      const plan = root.Plan;
      if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) return [];
      return [
        {
          owner: capture.planStatements?.[planIndex],
          queryText: 'Query Text' in root && typeof root['Query Text'] === 'string' ? root['Query Text'] : undefined,
          plan: plan as Record<string, unknown>,
        },
      ];
    });
  });
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query('DROP SCHEMA IF EXISTS growth_capture_test CASCADE');
  await db.admin.query('CREATE SCHEMA growth_capture_test');
  await db.admin.query('CREATE TABLE growth_capture_test.lookup (id integer PRIMARY KEY)');
  await db.admin.query('INSERT INTO growth_capture_test.lookup (id) VALUES (1)');
  await db.admin.query('CREATE TABLE growth_capture_test.binding_rows (id integer PRIMARY KEY)');
  await db.admin.query('INSERT INTO growth_capture_test.binding_rows (id) VALUES (1), (2)');
  await db.admin.query('CREATE TABLE growth_capture_test.future_input (id integer PRIMARY KEY)');
  await db.admin.query('CREATE TABLE growth_capture_test.trigger_input (id integer PRIMARY KEY)');
  await db.admin.query('CREATE SEQUENCE growth_capture_test.retry_sequence');
  await db.admin.query('CREATE SEQUENCE growth_capture_test.failure_sequence');
  await db.admin.query(`
    CREATE FUNCTION growth_capture_test.serialization_retry() RETURNS integer
    LANGUAGE plpgsql AS $function$
    DECLARE attempt bigint;
    BEGIN
      attempt := nextval('growth_capture_test.retry_sequence');
      IF attempt = 1 THEN
        RAISE EXCEPTION 'serialization retry' USING ERRCODE = '40001';
      END IF;
      PERFORM id FROM growth_capture_test.lookup WHERE id = 1;
      RETURN 17;
    END
    $function$
  `);
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
  await db.admin.query(`
    CREATE FUNCTION growth_capture_test.observe_future_lookup() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    DECLARE matched integer;
    BEGIN
      EXECUTE format('SELECT id FROM growth_capture_test.future_input WHERE id = %s', NEW.id) INTO matched;
      RETURN NEW;
    END
    $function$
  `);
  await db.admin.query(`
    CREATE TRIGGER observe_future_lookup BEFORE INSERT ON growth_capture_test.future_input
    FOR EACH ROW EXECUTE FUNCTION growth_capture_test.observe_future_lookup()
  `);
  await db.admin.query(`
    CREATE FUNCTION growth_capture_test.fail_after_nested(wanted integer) RETURNS integer
    LANGUAGE plpgsql AS $function$
    DECLARE matched integer;
    BEGIN
      SELECT id INTO matched FROM growth_capture_test.binding_rows WHERE id = wanted;
      IF nextval('growth_capture_test.failure_sequence') = 1 THEN
        RAISE EXCEPTION 'failure after nested read' USING ERRCODE = '40001';
      END IF;
      RETURN matched;
    END
    $function$
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

async function duplicateThenRetry(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query('SAVEPOINT retry');
  await expect(client.query('INSERT INTO growth_capture_test.lookup (id) VALUES (1)')).rejects.toMatchObject({
    code: '23505',
  });
  await client.query('ROLLBACK TO SAVEPOINT retry');
  await client.query('DELETE FROM growth_capture_test.lookup WHERE id = 1');
  await client.query('INSERT INTO growth_capture_test.lookup (id) VALUES (1)');
  await client.query('RELEASE SAVEPOINT retry');
  await client.query('COMMIT');
}

test('a failed statement counts as executed work and carries its SQLSTATE', async () => {
  const database = db!;
  const result = await capture(database, () => withConnection(database.pool, duplicateThenRetry));
  const inserts = result.capture.statements.flatMap((text, index) =>
    text.startsWith('INSERT INTO growth_capture_test.lookup')
      ? [{ text, error: result.capture.statementErrors?.[index] }]
      : [],
  );
  expect(inserts).toEqual([
    { text: 'INSERT INTO growth_capture_test.lookup (id) VALUES (1)', error: '23505' },
    { text: 'INSERT INTO growth_capture_test.lookup (id) VALUES (1)', error: null },
  ]);
});

test('plans point to the queued statement occurrence that produced them', async () => {
  const database = db!;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      const first = client.query('SELECT 71 AS queued');
      const second = client.query('SELECT 72 AS queued');
      await Promise.all([first, second]);
    }),
  );
  expect(result.capture.statements).toEqual(['SELECT 71 AS queued', 'SELECT 72 AS queued']);
  expect(result.capture.planStatements).toEqual([0, 1]);
});

test('queued distinct simple statements retain their native plan rows and query text', async () => {
  const database = db!;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      const first = client.query<{ queued: number }>('SELECT 71 AS queued');
      const second = client.query<{ queued: number }>('SELECT 72 AS queued');
      return Promise.all([first, second]);
    }),
  );

  expect(result.value.map(({ rows }) => rows[0]?.queued)).toEqual([71, 72]);
  expect(
    nativePlanEntries(result.capture).map(({ owner, queryText, plan }) => [owner, queryText, plan['Actual Rows']]),
  ).toEqual([
    [0, 'SELECT 71 AS queued', 1],
    [1, 'SELECT 72 AS queued', 1],
  ]);
});

test('native plans follow dispatched occurrences across queued promise, callback, parameter and prepared queries', async () => {
  const database = db!;
  const query = 'SELECT id FROM growth_capture_test.binding_rows WHERE id <= $1::integer ORDER BY id';
  const missing = 'SELECT id FROM growth_capture_test.missing_queued_rows';
  const prepared = 'growth_capture_queued_named';
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      const firstPromise = client.query<{ id: number }>(query, [1]).then(({ rows }) => rows.map(({ id }) => id));
      const secondCallback = new Promise<number[]>((resolve, reject) => {
        client.query<{ id: number }>(query, [2], (error, response) => {
          if (error) reject(error);
          else resolve(response!.rows.map(({ id }) => id));
        });
      });
      const thirdPromise = client
        .query<{ id: number }>({ name: prepared, text: query, values: [1] })
        .then(({ rows }) => rows.map(({ id }) => id));
      const fourthCallback = new Promise<number[]>((resolve, reject) => {
        client.query<{ id: number }>({ name: prepared, text: query, values: [2] }, (error, response) => {
          if (error) reject(error);
          else resolve(response!.rows.map(({ id }) => id));
        });
      });
      const failedCallback = new Promise<string>((resolve, reject) => {
        client.query(missing, (error) => {
          if (error) {
            const code = (error as Error & { code?: unknown }).code;
            resolve(typeof code === 'string' ? code : 'unknown');
          } else reject(new Error('The queued missing-table query unexpectedly succeeded'));
        });
      });
      const afterFailure = client
        .query<{ after_failure: number }>('SELECT 55 AS after_failure')
        .then(({ rows }) => rows[0]?.after_failure);
      return Promise.all([firstPromise, secondCallback, thirdPromise, fourthCallback, failedCallback, afterFailure]);
    }),
  );

  expect(result.value).toEqual([[1], [1, 2], [1], [1, 2], '42P01', 55]);
  expect(result.capture.statements).toEqual([query, query, query, query, missing, 'SELECT 55 AS after_failure']);
  expect(result.capture.statementErrors).toEqual([null, null, null, null, '42P01', null]);
  expect(result.capture.plans).toHaveLength(5);
  expect(result.capture.planStatements).toEqual([0, 1, 2, 3, 5]);
  const entries = nativePlanEntries(result.capture);
  expect(entries.map(({ owner, queryText, plan }) => [owner, queryText, plan['Actual Rows']])).toEqual([
    [0, query, 1],
    [1, query, 2],
    [2, query, 1],
    [3, query, 2],
    [5, 'SELECT 55 AS after_failure', 1],
  ]);

  const occurrences = statementOccurrences(result.capture).statements;
  expect(occurrences.map(({ error, plans, rows }) => [error?.code ?? null, plans, rows])).toEqual([
    [null, [0], 1],
    [null, [1], 2],
    [null, [2], 1],
    [null, [3], 2],
    ['42P01', [], 0],
    [null, [4], 0],
  ]);
});

test('name-only prepared reuse reserves its own occurrence before the first queued Parse completes', async () => {
  const database = db!;
  const query = 'SELECT id FROM growth_capture_test.binding_rows WHERE id <= $1::integer ORDER BY id';
  const name = `growth_capture_name_only_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  // Installed pg accepts a name-only config; @types/pg still requires text even for an already prepared name.
  const reuse = (values: number[]) => ({ name, values }) as QueryConfig<number[]>;
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      // Hold dispatch so all three occurrences are recorded before the first named Parse reaches the server.
      const holding = client.query('SELECT pg_sleep(0.01)');
      const first = client.query<{ id: number }>({ name, text: query, values: [1] });
      const second = client.query<{ id: number }>(reuse([2]));
      const third = new Promise<number[]>((resolve, reject) => {
        client.query<{ id: number }>(reuse([1]), (error, response) => {
          if (error) reject(error);
          else resolve(response!.rows.map(({ id }) => id));
        });
      });
      const [, one, two, three] = await Promise.all([holding, first, second, third]);
      const later = await client.query<{ id: number }>(reuse([2]));
      return [one.rows.map(({ id }) => id), two.rows.map(({ id }) => id), three, later.rows.map(({ id }) => id)];
    }),
  );
  expect(result.value).toEqual([[1], [1, 2], [1], [1, 2]]);
  expect(result.capture.statements).toEqual(['SELECT pg_sleep(0.01)', query, query, query, query]);
  expect(result.capture.statementErrors).toEqual([null, null, null, null, null]);
  expect(result.capture.planStatements).toEqual([0, 1, 2, 3, 4]);
  expect(result.capture.plans).toHaveLength(5);
  expect(
    nativePlanEntries(result.capture)
      .slice(1)
      .map(({ owner, queryText, plan }) => [owner, queryText, plan['Actual Rows']]),
  ).toEqual([
    [1, query, 1],
    [2, query, 2],
    [3, query, 1],
    [4, query, 2],
  ]);
  expect(result.capture.requestBytes).toEqual([
    Buffer.byteLength('SELECT pg_sleep(0.01)'),
    Buffer.byteLength(query) + 1,
    1,
    1,
    1,
  ]);
  expect(result.capture.responseBytes?.slice(1)).toEqual([1, 2, 1, 2]);
  expect(statementOccurrences(result.capture).statements.map(({ plans }) => plans)).toEqual([[0], [1], [2], [3], [4]]);
});

test('nested plans from failed and successful same-SQL producers keep their own occurrence custody', async () => {
  const database = db!;
  await database.admin.query('ALTER SEQUENCE growth_capture_test.failure_sequence RESTART WITH 1');
  const query = 'SELECT growth_capture_test.fail_after_nested($1::integer) AS result';
  const result = await capture(
    database,
    () =>
      withConnection(database.pool, async (client) => {
        const failed = client.query<{ result: number }>(query, [99]).then(
          () => null,
          (error: Error & { code?: string }) => error.code ?? 'unknown',
        );
        const successful = client.query<{ result: number }>(query, [2]).then(({ rows }) => rows[0]?.result);
        return Promise.all([failed, successful]);
      }),
    { includeBackends: true },
  );

  expect(result.value).toEqual(['40001', 2]);
  expect(result.capture.statements).toEqual([query, query]);
  expect(result.capture.statementErrors).toEqual(['40001', null]);
  expect(result.capture.statementBackends).toHaveLength(2);
  expect(result.capture.planBackends).toHaveLength(result.capture.plans.length);
  const nested = nativePlanEntries(result.capture).filter(({ queryText }) =>
    queryText?.includes('growth_capture_test.binding_rows'),
  );
  expect(nested.map(({ owner, plan }) => [owner, plan['Actual Rows']])).toEqual([
    [0, 0],
    [1, 1],
  ]);
  const occurrences = statementOccurrences(result.capture).statements;
  expect(occurrences).toHaveLength(2);
  expect(occurrences[0]).toMatchObject({ index: 0, error: { code: '40001' }, plans: [0], rows: 0 });
  expect(occurrences[1]).toMatchObject({ index: 1, error: null, plans: expect.arrayContaining([1]), rows: 1 });
});

test('failed and unplanned statements retain backend and error details without plans', async () => {
  const database = db!;
  const result = await capture(
    database,
    () =>
      withConnection(database.pool, async (client) => {
        await expect(client.query('SELECT * FROM growth_capture_test.missing')).rejects.toMatchObject({
          code: '42P01',
        });
        await client.query("SET application_name = 'growth capture test'");
      }),
    { includeBackends: true },
  );
  const { statementOccurrences } = await import('./growth-report.ts');
  const occurrences = statementOccurrences(result.capture).statements;
  expect(occurrences).toHaveLength(2);
  expect(occurrences[0]).toMatchObject({ backend: expect.any(Number), error: { code: '42P01' }, plans: [] });
  expect(occurrences[0]!.error!.message).toContain('growth_capture_test.missing');
  expect(occurrences[1]).toMatchObject({ backend: expect.any(Number), error: null, plans: [] });
});

test('the same SQL keeps separate plans across a rolled back serialization attempt and committed retry', async () => {
  const database = db!;
  await database.admin.query('ALTER SEQUENCE growth_capture_test.retry_sequence RESTART WITH 1');
  const query = 'SELECT growth_capture_test.serialization_retry()';
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      await client.query('BEGIN');
      await expect(client.query(query)).rejects.toMatchObject({ code: '40001' });
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(query);
      await client.query('COMMIT');
    }),
  );
  const { statementOccurrences } = await import('./growth-report.ts');
  const occurrences = statementOccurrences(result.capture).statements.filter(({ statement }) => statement === query);
  expect(occurrences).toHaveLength(2);
  expect(occurrences.map(({ error, plans }) => ({ error: error?.code ?? null, plans }))).toEqual([
    { error: '40001', plans: [] },
    { error: null, plans: expect.arrayContaining([expect.any(Number)]) },
  ]);
  expect(occurrences[0]).toMatchObject({ rows: 0, blocks: 0 });
  expect(occurrences[1]!.rows).toBeGreaterThan(0);
  expect(occurrences[1]!.blocks).toBeGreaterThan(0);
});

test('a failed background statement counts in the background statements and carries its SQLSTATE', async () => {
  const database = db!;
  const pool = database.openPool({ max: 1 });
  let run!: () => void;
  let stop!: () => void;
  const started = new Promise<void>((resolve) => (run = resolve));
  const finished = new Promise<void>((resolve) => (stop = resolve));
  const worker = (async () => {
    await started;
    await withConnection(pool, duplicateThenRetry);
    stop();
  })();
  const result = await capture(database, async () => {
    run();
    await finished;
  });
  await worker;
  const inserts = result.capture.backgroundStatements!.flatMap((text, index) =>
    text.startsWith('INSERT INTO growth_capture_test.lookup')
      ? [{ text, error: result.capture.backgroundStatementErrors?.[index] }]
      : [],
  );
  expect(inserts).toEqual([
    { text: 'INSERT INTO growth_capture_test.lookup (id) VALUES (1)', error: '23505' },
    { text: 'INSERT INTO growth_capture_test.lookup (id) VALUES (1)', error: null },
  ]);
});

test('a growth report lists failed attempts by SQLSTATE at each scale', async () => {
  const database = db!;
  const reportCheck = {
    name: 'duplicate insert retry',
    scales: [1, 8, 64] as const,
    repetitions: 1,
    bounds: { rows: 'constant' as const, blocks: 'constant' as const, statements: 'constant' as const },
    grow: async () => {},
    operation: async (_database: GrowthDatabase, scale: number) =>
      withConnection(database.pool, async (client) => {
        await client.query('BEGIN');
        await client.query('SAVEPOINT retry');
        await expect(client.query('INSERT INTO growth_capture_test.lookup (id) VALUES (1)')).rejects.toMatchObject({
          code: '23505',
        });
        await client.query('ROLLBACK TO SAVEPOINT retry');
        for (let index = 0; index < scale; index++) await client.query('SELECT 1');
        await client.query('COMMIT');
      }),
  };
  await expect(checkGrowth(database, reportCheck)).rejects.toMatchObject({
    message: expect.stringContaining(
      'failed attempts by SQLSTATE at scale: 1 {"23505":1}, 8 {"23505":1}, 64 {"23505":1}',
    ),
  });
});

test('a measuring session pins the planner settings a capture depends on', async () => {
  const database = db!;
  const libraryPool = database.openPool({ max: 1 });
  const expected = {
    max_parallel_workers_per_gather: '0',
    jit: 'off',
    work_mem: '4MB',
    random_page_cost: '4',
    effective_cache_size: '4GB',
    effective_io_concurrency: '16',
    default_statistics_target: '100',
  };
  const query = `SELECT current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather,
                        current_setting('jit') AS jit,
                        current_setting('work_mem') AS work_mem,
                        current_setting('random_page_cost') AS random_page_cost,
                        current_setting('effective_cache_size') AS effective_cache_size,
                        current_setting('effective_io_concurrency') AS effective_io_concurrency,
                        current_setting('default_statistics_target') AS default_statistics_target`;

  for (const pool of [database.pool, libraryPool]) {
    const result = await capture(database, async () => (await pool.query(query)).rows[0]);
    expect(result.value).toEqual(expected);
    expect(result.capture.statements).toEqual([query]);
    expect(result.capture.plans).toHaveLength(1);
  }
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
  expect(
    result.capture.plans.flatMap((plan, index) =>
      typeof plan === 'object' &&
      plan !== null &&
      'Query Text' in plan &&
      typeof plan['Query Text'] === 'string' &&
      plan['Query Text'].includes('SELECT id FROM growth_capture_test.lookup WHERE id = NEW.id')
        ? [result.capture.planStatements?.[index]]
        : [],
    ),
  ).toEqual([0]);
});

test('a nested plan matching a queued future query stays with its actual trigger producer', async () => {
  const database = db!;
  const insert = 'INSERT INTO growth_capture_test.future_input (id) VALUES (1)';
  const future = 'SELECT id FROM growth_capture_test.future_input WHERE id = 1';
  const result = await capture(database, () =>
    withConnection(database.pool, async (client) => {
      const insertPromise = client.query(insert);
      const futurePromise = client.query<{ id: number }>(future);
      const [write, read] = await Promise.all([insertPromise, futurePromise]);
      return { inserted: write.rowCount, selected: read.rows.map(({ id }) => id) };
    }),
  );

  expect(result.value).toEqual({ inserted: 1, selected: [1] });
  expect(result.capture.statements).toEqual([insert, future]);
  expect(result.capture.statementErrors).toEqual([null, null]);
  expect(result.capture.requestBytes).toEqual([Buffer.byteLength(insert), Buffer.byteLength(future)]);
  expect(result.capture.responseBytes).toEqual([0, 1]);
  expect(result.capture.plans).toHaveLength(3);
  expect(result.capture.planStatements).toEqual([0, 0, 1]);

  const repeatedText = nativePlanEntries(result.capture).filter(({ queryText }) => queryText === future);
  expect(repeatedText.map(({ owner, plan }) => [owner, plan['Actual Rows']])).toEqual([
    [0, 0],
    [1, 1],
  ]);
  const occurrences = statementOccurrences(result.capture).statements;
  expect(occurrences[0]!.planDocuments).toHaveLength(2);
  expect(occurrences[0]!.planDocuments).toContainEqual(
    expect.objectContaining({
      'Query Text': future,
      Plan: expect.objectContaining({ 'Actual Rows': 0 }),
    }),
  );
  expect(occurrences[1]!.planDocuments).toEqual([
    expect.objectContaining({
      'Query Text': future,
      Plan: expect.objectContaining({ 'Actual Rows': 1 }),
    }),
  ]);
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

test('separate databases keep foreground, background, error, backend, plan and byte custody apart', async () => {
  const database = db!;
  const secondaryName = `growth_capture_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  await database.admin.query(`CREATE DATABASE "${secondaryName}"`);
  let secondary: GrowthDatabase | undefined;
  try {
    const secondaryUrl = new URL(database.url);
    secondaryUrl.pathname = `/${secondaryName}`;
    secondary = await openGrowthDatabase(secondaryUrl.toString());

    const mainName = new URL(database.url).pathname.slice(1);
    const foregroundSql = `SELECT current_database() AS database, 'primary'::text AS marker`;
    const missingSql = 'SELECT * FROM growth_capture_test.missing_cross_database';
    const afterSql = `SELECT current_database() AS database, 'after'::text AS marker`;
    const backgroundSql = `SELECT current_database() AS database, 'background'::text AS marker`;
    const secondarySql = `SELECT current_database() AS database, 'secondary'::text AS marker`;
    const backgroundPool = database.openPool({ max: 1 });
    let startBackground!: () => void;
    let finishBackground!: (value: { database: string; marker: string }) => void;
    const backgroundStart = new Promise<void>((resolve) => (startBackground = resolve));
    const backgroundFinished = new Promise<{ database: string; marker: string }>((resolve) => {
      finishBackground = resolve;
    });
    const backgroundWork = (async () => {
      await backgroundStart;
      const response = await backgroundPool.query<{ database: string; marker: string }>(backgroundSql);
      finishBackground(response.rows[0]!);
    })();

    const [primary, other] = await Promise.all([
      capture(
        database,
        async () => {
          const foreground = await database.pool.query<{ database: string; marker: string }>(foregroundSql);
          startBackground();
          await expect(database.pool.query(missingSql)).rejects.toMatchObject({ code: '42P01' });
          const after = await database.pool.query<{ database: string; marker: string }>(afterSql);
          const background = await backgroundFinished;
          return { foreground: foreground.rows[0], after: after.rows[0], background };
        },
        { includeBackends: true },
      ),
      capture(
        secondary,
        async () => (await secondary!.pool.query<{ database: string; marker: string }>(secondarySql)).rows[0],
        { includeBackends: true },
      ),
    ]);
    await backgroundWork;

    expect(primary.value).toEqual({
      foreground: { database: mainName, marker: 'primary' },
      after: { database: mainName, marker: 'after' },
      background: { database: mainName, marker: 'background' },
    });
    expect(other.value).toEqual({ database: secondaryName, marker: 'secondary' });
    expect(primary.capture.statements).toEqual([foregroundSql, missingSql, afterSql]);
    expect(primary.capture.statementErrors).toEqual([null, '42P01', null]);
    expect(primary.capture.planStatements).toEqual([0, 2]);
    expect(primary.capture.requestBytes).toEqual(
      [foregroundSql, missingSql, afterSql].map((sql) => Buffer.byteLength(sql, 'utf8')),
    );
    expect(primary.capture.responseBytes).toEqual([
      Buffer.byteLength(mainName, 'utf8') + Buffer.byteLength('primary', 'utf8'),
      0,
      Buffer.byteLength(mainName, 'utf8') + Buffer.byteLength('after', 'utf8'),
    ]);
    expect(primary.capture.backgroundStatements).toEqual([backgroundSql]);
    expect(primary.capture.backgroundPlanStatements).toEqual([0]);
    expect(primary.capture.backgroundRequestBytes).toEqual([Buffer.byteLength(backgroundSql, 'utf8')]);
    expect(primary.capture.backgroundResponseBytes).toEqual([
      Buffer.byteLength(mainName, 'utf8') + Buffer.byteLength('background', 'utf8'),
    ]);
    expect(primary.capture.statementBackends).toHaveLength(3);
    expect(primary.capture.planBackends).toHaveLength(2);
    expect(primary.capture.backgroundStatementBackends).toHaveLength(1);
    expect(primary.capture.backgroundPlanBackends).toEqual(primary.capture.backgroundStatementBackends);
    expect(other.capture.statements).toEqual([secondarySql]);
    expect(other.capture.planStatements).toEqual([0]);
    expect(other.capture.requestBytes).toEqual([Buffer.byteLength(secondarySql, 'utf8')]);
    expect(other.capture.responseBytes).toEqual([
      Buffer.byteLength(secondaryName, 'utf8') + Buffer.byteLength('secondary', 'utf8'),
    ]);
    expect(other.capture.statementBackends).toEqual(other.capture.planBackends);
    expect(
      new Set([
        primary.capture.statementBackends![0],
        primary.capture.backgroundStatementBackends![0],
        other.capture.statementBackends![0],
      ]).size,
    ).toBe(3);
    expect(nativePlanEntries(primary.capture).map(({ owner, queryText }) => [owner, queryText])).toEqual([
      [0, foregroundSql],
      [2, afterSql],
    ]);
    expect(nativePlanEntries(primary.capture).map(({ queryText }) => queryText)).not.toContain(secondarySql);
    expect(nativePlanEntries(other.capture).map(({ owner, queryText }) => [owner, queryText])).toEqual([
      [0, secondarySql],
    ]);

    const primaryOccurrences = statementOccurrences(primary.capture);
    expect(
      primaryOccurrences.statements.map(({ backend, error, plans }) => [backend, error?.code ?? null, plans]),
    ).toEqual([
      [primary.capture.statementBackends![0], null, [0]],
      [primary.capture.statementBackends![1], '42P01', []],
      [primary.capture.statementBackends![2], null, [1]],
    ]);
    expect(primaryOccurrences.backgroundStatements).toMatchObject([
      { index: 0, backend: primary.capture.backgroundStatementBackends![0], error: null, plans: [0] },
    ]);
    expect(statementOccurrences(other.capture).statements).toMatchObject([
      { index: 0, backend: other.capture.statementBackends![0], error: null, plans: [0] },
    ]);
  } finally {
    await secondary?.close();
    await database.admin.query(`DROP DATABASE "${secondaryName}"`);
  }
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

test('a capture records the statements of instrumented pools only, not admin', async () => {
  const database = db!;
  const result = await capture(database, async () => {
    await database.admin.query('SELECT 64 AS seeding');
    await withConnection(database.pool, (client) => client.query('SELECT 65 AS application'));
  });
  expect(result.capture.statements).toEqual(['SELECT 65 AS application']);
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

test('measured-run write discovery records schema-qualified ModifyTable targets', async () => {
  const database = db!;
  const measured = await captureMeasuredRun(() =>
    capture(database, () =>
      withConnection(database.pool, (client) =>
        client.query('INSERT INTO growth_capture_test.trigger_input (id) VALUES (2)'),
      ),
    ),
  );
  expect(measured.writes.get(database)).toEqual(new Set(['growth_capture_test.trigger_input']));
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
