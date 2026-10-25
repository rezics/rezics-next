import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { costOf, isControlStatement, medianCost, type Cost } from './growth-cost.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const client = new pg.Client({ connectionString: databaseUrl });

type PlanNode = { 'Node Type'?: string; Plans?: PlanNode[]; [key: string]: unknown };

beforeAll(async () => {
  await client.connect();
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
    await client.end();
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

test('a sequential scan counts filtered out rows as examined', async () => {
  const plan = await explain('SELECT value FROM growth_cost_test.seq_rows WHERE value > 95');
  const cost = costOf({ statements: [], plans: [plan] });

  expect(cost.rows).toBe(100);
  expect(cost.relations['growth_cost_test.seq_rows']).toEqual({ rows: 100, blocks: expect.any(Number), nodes: 1 });
});

test('an inner index scan multiplies per-loop rows by its loop count', async () => {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL enable_hashjoin = off');
    await client.query('SET LOCAL enable_mergejoin = off');
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
    });
    expect(cost.relations['growth_cost_test.cte_target']?.blocks).toBeGreaterThan(0);
  } finally {
    await client.query('ROLLBACK');
  }
});

test('transaction control is counted separately from application statements', async () => {
  const plan = await explain('SELECT 1');
  const cost = costOf({
    statements: ['  BEGIN;', 'START TRANSACTION', 'COMMIT', 'END', 'ABORT', 'ROLLBACK', 'SAVEPOINT s', 'RELEASE s',
      'SET LOCAL statement_timeout = 0', 'SET TRANSACTION READ ONLY', 'SELECT 1', 'INSERT INTO t VALUES (1)'],
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
    relations: { [relation]: { rows: values.rows, blocks: values.blocks, nodes: 1 } },
  });
  const first = cost(
    { statements: 1, controlStatements: 0, plans: 1, rows: 10, blocks: 4, sharedHit: 2, sharedRead: 2 },
    'first',
  );
  const second = cost(
    { statements: 3, controlStatements: 2, plans: 2, rows: 20, blocks: 6, sharedHit: 3, sharedRead: 3 },
    'second',
  );
  const third = cost(
    { statements: 5, controlStatements: 4, plans: 3, rows: 30, blocks: 4, sharedHit: 4, sharedRead: 0 },
    'third',
  );

  expect(medianCost([first, second, third])).toEqual({
    statements: 3,
    controlStatements: 2,
    plans: 2,
    rows: 20,
    blocks: 4,
    sharedHit: 3,
    sharedRead: 2,
    relations: first.relations,
  });
  expect(() => medianCost([])).toThrow(RangeError);
});
