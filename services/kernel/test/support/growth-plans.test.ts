import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withConnection } from '../../src/database/pool.ts';
import { appendImportPostgresCapture } from '../imports/api-capture.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import { catalogStatementBound, costOf, isControlStatement, withoutCatalogTexts } from './growth-cost.ts';
import { statementOccurrences } from './growth-report.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_plans_test';
let database: GrowthDatabase | undefined;

function barrier(size: number): () => Promise<void> {
  let waiting = 0;
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    waiting++;
    if (waiting === size) release();
    await opened;
  };
}

function planQueryTexts(document: unknown): string[] {
  const entries = Array.isArray(document) ? document : [document];
  return entries.flatMap((entry) =>
    typeof entry === 'object' && entry !== null && 'Query Text' in entry && typeof entry['Query Text'] === 'string'
      ? [entry['Query Text']]
      : [],
  );
}

function matchKey(backend: number | undefined, text: string): string {
  return JSON.stringify([backend ?? null, text]);
}

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
  await database.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await database.admin.query(`CREATE SCHEMA ${schema}`);
  await database.admin.query(`
    CREATE TABLE ${schema}.subject (
      route integer NOT NULL,
      subject_id uuid NOT NULL,
      current_release text NOT NULL,
      PRIMARY KEY (route, subject_id)
    );
    CREATE TABLE ${schema}.partition (
      partition_no integer PRIMARY KEY,
      epoch integer NOT NULL,
      position bigint NOT NULL
    );
    CREATE TABLE ${schema}.candidate (
      route integer NOT NULL,
      subject_id uuid NOT NULL,
      candidate_id uuid PRIMARY KEY,
      slot_id uuid NOT NULL,
      property text NOT NULL,
      rank text NOT NULL,
      statement jsonb NOT NULL,
      release text NOT NULL,
      revision integer NOT NULL,
      origin text NOT NULL
    );
  `);
});

afterAll(async () => {
  if (!database) return;
  await database.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await database.close();
});

