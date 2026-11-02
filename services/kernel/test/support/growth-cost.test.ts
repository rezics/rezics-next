import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import { costOf, isControlStatement, medianCost, type Cost } from './growth-cost.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const client = new pg.Client({ connectionString: databaseUrl });
let growthDatabase: GrowthDatabase | undefined;

type PlanNode = { 'Node Type'?: string; Plans?: PlanNode[]; [key: string]: unknown };

beforeAll(async () => {
  await client.connect();
  growthDatabase = await openGrowthDatabase(databaseUrl);
  await client.query('DROP SCHEMA IF EXISTS growth_cost_test CASCADE');
  await client.query(`
    CREATE SCHEMA growth_cost_test;
    CREATE TABLE growth_cost_test.seq_rows (value integer NOT NULL);
    INSERT INTO growth_cost_test.seq_rows SELECT generate_series(1, 100);
    CREATE TABLE growth_cost_test.loop_outer (lookup_id integer NOT NULL);
    INSERT INTO growth_cost_test.loop_outer VALUES (1), (2), (3), (4), (5);
    CREATE TABLE growth_cost_test.loop_inner (id integer PRIMARY KEY, payload text NOT NULL);
    INSERT INTO growth_cost_test.loop_inner
      SELECT value, 'payload' FROM generate_series(1, 100) AS value;
    CREATE TABLE growth_cost_test.cte_target (id integer NOT NULL);
    INSERT INTO growth_cost_test.cte_target VALUES (1);
    CREATE TABLE growth_cost_test.native_nested (id integer NOT NULL);
    INSERT INTO growth_cost_test.native_nested SELECT generate_series(1, 500);
    CREATE TABLE growth_cost_test.native_outer (id integer NOT NULL);
    CREATE FUNCTION growth_cost_test.read_nested() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE matched integer;
      BEGIN
        SELECT count(*) INTO matched FROM growth_cost_test.native_nested WHERE id < NEW.id;
        RETURN NEW;
      END $$;
    CREATE TRIGGER read_nested AFTER INSERT ON growth_cost_test.native_outer
      FOR EACH ROW EXECUTE FUNCTION growth_cost_test.read_nested();
    ANALYZE growth_cost_test.seq_rows;
    ANALYZE growth_cost_test.loop_outer;
    ANALYZE growth_cost_test.loop_inner;
    ANALYZE growth_cost_test.cte_target;
  `);
});

afterAll(async () => {
  try {
    await client.query('DROP SCHEMA IF EXISTS growth_cost_test CASCADE');
  } finally {
    await Promise.all([growthDatabase?.close(), client.end()]);
  }
});

