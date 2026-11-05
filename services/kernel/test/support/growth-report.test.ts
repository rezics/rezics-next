import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { costOf } from './growth-cost.ts';
import { checkGrowth, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from './growth.ts';
import { formatStatementAttribution, statementAttributions, statementOccurrences } from './growth-report.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_report_test';
const growing = `${schema}.growing`;
const constant = `${schema}.constant`;
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${growing} (id integer PRIMARY KEY)`);
  await db.admin.query(`CREATE TABLE ${constant} (id integer PRIMARY KEY)`);
  await db.admin.query(`INSERT INTO ${constant} SELECT generate_series(1, 500)`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test("a growth report keeps every repetition's cost and the size of every relation the operation read at each scale", async () => {
  const database = db!;
  let error: GrowthBoundError | undefined;
  try {
    await checkGrowth(database, {
      name: 'growth report evidence',
      repetitions: 2,
      bounds: { rows: 'constant', blocks: 'linear', statements: 'constant' },
      grow: async (growthDb, scale, previous) => {
        await growthDb.admin.query(`INSERT INTO ${growing} SELECT generate_series($1 + 1, $2)`, [
          previous * 500,
          scale * 500,
        ]);
      },
      operation: (growthDb) =>
        withConnection(growthDb.pool, (client) =>
          client.query(
            `SELECT (SELECT count(*) FROM ${growing}) AS growing,
                    (SELECT count(*) FROM ${constant}) AS constant`,
          ),
        ),
    });
  } catch (caught) {
    if (!(caught instanceof GrowthBoundError)) throw caught;
    error = caught;
  }

  expect(error).toBeInstanceOf(GrowthBoundError);
  const samples = error!.samples;
  expect(samples.map(({ repetitions }) => repetitions?.map(({ rows }) => rows))).toEqual([
    [1000, 1000],
    [4500, 4500],
    [32500, 32500],
  ]);
  expect(samples.map(({ relationSizes }) => relationSizes)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ [growing]: expect.objectContaining({ reltuples: 500, relpages: expect.any(Number) }) }),
      expect.objectContaining({
        [constant]: expect.objectContaining({ reltuples: 500, relpages: expect.any(Number) }),
      }),
    ]),
  );
  expect(samples.map(({ relationSizes }) => relationSizes?.[growing]?.reltuples)).toEqual([500, 4000, 32000]);
  expect(samples.map(({ relationSizes }) => relationSizes?.[constant]?.reltuples)).toEqual([500, 500, 500]);
  expect(error!.message).toContain('rows repetitions by scale: 1 [1000, 1000], 8 [4500, 4500], 64 [32500, 32500]');
  expect(error!.message).toContain(`Relations whose reltuples did not grow: ${constant} (500 to 500)`);
}, 60_000);

test('a growth report preserves ordered statement occurrences for every measured repetition', async () => {
  const database = db!;
  const report = await checkGrowth(database, {
    name: 'ordered occurrence report',
    repetitions: 2,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async () => {},
    operation: (growthDb) =>
      withConnection(growthDb.pool, async (client) => {
        await client.query('SELECT 81 AS first_occurrence');
        await client.query('SELECT 82 AS second_occurrence');
      }),
  });
  expect(report.samples.map(({ occurrenceRepetitions }) => occurrenceRepetitions)).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.occurrenceRepetitions).toHaveLength(2);
    for (const repetition of sample.occurrenceRepetitions) {
      expect(repetition.statements.map(({ statement }) => statement)).toEqual([
        'SELECT ? AS first_occurrence',
        'SELECT ? AS second_occurrence',
      ]);
      expect(repetition.backgroundStatements).toEqual([]);
    }
  }
}, 60_000);

function scan(relation: string, rows: number, blocks: number) {
  return {
    'Node Type': 'Seq Scan',
    Schema: 'app',
    'Relation Name': relation,
    'Actual Rows': rows,
    'Actual Loops': 1,
    'Shared Hit Blocks': blocks,
    'Shared Read Blocks': 0,
  };
}

function document(queryText: string, relation: string, rows: number, blocks: number) {
  return { 'Query Text': queryText, Plan: scan(relation, rows, blocks) };
}

test('grouped statement diagnostics use supplied native occurrence ownership even when nested plan SQL equals another client statement; legacy absent ownership remains explicit', () => {
  const insert = 'INSERT INTO app.outer (id) VALUES ($1)';
  const lookup = 'SELECT id FROM app.lookup WHERE id = NEW.id';
  const inner = 'SELECT count(*) FROM app.inner';
  const insertPlan = document(insert, 'outer', 1, 1);
  const nestedLookup = document(lookup, 'lookup', 10, 4);
  const nestedInner = document(inner, 'inner', 7, 3);
  const queuedLookup = document(lookup, 'lookup', 2, 2);
  const groupedInsert = 'INSERT INTO app.outer (id) VALUES (?)';

  expect(
    statementAttributions({
      statements: [insert, lookup],
      plans: [insertPlan, nestedLookup, nestedInner, queuedLookup],
      planStatements: [0, 0, 0, 1],
    }),
  ).toEqual([
    {
      statement: groupedInsert,
      count: 1,
      rows: 18,
      blocks: 8,
      node: 'Seq Scan app.inner',
      relationIdentities: [
        { schema: 'app', kind: 'relation', name: 'outer' },
        { schema: 'app', kind: 'relation', name: 'lookup' },
        { schema: 'app', kind: 'relation', name: 'inner' },
      ],
    },
    {
      statement: lookup,
      count: 1,
      rows: 2,
      blocks: 2,
      node: 'Seq Scan app.lookup',
      relationIdentities: [{ schema: 'app', kind: 'relation', name: 'lookup' }],
    },
  ]);

  const legacy = { statements: [insert, lookup], plans: [insertPlan, nestedLookup, queuedLookup] };
  expect(statementAttributions(legacy)).toEqual([
    {
      statement: groupedInsert,
      count: 1,
      rows: 1,
      blocks: 1,
      node: 'Seq Scan app.outer',
      relationIdentities: [{ schema: 'app', kind: 'relation', name: 'outer' }],
    },
    {
      statement: lookup,
      count: 1,
      rows: 12,
      blocks: 6,
      node: 'Seq Scan app.lookup',
      relationIdentities: [{ schema: 'app', kind: 'relation', name: 'lookup' }],
    },
  ]);

  expect(statementAttributions({ ...legacy, planStatements: [0, undefined, 1] })).toEqual([
    {
      statement: groupedInsert,
      count: 1,
      rows: 1,
      blocks: 1,
      node: 'Seq Scan app.outer',
      relationIdentities: [{ schema: 'app', kind: 'relation', name: 'outer' }],
    },
    {
      statement: lookup,
      count: 1,
      rows: 2,
      blocks: 2,
      node: 'Seq Scan app.lookup',
      relationIdentities: [{ schema: 'app', kind: 'relation', name: 'lookup' }],
    },
  ]);
});

test('byte-growth failures distinguish measured byte totals from SQL row attribution', () => {
  const samples = [
    {
      scale: 1,
      cost: { requestBytes: 40, responseBytes: 12 },
      statementRepetitions: [
        [
          { statement: 'SELECT growing', rows: 100, blocks: 2, count: 1, node: 'Seq Scan t' },
          { statement: 'SELECT constant', rows: 10, blocks: 1, count: 1, node: 'Seq Scan c' },
        ],
      ],
    },
    {
      scale: 8,
      cost: { requestBytes: 80, responseBytes: 96 },
      statementRepetitions: [
        [
          { statement: 'SELECT growing', rows: 800, blocks: 16, count: 1, node: 'Seq Scan t' },
          { statement: 'SELECT constant', rows: 10, blocks: 1, count: 1, node: 'Seq Scan c' },
        ],
      ],
    },
  ];

  const bytes = formatStatementAttribution(samples, ['requestBytes', 'responseBytes']);
  const [requestSection, afterRequest] = bytes.split('SQL row attribution (not statement byte costs):');
  expect(requestSection).toContain('Measured requestBytes totals by scale: 1: 40, 8: 80');
  expect(requestSection).toContain('Measured responseBytes totals by scale: 1: 12, 8: 96');
  expect(requestSection).toContain('Per-statement requestBytes attribution is unavailable');
  expect(requestSection).toContain('Per-statement responseBytes attribution is unavailable');
  expect(requestSection).not.toContain('Statements growing most for requestBytes:');
  expect(requestSection).not.toContain('Statements growing most for responseBytes:');
  expect(requestSection).not.toContain('100');
  expect(requestSection).not.toContain('800');
  expect(afterRequest).toContain('SELECT growing | 1: 100, 8: 800 | Seq Scan t');

  const mixed = formatStatementAttribution(samples, ['rows', 'blocks', 'statements', 'responseBytes']);
  expect(mixed).toContain('Statements growing most for rows:\n  SELECT growing | 1: 100, 8: 800 | Seq Scan t');
  expect(mixed).toContain('Statements growing most for blocks:\n  SELECT growing | 1: 2, 8: 16 | Seq Scan t');
  expect(mixed).toContain('Statements growing most for statements:\n  SELECT growing | 1: 1, 8: 1 | Seq Scan t');
  expect(mixed).toContain('Measured responseBytes totals by scale: 1: 12, 8: 96');
  expect(mixed).toContain('Per-statement responseBytes attribution is unavailable');
  expect(mixed).not.toContain('Statements growing most for responseBytes:');
  expect(mixed).not.toContain('SQL row attribution (not statement byte costs):');
});

function nativePlan(fields: Record<string, unknown> = {}, children?: unknown[]) {
  return {
    'Node Type': 'Result',
    'Actual Rows': 0,
    'Actual Loops': 1,
    'Shared Hit Blocks': 0,
    'Shared Read Blocks': 0,
    ...fields,
    ...(children === undefined ? {} : { Plans: children }),
  };
}

test('statement diagnostics use measured plan costs for CTE reuse and DML without changing occurrence links', () => {
  const dmlSql = 'INSERT INTO app.items SELECT value FROM app.source';
  const dmlPlan = nativePlan(
    {
      'Node Type': 'ModifyTable',
      Schema: 'app',
      'Relation Name': 'items',
      'Actual Rows': 5,
      'Shared Hit Blocks': 4,
    },
    [
      nativePlan({
        'Node Type': 'Seq Scan',
        Schema: 'app',
        'Relation Name': 'source',
        'Actual Rows': 10,
        'Shared Hit Blocks': 4,
      }),
    ],
  );
  const cteSql = 'WITH items AS MATERIALIZED (SELECT 1) SELECT * FROM items';
  const ctePlan = nativePlan({ 'Shared Hit Blocks': 7 }, [
    nativePlan({ 'Subplan Name': 'CTE items', 'Shared Hit Blocks': 20 }),
    nativePlan({ 'Node Type': 'CTE Scan', 'CTE Name': 'other', 'Shared Hit Blocks': 7 }),
  ]);
  const catalogSql = 'SELECT column_name FROM information_schema.columns WHERE table_name = $1';
  const catalogPlan = nativePlan({
    'Node Type': 'Index Scan',
    Schema: 'information_schema',
    'Relation Name': 'columns',
    'Actual Rows': 1,
    'Shared Hit Blocks': 1,
  });
  const capture = {
    statements: [dmlSql, cteSql, catalogSql],
    planStatements: [0, 1, 2],
    plans: [
      { 'Query Text': dmlSql, Plan: dmlPlan },
      { 'Query Text': cteSql, Plan: ctePlan },
      { 'Query Text': catalogSql, Plan: catalogPlan },
    ],
  };
  const dmlCost = costOf({ statements: [dmlSql], plans: [capture.plans[0]] });
  const cteCost = costOf({ statements: [cteSql], plans: [capture.plans[1]] });
  const catalogCost = costOf({
    statements: [catalogSql],
    planStatements: [0],
    plans: [capture.plans[2]],
  });
  const measured = costOf(capture);
  const occurrences = statementOccurrences(capture).statements;
  const attributions = statementAttributions(capture);

  expect(dmlCost.rows).toBe(10);
  expect(cteCost.blocks).toBe(27);
  expect(catalogCost.rows).toBe(0);
  expect(
    occurrences.map(({ index, statement, plans, planDocuments }) => [index, statement, plans, planDocuments]),
  ).toEqual([
    [0, 'INSERT INTO app.items SELECT value FROM app.source', [0], [capture.plans[0]]],
    [1, 'WITH items AS MATERIALIZED (SELECT ?) SELECT * FROM items', [1], [capture.plans[1]]],
    [2, 'SELECT column_name FROM information_schema.columns WHERE table_name = ?', [2], [capture.plans[2]]],
  ]);
  expect(occurrences[0]).toMatchObject({ rows: dmlCost.rows, blocks: dmlCost.blocks });
  expect(occurrences[1]).toMatchObject({ rows: cteCost.rows, blocks: cteCost.blocks });
  expect(occurrences[2]!.rows).toBeGreaterThan(0);
  expect(occurrences[0]!.rows + occurrences[1]!.rows + occurrences[2]!.rows).not.toBe(measured.rows);
  expect(attributions.map(({ statement, count }) => [statement, count])).toEqual(
    occurrences.map(({ statement }) => [statement, 1]),
  );
  expect(attributions[0]).toMatchObject({
    rows: dmlCost.rows,
    blocks: dmlCost.blocks,
    node: 'Seq Scan app.source',
  });
});