test('a capture across several connections records exactly one plan for every executed statement and matches it by backend', async () => {
  const growthDb = database!;
  const width = 4;
  const pool = growthDb.openPool({ max: width });
  const clients: PoolClient[] = [];
  const subjectIds: string[] = [];
  const insertCandidate = `INSERT INTO ${schema}.candidate
    (route, subject_id, candidate_id, slot_id, property, rank, statement, release, revision, origin)
  VALUES ($1::integer, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text,
    $7::jsonb, $8::text, $9::integer, 'proposal') /*insert-candidate*/`;
  try {
    for (let index = 0; index < width; index++) {
      const subjectId = randomUUID();
      subjectIds.push(subjectId);
      await growthDb.admin.query(
        `INSERT INTO ${schema}.subject (route, subject_id, current_release) VALUES ($1, $2, 'old')`,
        [index, subjectId],
      );
      await growthDb.admin.query(`INSERT INTO ${schema}.partition (partition_no, epoch, position) VALUES ($1, 1, 0)`, [
        index,
      ]);
      const client = await pool.connect();
      clients.push(client);
      // Each capture starts after its transaction and savepoint. The first explain switch therefore sits inside the
      // transaction, and the rollback to the savepoint undoes it before the recovered candidate insert.
      await client.query('BEGIN');
      await client.query('SAVEPOINT growth_plans_boundary');
    }

    const rendezvous = barrier(width);
    const captured = await capture(
      growthDb,
      async () => {
        await Promise.all(
          clients.map(async (client, index) => {
            await rendezvous();
            await client.query('SELECT pg_sleep(0.05) /*hold-the-client-queue*/');
            await client.query(
              `UPDATE ${schema}.subject
             SET current_release = $1::text
             WHERE route = $2::integer AND subject_id = $3::uuid /*update-subject-release*/`,
              [`release-${index}`, index, subjectIds[index]!],
            );
            await client.query(
              `WITH input AS NOT MATERIALIZED (
               SELECT $1::integer AS partition_no
             ),
             fence AS (
               UPDATE ${schema}.partition
               SET position = position + 1
               FROM input
               WHERE ${schema}.partition.partition_no = input.partition_no
               RETURNING ${schema}.partition.partition_no, ${schema}.partition.epoch, ${schema}.partition.position
             )
             SELECT epoch, position FROM fence /*command-fence*/`,
              [index],
            );
            const candidateId = randomUUID();
            const insertValues = [
              index,
              subjectIds[index]!,
              candidateId,
              randomUUID(),
              'title',
              '0',
              JSON.stringify({}),
              'release',
              1,
            ];
            await client.query(insertCandidate, insertValues);
            await expect(client.query(insertCandidate, insertValues)).rejects.toMatchObject({ code: '23505' });
            await client.query('ROLLBACK TO SAVEPOINT growth_plans_boundary');
            await client.query(insertCandidate, [
              index,
              subjectIds[index]!,
              randomUUID(),
              randomUUID(),
              'title',
              '0',
              JSON.stringify({}),
              'release',
              1,
            ]);
            await client.query(index % 2 === 0 ? 'COMMIT' : 'ROLLBACK');
          }),
        );
      },
      { includeBackends: true },
    );

    const statements = captured.capture.statements.flatMap((text, index) =>
      isControlStatement(text)
        ? []
        : [
            {
              text,
              backend: captured.capture.statementBackends?.[index],
              error: captured.capture.statementErrors?.[index],
            },
          ],
    );
    const plans = captured.capture.plans.flatMap((document, index) =>
      planQueryTexts(document)
        .filter((text) => !isControlStatement(text))
        .map((text) => ({ text, backend: captured.capture.planBackends?.[index] })),
    );
    const planCounts = new Map<string, number>();
    for (const plan of plans) {
      const key = matchKey(plan.backend, plan.text);
      planCounts.set(key, (planCounts.get(key) ?? 0) + 1);
    }

    const plannedStatements = statements.filter(({ error }) => error === null);
    expect(plans).toHaveLength(plannedStatements.length);
    expect(captured.capture.statementBackends).toHaveLength(captured.capture.statements.length);
    expect(captured.capture.planBackends).toHaveLength(captured.capture.plans.length);
    expect(new Set(statements.map(({ backend }) => backend)).size).toBe(width);
    const plannedStatementCounts = new Map<string, number>();
    for (const statement of plannedStatements) {
      const key = matchKey(statement.backend, statement.text);
      plannedStatementCounts.set(key, (plannedStatementCounts.get(key) ?? 0) + 1);
    }
    expect([...planCounts.entries()].sort()).toEqual([...plannedStatementCounts.entries()].sort());
    for (const backend of new Set(statements.map(({ backend }) => backend)))
      expect(
        statements.filter(
          ({ text, backend: statementBackend }) => statementBackend === backend && text.includes('insert-candidate'),
        ),
      ).toHaveLength(3);
  } finally {
    for (const client of clients) client.release();
  }
});

test('catalog classification does not match a plan from another backend', () => {
  const queryText = 'SELECT relation_name FROM pg_catalog.pg_class';
  const captured = {
    statements: [queryText, queryText, queryText],
    statementBackends: [101, 202, 303],
    plans: [
      {
        'Query Text': queryText,
        Plan: {
          'Node Type': 'Seq Scan',
          Schema: 'pg_catalog',
          'Relation Name': 'pg_class',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Shared Hit Blocks': 1,
          'Shared Read Blocks': 0,
        },
      },
      {
        'Query Text': queryText,
        Plan: {
          'Node Type': 'Seq Scan',
          Schema: 'application',
          'Relation Name': 'records',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Shared Hit Blocks': 1,
          'Shared Read Blocks': 0,
        },
      },
      {
        'Query Text': queryText,
        Plan: {
          'Node Type': 'Seq Scan',
          Schema: 'application',
          'Relation Name': 'records',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Shared Hit Blocks': 1,
          'Shared Read Blocks': 0,
        },
      },
      {
        'Query Text': queryText,
        Plan: {
          'Node Type': 'Seq Scan',
          Schema: 'application',
          'Relation Name': 'unmatched_records',
          'Actual Rows': 1,
          'Actual Loops': 1,
          'Shared Hit Blocks': 1,
          'Shared Read Blocks': 0,
        },
      },
    ],
    planBackends: [101, 202, 303, 404],
  };
  const classification = catalogStatementBound(captured);

  expect(classification).toMatchObject({ catalogStatements: 1, allowedStatements: 1 });
  expect(classification.catalogTexts.has(queryText)).toBe(false);
  expect(costOf(captured)).toMatchObject({ statements: 2, catalogStatements: 1, plans: 2 });
  expect(withoutCatalogTexts(captured, classification)).toMatchObject({
    statements: [queryText, queryText],
    statementBackends: [202, 303],
    planBackends: [202, 303],
  });
});