async function explain(statement: string): Promise<unknown> {
  const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${statement}`,
  );
  const document = rows[0]?.['QUERY PLAN'];
  if (!document) throw new Error('EXPLAIN returned no plan');
  return document;
}

function rootOf(document: unknown): PlanNode {
  const root = (document as { Plan?: PlanNode }[])[0]?.Plan;
  if (!root) throw new Error('EXPLAIN returned no root plan');
  return root;
}

function findNode(root: PlanNode, nodeType: string): PlanNode | undefined {
  if (root['Node Type'] === nodeType) return root;
  for (const child of root.Plans ?? []) {
    const found = findNode(child, nodeType);
    if (found) return found;
  }
  return undefined;
}

test('cost keeps native nested relation work from its exact client occurrence', async () => {
  const database = growthDatabase!;
  const statement = 'INSERT INTO growth_cost_test.native_outer (id) VALUES (250)';
  const measured = await capture(database, () =>
    withConnection(database.pool, (connection) => connection.query(statement)),
  );
  const nestedPlanIndex = measured.capture.plans.findIndex((document) => {
    const entries = Array.isArray(document) ? document : [document];
    return entries.some(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        'Query Text' in entry &&
        typeof entry['Query Text'] === 'string' &&
        entry['Query Text'].includes('growth_cost_test.native_nested'),
    );
  });

  expect(measured.capture.statements).toEqual([statement]);
  expect(measured.capture.planStatements).toEqual(measured.capture.plans.map(() => 0));
  expect(nestedPlanIndex).toBeGreaterThanOrEqual(0);
  const nestedDocument = measured.capture.plans[nestedPlanIndex];
  const nestedEntries = Array.isArray(nestedDocument) ? nestedDocument : [nestedDocument];
  const nestedEntry = nestedEntries.find(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'Query Text' in entry &&
      typeof entry['Query Text'] === 'string' &&
      entry['Query Text'].includes('growth_cost_test.native_nested'),
  ) as { Plan?: PlanNode; 'Query Text'?: string } | undefined;
  const nestedRoot = nestedEntry?.Plan;
  expect(nestedRoot).toBeDefined();
  expect(nestedEntry?.['Query Text']).toBeDefined();
  expect(measured.capture.statements).not.toContain(nestedEntry?.['Query Text']);

  const scan = findNode(nestedRoot!, 'Seq Scan');
  expect(scan).toBeDefined();
  const nestedRows =
    Number(scan?.['Actual Rows'] ?? 0) +
    Number(scan?.['Rows Removed by Filter'] ?? 0) +
    Number(scan?.['Rows Removed by Index Recheck'] ?? 0);
  const cost = costOf(measured.capture);
  expect(nestedRows).toBe(500);
  expect(cost.plans).toBe(measured.capture.plans.length);
  expect(cost.relations['growth_cost_test.native_nested']?.rows).toBe(nestedRows);
  expect(cost.relations['growth_cost_test.native_nested']?.blocks).toBeGreaterThan(0);
});

test('a sequential scan counts filtered out rows as examined', async () => {
  const plan = await explain('SELECT value FROM growth_cost_test.seq_rows WHERE value > 95');
  const cost = costOf({ statements: [], plans: [plan] });

  expect(cost.rows).toBe(100);
  expect(cost.relations['growth_cost_test.seq_rows']).toEqual({
    rows: 100,
    blocks: expect.any(Number),
    nodes: 1,
    sequentialScans: 1,
  });
});

test('counts sequential scans per relation', () => {
  const plan = [
    {
      Plan: {
        'Node Type': 'Append',
        'Actual Rows': 0,
        'Shared Hit Blocks': 0,
        'Shared Read Blocks': 0,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'sequential_relation',
            'Actual Rows': 1,
            'Shared Hit Blocks': 0,
            'Shared Read Blocks': 0,
          },
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'indexed_relation',
            'Actual Rows': 1,
            'Shared Hit Blocks': 0,
            'Shared Read Blocks': 0,
          },
        ],
      },
    },
  ];

  const cost = costOf({ statements: [], plans: [plan] });

  expect(cost.relations.sequential_relation?.sequentialScans).toBe(1);
  expect(cost.relations.indexed_relation?.sequentialScans).toBe(0);
});

test('an inner index scan multiplies per-loop rows by its loop count', async () => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_hashjoin = off');
    await client.query('SET LOCAL enable_mergejoin = off');
    await client.query('SET LOCAL enable_seqscan = off');
    const plan = await explain(`
      SELECT o.lookup_id, i.payload
      FROM growth_cost_test.loop_outer AS o
      JOIN growth_cost_test.loop_inner AS i ON i.id = o.lookup_id
    `);
    const inner = findNode(rootOf(plan), 'Index Scan');
    expect(inner).toBeDefined();
    expect(inner?.['Actual Loops']).toBeGreaterThan(1);

    const cost = costOf({ statements: [], plans: [plan] });
    expect(cost.rows).toBe(10);
    expect(cost.relations['growth_cost_test.loop_inner']?.rows).toBe(5);
  } finally {
    await client.query('ROLLBACK');
  }
});

test('shared blocks are attributed once across a join tree', async () => {
  const plan = await explain(`
    SELECT o.lookup_id, i.payload
    FROM growth_cost_test.loop_outer AS o
    JOIN growth_cost_test.loop_inner AS i ON i.id = o.lookup_id
  `);
  const root = rootOf(plan);
  const cost = costOf({ statements: [], plans: [plan] });

  expect(cost.blocks).toBe(Number(root['Shared Hit Blocks']) + Number(root['Shared Read Blocks']));
  expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
});

test('a CTE read by several scans counts its blocks once', async () => {
  const plan = await explain(`
    WITH probes AS MATERIALIZED (
      SELECT value FROM growth_cost_test.seq_rows
    )
    SELECT
      EXISTS (SELECT 1 FROM probes WHERE value = 10) AS first,
      EXISTS (SELECT 1 FROM probes WHERE value = 90) AS second
  `);
  const root = rootOf(plan);
  const cost = costOf({ statements: [], plans: [plan] });
  const expected = Number(root['Shared Hit Blocks']) + Number(root['Shared Read Blocks']);

  expect(expected).toBeGreaterThan(0);
  expect(cost.blocks).toBe(expected);
  expect(cost.sharedHit + cost.sharedRead).toBe(expected);
  const relationBlocks = Object.values(cost.relations).reduce((sum, relation) => sum + relation.blocks, 0);
  expect(relationBlocks).toBe(expected);
});

test('an unreferenced data-modifying CTE contributes its relation rows and blocks', async () => {
  await client.query('BEGIN');
  try {
    const plan = await explain(`
      WITH w AS (
        INSERT INTO growth_cost_test.cte_target VALUES (2) RETURNING 1
      )
      SELECT 1
    `);
    const cost = costOf({ statements: [], plans: [plan] });

    expect(cost.relations['growth_cost_test.cte_target']).toEqual({
      rows: 1,
      blocks: expect.any(Number),
      nodes: 1,
      sequentialScans: 0,
    });
    expect(cost.relations['growth_cost_test.cte_target']?.blocks).toBeGreaterThan(0);
  } finally {
    await client.query('ROLLBACK');
  }
});

test('included background CTE limitations retain plan provenance and excluded plans add none', () => {
  const plan = {
    'Node Type': 'CTE Scan',
    'CTE Name': 'missing',
    'Actual Rows': 1,
    'Actual Loops': 1,
    'Shared Hit Blocks': 7,
    'Shared Read Blocks': 0,
  };
  const capture = {
    statements: [],
    plans: [],
    backgroundStatements: ['UPDATE app.items'],
    backgroundPlans: [{ 'Query Text': 'UPDATE app.items', Plan: plan }],
  };
  const included = costOf({ ...capture, backgroundPlanStatements: [0] });

  expect(included.backgroundBlocks).toBe(7);
  expect(included.limitations).toHaveLength(1);
  expect(included.limitations?.[0]).toContain(
    'Background plan backgroundPlans[0] for background statement occurrence 0',
  );
  expect(included.limitations?.[0]).toContain('at backgroundPlans[0]');
  const median = medianCost([included]);
  expect(median.limitations).toEqual(included.limitations);
  expect(median.limitations).not.toBe(included.limitations);

  const excluded = costOf({
    ...capture,
    backgroundStatementBackends: [10],
    backgroundPlanBackends: [11],
  });
  expect(excluded.limitations).toBeUndefined();
});

test('transaction control is counted separately from application statements', async () => {
  const plan = await explain('SELECT 1');
  const cost = costOf({
    statements: [
      '  BEGIN;',
      'START TRANSACTION',
      'COMMIT',
      'END',
      'ABORT',
      'ROLLBACK',
      'SAVEPOINT s',
      'RELEASE s',
      'SET LOCAL statement_timeout = 0',
      'SET TRANSACTION READ ONLY',
      'SELECT 1',
      'INSERT INTO t VALUES (1)',
    ],
    plans: [plan],
  });

  expect(cost.statements).toBe(2);
  expect(cost.controlStatements).toBe(10);
  for (const statement of [
    'BEGIN;',
    ' START TRANSACTION',
    'COMMIT',
    'END',
    'ABORT',
    'ROLLBACK TO savepoint',
    'SAVEPOINT s',
    'RELEASE s',
    'SET LOCAL statement_timeout = 0',
    'SET TRANSACTION READ ONLY',
  ])
    expect(isControlStatement(statement)).toBe(true);
  for (const statement of ['SELECT 1', 'beginning', 'START', 'SET LOCALITY x'])
    expect(isControlStatement(statement)).toBe(false);
});

test('catalog-only plans are counted apart, while catalog and data joins count in full', () => {
  const catalogQuery = 'SELECT column_name FROM information_schema.columns WHERE table_name = $1';
  const catalogPlan = [
    {
      'Query Text': catalogQuery,
      Plan: {
        'Node Type': 'Index Scan',
        Schema: 'information_schema',
        'Relation Name': 'columns',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 1,
        'Shared Read Blocks': 0,
      },
    },
  ];
  const catalogCost = costOf({ statements: [catalogQuery], plans: [catalogPlan] });

  expect(catalogCost).toMatchObject({
    catalogStatements: 1,
    statements: 0,
    plans: 0,
    rows: 0,
    blocks: 0,
    sharedHit: 0,
    sharedRead: 0,
    relations: {},
  });

  const joinedQuery =
    'SELECT c.column_name, t.value FROM pg_catalog.pg_class AS c JOIN growth_cost_test.seq_rows AS t ON true';
  const joinedPlan = [
    {
      'Query Text': joinedQuery,
      Plan: {
        'Node Type': 'Nested Loop',
        'Actual Rows': 1,
        'Actual Loops': 1,
        'Shared Hit Blocks': 2,
        'Shared Read Blocks': 0,
        Plans: [
          {
            'Node Type': 'Index Scan',
            Schema: 'pg_catalog',
            'Relation Name': 'pg_class',
            'Actual Rows': 1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 1,
            'Shared Read Blocks': 0,
          },
          {
            'Node Type': 'Seq Scan',
            Schema: 'growth_cost_test',
            'Relation Name': 'seq_rows',
            'Actual Rows': 1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 1,
            'Shared Read Blocks': 0,
          },
        ],
      },
    },
  ];
  const joinedCost = costOf({ statements: [joinedQuery], plans: [joinedPlan] });

  expect(joinedCost.catalogStatements).toBe(0);
  expect(joinedCost.statements).toBe(1);
  expect(joinedCost.plans).toBe(1);
  expect(joinedCost.rows).toBeGreaterThan(0);
  expect(joinedCost.relations['pg_catalog.pg_class']).toBeDefined();
  expect(joinedCost.relations['growth_cost_test.seq_rows']).toBeDefined();
});

test('plans without ANALYZE rows or BUFFERS counts are refused', () => {
  const noRows = [{ Plan: { 'Node Type': 'Seq Scan', 'Shared Hit Blocks': 0, 'Shared Read Blocks': 0 } }];
  const noBuffers = [{ Plan: { 'Node Type': 'Result', 'Actual Rows': 1, 'Actual Loops': 1 } }];

  expect(() => costOf({ statements: [], plans: [noRows] })).toThrow(TypeError);
  expect(() => costOf({ statements: [], plans: [noBuffers] })).toThrow(TypeError);
  expect(() => costOf({ statements: [], plans: [{ Plan: {} }] })).toThrow(TypeError);
});

test('median cost takes the lower median of each measure and matching relations', () => {
  const cost = (values: Omit<Cost, 'relations'>, relation: string): Cost => ({
    ...values,
    relations: { [relation]: { rows: values.rows, blocks: values.blocks, nodes: 1, sequentialScans: 0 } },
  });
  const first = cost(
    {
      statements: 1,
      controlStatements: 0,
      catalogStatements: 0,
      plans: 1,
      rows: 10,
      blocks: 4,
      sharedHit: 2,
      sharedRead: 2,
    },
    'first',
  );
  const second = cost(
    {
      statements: 3,
      controlStatements: 2,
      catalogStatements: 2,
      plans: 2,
      rows: 20,
      blocks: 6,
      sharedHit: 3,
      sharedRead: 3,
    },
    'second',
  );
  const third = cost(
    {
      statements: 5,
      controlStatements: 4,
      catalogStatements: 4,
      plans: 3,
      rows: 30,
      blocks: 4,
      sharedHit: 4,
      sharedRead: 0,
    },
    'third',
  );

  expect(medianCost([first, second, third])).toEqual({
    statements: 3,
    controlStatements: 2,
    catalogStatements: 2,
    plans: 2,
    rows: 20,
    blocks: 4,
    sharedHit: 3,
    sharedRead: 2,
    relations: first.relations,
  });
  expect(() => medianCost([])).toThrow(RangeError);
});

test('Aggregated cost evidence owns its nested relation values independently of raw repetition objects.', () => {
  const relation = { rows: 10, blocks: 4, nodes: 1, sequentialScans: 1 };
  const relations: Record<string, typeof relation> = { items: relation };
  const first: Cost = {
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    rows: 10,
    blocks: 4,
    sharedHit: 2,
    sharedRead: 2,
    relations,
  };
  const second: Cost = {
    ...first,
    blocks: 8,
    relations: { items: { rows: 20, blocks: 8, nodes: 2, sequentialScans: 2 } },
  };
  const aggregated = medianCost([first, second]);
  const snapshot = aggregated.relations.items!;
  expect(snapshot).toEqual({ rows: 10, blocks: 4, nodes: 1, sequentialScans: 1 });
  expect(snapshot).not.toBe(relation);
  expect(aggregated.relations).not.toBe(relations);
  relation.rows = 99;
  relation.blocks = 99;
  relation.nodes = 99;
  relation.sequentialScans = 99;
  relations.extra = { rows: 1, blocks: 1, nodes: 1, sequentialScans: 0 };
  delete relations.items;
  expect(aggregated.relations).toEqual({ items: { rows: 10, blocks: 4, nodes: 1, sequentialScans: 1 } });
  expect(relation).toEqual({ rows: 99, blocks: 99, nodes: 99, sequentialScans: 99 });
});

test('plan measurements reject negative and non-finite physical work', () => {
  const plan = (fields: Record<string, unknown>) => ({
    'Node Type': 'Seq Scan',
    'Actual Rows': 1,
    'Actual Loops': 1,
    'Shared Hit Blocks': 0,
    'Shared Read Blocks': 0,
    ...fields,
  });
  for (const field of [
    'Actual Rows',
    'Actual Loops',
    'Shared Hit Blocks',
    'Shared Read Blocks',
    'Rows Removed by Filter',
    'Rows Removed by Index Recheck',
  ]) {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => costOf({ statements: [], plans: [{ Plan: plan({ [field]: value }) }] })).toThrow(TypeError);
  }
});

test('plan extraction refuses overflow in row, block, relation and CTE accumulators', () => {
  const seqPlan = (rows: number, blocks = 0, extra: Record<string, unknown> = {}) => ({
    'Node Type': 'Seq Scan',
    Schema: 'app',
    'Relation Name': 'items',
    'Actual Rows': rows,
    'Actual Loops': 1,
    'Shared Hit Blocks': blocks,
    'Shared Read Blocks': 0,
    ...extra,
  });
  expect(() =>
    costOf({ statements: [], plans: [{ Plan: seqPlan(Number.MAX_VALUE, 0, { 'Actual Loops': 2 }) }] }),
  ).toThrow(/Rows examined/);
  expect(() =>
    costOf({ statements: [], plans: [{ Plan: seqPlan(Number.MAX_VALUE) }, { Plan: seqPlan(Number.MAX_VALUE) }] }),
  ).toThrow(/Total examined rows|Rows for relation/);
  expect(() =>
    costOf({ statements: [], plans: [{ Plan: seqPlan(0, Number.MAX_VALUE) }, { Plan: seqPlan(0, Number.MAX_VALUE) }] }),
  ).toThrow(/Blocks for relation|Total shared hit blocks/);
  expect(() =>
    costOf({
      statements: [],
      plans: [],
      backgroundPlans: [{ Plan: seqPlan(Number.MAX_VALUE) }, { Plan: seqPlan(Number.MAX_VALUE) }],
    }),
  ).toThrow(/Total background examined rows/);
  expect(() =>
    costOf({
      statements: [],
      plans: [],
      backgroundPlans: [{ Plan: seqPlan(0, Number.MAX_VALUE) }, { Plan: seqPlan(0, Number.MAX_VALUE) }],
    }),
  ).toThrow(/Total background blocks/);
  const producer = (child?: Record<string, unknown>) => ({
    'Node Type': 'Result',
    'Subplan Name': 'CTE items',
    'Actual Rows': 0,
    'Actual Loops': 1,
    'Shared Hit Blocks': Number.MAX_VALUE,
    'Shared Read Blocks': 0,
    ...(child === undefined ? {} : { Plans: [child] }),
  });
  expect(() =>
    costOf({
      statements: [],
      plans: [
        {
          Plan: {
            'Node Type': 'Result',
            'Actual Rows': 0,
            'Actual Loops': 1,
            'Shared Hit Blocks': Number.MAX_VALUE,
            'Shared Read Blocks': 0,
            Plans: [producer(producer())],
          },
        },
      ],
    }),
  ).toThrow(/Inclusive hit blocks for CTE items/);
});

test('catalog filtering cannot hide malformed physical plan measurements', () => {
  const query = 'select relname from pg_catalog.pg_class';
  expect(() =>
    costOf({
      statements: [query],
      planStatements: [0],
      plans: [
        {
          'Query Text': query,
          Plan: {
            'Node Type': 'Seq Scan',
            Schema: 'pg_catalog',
            'Relation Name': 'pg_class',
            'Actual Rows': -1,
            'Actual Loops': 1,
            'Shared Hit Blocks': 1,
            'Shared Read Blocks': 0,
          },
        },
      ],
    }),
  ).toThrow(TypeError);
});

test('byte aggregation rejects non-representable totals and preserves absent optional bytes', () => {
  expect(() =>
    costOf({
      statements: ['select 1', 'select 2'],
      requestBytes: [Number.MAX_VALUE, Number.MAX_VALUE],
      plans: [],
    }),
  ).toThrow(/Request bytes/);
  expect(() =>
    costOf({
      statements: [],
      plans: [],
      backgroundStatements: ['update app.items', 'update app.items'],
      backgroundResponseBytes: [Number.MAX_VALUE, Number.MAX_VALUE],
    }),
  ).toThrow(/Background response bytes/);
  const sparseBytes = [1, , 3] as number[];
  expect(() =>
    costOf({ statements: ['select 1', 'select 2', 'select 3'], requestBytes: sparseBytes, plans: [] }),
  ).toThrow(/missing item 2/);
  expect(costOf({ statements: [], plans: [] })).not.toHaveProperty('requestBytes');
});

test('median cost validates supplied core, relation and background evidence before aggregation', () => {
  const valid: Cost = {
    statements: 0,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 0,
    rows: 0,
    blocks: 0,
    sharedHit: 0,
    sharedRead: 0,
    relations: {},
  };
  expect(medianCost([valid, valid, valid])).toMatchObject({ rows: 0, blocks: 0, relations: {} });
  expect(() => medianCost([{ ...valid, rows: -1 }, valid, valid])).toThrow(/Cost rows/);
  expect(() =>
    medianCost([
      { ...valid, relations: { 'app.items': { rows: Number.NaN, blocks: 0, nodes: 1, sequentialScans: 0 } } },
      valid,
      valid,
    ]),
  ).toThrow(/relation app.items rows/);
  expect(() =>
    medianCost([{ ...valid, backgroundCosts: { vacuum: { rows: 0, blocks: -1, bounded: true } } }, valid, valid]),
  ).toThrow(/Background blocks/);
  expect(() => medianCost([{ ...valid, requestBytes: Number.POSITIVE_INFINITY }, valid, valid])).toThrow(
    /requestBytes/,
  );
});

function backgroundScan(queryText: string, rows: number, blocks: number, relation = 'items', schema = 'app') {
  return [
    {
      'Query Text': queryText,
      Plan: {
        'Node Type': 'Seq Scan',
        Schema: schema,
        'Relation Name': relation,
        'Actual Rows': rows,
        'Actual Loops': 1,
        'Shared Hit Blocks': blocks,
        'Shared Read Blocks': 0,
      },
    },
  ];
}

test('Background high-water accounting sums repeated native plans belonging to one execution before comparing executions, preserving occurrence identity and existing bounds.', () => {
  const sql = 'SELECT payload FROM app.items';
  const nested = 'SELECT count(*) FROM app.nested WHERE id < NEW.id';
  const dbosSql = 'SELECT workflow_uuid FROM dbos.workflow_status';
  const cost = costOf({
    statements: [sql],
    plans: backgroundScan(sql, 99, 9),
    backgroundStatements: [sql, sql],
    backgroundPlans: [
      backgroundScan(sql, 10, 2),
      backgroundScan(sql, 12, 3),
      backgroundScan(sql, 15, 1),
      backgroundScan(nested, 7, 4, 'nested'),
      backgroundScan(nested, 8, 5, 'nested'),
      backgroundScan(dbosSql, 4, 2, 'workflow_status', 'dbos'),
    ],
    backgroundPlanStatements: [0, 0, 1, 0, 0, 0],
  });

  expect(cost.rows).toBe(99);
  expect(cost.blocks).toBe(9);
  expect(cost.backgroundRows).toBe(56);
  expect(cost.backgroundBlocks).toBe(17);
  expect(cost.backgroundCosts?.[sql]).toEqual({ rows: 22, blocks: 5, bounded: true });
  expect(cost.backgroundCosts?.[nested]).toEqual({ rows: 15, blocks: 9, bounded: true });
  expect(cost.backgroundCosts?.[dbosSql]).toEqual({ rows: 4, blocks: 2, bounded: false });
});

test('legacy background captures without occurrence owners sum same-text plans instead of inventing executions', () => {
  const sql = 'SELECT payload FROM app.items';
  const cost = costOf({
    statements: [],
    plans: [],
    backgroundPlans: [backgroundScan(sql, 10, 2), backgroundScan(sql, 15, 3)],
  });

  expect(cost.backgroundRows).toBe(25);
  expect(cost.backgroundBlocks).toBe(5);
  expect(cost.backgroundCosts?.[sql]).toEqual({ rows: 25, blocks: 5, bounded: true });
});
