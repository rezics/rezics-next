import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import { catalogStatementBound, costOf, isControlStatement, withoutCatalogTexts } from './growth-cost.ts';

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