test('catalog projection keeps native occurrence links, documents, errors and backends aligned', async () => {
  const growthDb = database!;
  const first = `SELECT 'first'::text AS value`;
  const catalog = `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`;
  const failed = `SELECT * FROM ${schema}.missing_projection_relation`;
  const last = `SELECT 'last'::text AS value`;
  const measured = await capture(
    growthDb,
    () =>
      withConnection(growthDb.pool, async (client) => {
        await client.query(first);
        await client.query(catalog, [schema, 'subject']);
        await expect(client.query(failed)).rejects.toMatchObject({ code: '42P01' });
        await client.query(last);
      }),
    { includeBackends: true },
  );
  const raw = measured.capture;

  expect(raw.statements).toEqual([first, catalog, failed, last]);
  expect(raw.statementErrors).toEqual([null, null, '42P01', null]);
  expect(raw.planStatements).toEqual([0, 1, 3]);
  expect(raw.plans).toHaveLength(3);
  expect(raw.statementBackends).toHaveLength(4);
  expect(raw.planBackends).toHaveLength(3);
  expect(catalogStatementBound(raw)).toMatchObject({ catalogStatements: 1, allowedStatements: 3 });

  const beforePlans = [...raw.plans];
  const projected = withoutCatalogTexts(raw, catalogStatementBound(raw));
  expect(projected.statements).toEqual([first, failed, last]);
  expect(projected.statementErrors).toEqual([null, '42P01', null]);
  expect(projected.planStatements).toEqual([0, 2]);
  expect(projected.plans).toEqual([beforePlans[0], beforePlans[2]]);
  expect(projected.plans[0]).toBe(raw.plans[0]);
  expect(projected.plans[1]).toBe(raw.plans[2]);
  expect(projected.planBackends).toEqual([raw.planBackends![0], raw.planBackends![2]]);
  expect(projected.statementBackends).toEqual([
    raw.statementBackends![0],
    raw.statementBackends![2],
    raw.statementBackends![3],
  ]);
  expect(projected.requestBytes).toEqual([raw.requestBytes![0]!, raw.requestBytes![2]!, raw.requestBytes![3]!]);
  expect(projected.responseBytes).toEqual([raw.responseBytes![0]!, raw.responseBytes![2]!, raw.responseBytes![3]!]);
  expect(raw.statements).toHaveLength(4);
  expect(raw.plans).toEqual(beforePlans);
  const rawCost = costOf(raw);
  const projectedCost = costOf(projected);
  expect({ plans: rawCost.plans, rows: rawCost.rows, blocks: rawCost.blocks, relations: rawCost.relations }).toEqual({
    plans: projectedCost.plans,
    rows: projectedCost.rows,
    blocks: projectedCost.blocks,
    relations: projectedCost.relations,
  });

  const rawOccurrences = statementOccurrences(raw).statements;
  expect(
    rawOccurrences.map(({ index, error, plans, backend }) => [index, error?.code ?? null, plans, backend]),
  ).toEqual([
    [0, null, [0], raw.statementBackends![0]],
    [1, null, [1], raw.statementBackends![1]],
    [2, '42P01', [], raw.statementBackends![2]],
    [3, null, [2], raw.statementBackends![3]],
  ]);
  expect(
    statementOccurrences(projected).statements.map(({ index, error, plans }) => [index, error?.code ?? null, plans]),
  ).toEqual([
    [0, null, [0]],
    [1, '42P01', []],
    [2, null, [1]],
  ]);
});

