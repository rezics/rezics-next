import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const queueName = 'growth-workflow-lineage';
let db: GrowthDatabase | undefined;
let workflowPool: pg.Pool | undefined;
let unrelatedWorkflow: ((topic: string, statement: string) => Promise<string>) | undefined;
let measuredWorkflow: ((statement: string) => Promise<string>) | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  workflowPool = new pg.Pool({ connectionString: databaseUrl });
  unrelatedWorkflow = DBOS.registerWorkflow(
    async (topic: string, statement: string) => {
      await DBOS.recv<string>(topic);
      await db!.pool.query(statement);
      return statement;
    },
    { name: 'growth.workflow.lineage.unrelated' },
  );
  measuredWorkflow = DBOS.registerWorkflow(
    async (statement: string) => {
      await db!.pool.query(statement);
      return statement;
    },
    { name: 'growth.workflow.lineage.measured' },
  );
  DBOS.setConfig({
    name: 'growth-workflow-lineage-test',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'dbos',
    systemDatabasePool: workflowPool,
    runMigrations: false,
    logLevel: 'warn',
  });
  await DBOS.launch();
  DBOS.registerQueue(queueName, { workerConcurrency: 1, minPollingIntervalMs: 10 });
});

afterAll(async () => {
  if (DBOS.isInitialized()) await DBOS.shutdown({ workflowCompletionTimeoutMS: 5000 });
  await workflowPool?.end();
  await db?.close();
});

test('only workflows launched by the operation count as foreground, independent of their IDs', async () => {
  const database = db!;
  const unique = Bun.randomUUIDv7().replaceAll('-', '');
  const ordinaryID = `growth-lineage-unrelated-${unique}`;
  const scheduledID = `sched-growth-lineage-unrelated-${new Date().toISOString()}-${Date.now()}`;
  const measuredID = `sched-growth-lineage-measured-${new Date().toISOString()}-${Date.now()}`;
  const ordinaryStatement = 'SELECT 1 AS unrelated_ordinary_workflow';
  const scheduledStatement = 'SELECT 1 AS unrelated_scheduled_spelling';
  const measuredStatement = 'SELECT 1 AS operation_scheduled_spelling';
  const generatedStatement = 'SELECT 1 AS operation_generated_workflow';

  const ordinary = await DBOS.startWorkflow(unrelatedWorkflow!, { workflowID: ordinaryID, queueName })(
    'release',
    ordinaryStatement,
  );
  const scheduled = await DBOS.startWorkflow(unrelatedWorkflow!, { workflowID: scheduledID, queueName })(
    'release',
    scheduledStatement,
  );

  const result = await capture(database, async () => {
    const owned = await DBOS.startWorkflow(measuredWorkflow!, { workflowID: measuredID, queueName })(measuredStatement);
    const generated = await DBOS.startWorkflow(measuredWorkflow!, { queueName })(generatedStatement);
    await Promise.all([DBOS.send(ordinaryID, true, 'release'), DBOS.send(scheduledID, true, 'release')]);
    return Promise.all([owned.getResult(), generated.getResult(), ordinary.getResult(), scheduled.getResult()]);
  });

  expect(result.value).toEqual([measuredStatement, generatedStatement, ordinaryStatement, scheduledStatement]);
  expect(result.capture.statements).toHaveLength(2);
  expect(result.capture.statements).toEqual(expect.arrayContaining([measuredStatement, generatedStatement]));
  expect(result.capture.backgroundStatements).toHaveLength(2);
  expect(result.capture.backgroundStatements).toEqual(expect.arrayContaining([ordinaryStatement, scheduledStatement]));
}, 60_000);