test('native nested documents keep their producer through catalog projection and existing append offsets', async () => {
  const growthDb = database!;
  await growthDb.admin.query(`
    CREATE TABLE ${schema}.merge_rows (id integer PRIMARY KEY);
    INSERT INTO ${schema}.merge_rows VALUES (1), (2);
    CREATE FUNCTION ${schema}.merge_count() RETURNS integer LANGUAGE plpgsql AS $$
    DECLARE matched integer;
    BEGIN
      SELECT count(*) INTO matched FROM ${schema}.merge_rows;
      RETURN matched;
    END $$;
  `);
  const prefix = await capture(growthDb, () => growthDb.pool.query('SELECT 17 AS prefix'), {
    includeBackends: true,
  });
  const catalog = 'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2';
  const producer = `SELECT ${schema}.merge_count() AS matched`;
  const missing = `SELECT * FROM ${schema}.merge_missing`;
  const measured = await capture(
    growthDb,
    () =>
      withConnection(growthDb.pool, async (client) => {
        const metadata = client.query(catalog, [schema, 'merge_rows']);
        const counted = client.query<{ matched: number }>(producer);
        const failed = client.query(missing).catch((error: Error & { code?: string }) => error.code);
        const [columns, result, code] = await Promise.all([metadata, counted, failed]);
        return { columns: columns.rowCount, rows: result.rows, code };
      }),
    { includeBackends: true },
  );
  expect(measured.value).toEqual({ columns: 1, rows: [{ matched: 2 }], code: '42P01' });
  const raw = measured.capture;
  expect(raw.statements).toEqual([catalog, producer, missing]);
  expect(raw.planStatements).toEqual([0, 1, 1]);
  expect(raw.plans).toHaveLength(3);
  const nested = raw.plans[1];
  expect(nested).toEqual(expect.objectContaining({ 'Query Text': expect.stringContaining(`${schema}.merge_rows`) }));
  expect(raw.statements).not.toContain((nested as { 'Query Text': string })['Query Text']);
  const projected = withoutCatalogTexts(raw, catalogStatementBound(raw));
  expect(projected.statements).toEqual([producer, missing]);
  expect(projected.planStatements).toEqual([0, 0]);
  expect(projected.plans).toEqual(raw.plans.slice(1));
  expect(projected.plans[0]).toBe(nested);
  expect(costOf(projected).relations[`${schema}.merge_rows`]?.rows).toBe(2);
  expect(costOf(projected).relations[`${schema}.merge_rows`]?.blocks).toBeGreaterThan(0);
  expect(costOf(projected)).toMatchObject({
    rows: costOf(raw).rows,
    blocks: costOf(raw).blocks,
    plans: costOf(raw).plans,
  });

  const first = appendImportPostgresCapture({ statements: [], plans: [] }, prefix.capture, 'auth');
  const merged = appendImportPostgresCapture(first, projected, 'kernel');
  expect(merged.statements).toEqual([...prefix.capture.statements, producer, missing]);
  expect(merged.planStatements).toEqual([0, 1, 1]);
  expect(merged.plans).toEqual([...prefix.capture.plans, ...projected.plans]);
  expect(merged.plans[1]).toBe(nested);
  expect(merged.importStatementOwners).toEqual(['auth', 'kernel', 'kernel']);
  expect(merged.importPlanOwners).toEqual(['auth', 'kernel', 'kernel']);
  expect(merged.statementErrors).toEqual([null, null, '42P01']);
  expect(merged.statementErrorMessages).toEqual([
    ...prefix.capture.statementErrorMessages!,
    ...projected.statementErrorMessages!,
  ]);
  expect(merged.statementBackends).toEqual([...prefix.capture.statementBackends!, ...projected.statementBackends!]);
  expect(merged.planBackends).toEqual([...prefix.capture.planBackends!, ...projected.planBackends!]);
  expect(merged.requestBytes).toEqual([...prefix.capture.requestBytes!, ...projected.requestBytes!]);
  expect(merged.responseBytes).toEqual([...prefix.capture.responseBytes!, ...projected.responseBytes!]);
  const occurrences = statementOccurrences(merged).statements;
  expect(occurrences.map(({ plans, error }) => [plans, error?.code ?? null])).toEqual([
    [[0], null],
    [[1, 2], null],
    [[], '42P01'],
  ]);
  expect(occurrences[1]!.planDocuments).toEqual(projected.plans);
  expect(occurrences[1]!.rows).toBe(statementOccurrences(projected).statements[0]!.rows);
  expect(occurrences[1]!.blocks).toBe(statementOccurrences(projected).statements[0]!.blocks);
  expect(costOf(merged)).toMatchObject({
    rows: costOf(first).rows + costOf(projected).rows,
    blocks: costOf(first).blocks + costOf(projected).blocks,
    plans: first.plans.length + projected.plans.length,
  });
});
