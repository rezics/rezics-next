import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const scheduleName = 'growth.schedule.every-second';
const workflowQueue = 'growth-schedule-workflow';
const childQueue = 'growth-schedule-child';
const workflowStatement = 'SELECT 1 AS growth_schedule_workflow';
const childStatement = 'SELECT 1 AS growth_schedule_child';

let db: GrowthDatabase | undefined;
let workflowPool: pg.Pool | undefined;
let scheduleCreated = false;
let childWorkflow: (() => Promise<void>) | undefined;
let scheduledWorkflow: (() => Promise<void>) | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  workflowPool = new pg.Pool({ connectionString: databaseUrl });
  childWorkflow = DBOS.registerWorkflow(
    async () => {
      await db!.pool.query(childStatement);
    },
    { name: 'growth.schedule.child' },
  );
  scheduledWorkflow = DBOS.registerWorkflow(
    async () => {
      await db!.pool.query(workflowStatement);
      const handle = await DBOS.startWorkflow(childWorkflow!, { queueName: childQueue })();
      await handle.getResult();
    },
    { name: 'growth.schedule.workflow' },
  );
  DBOS.setConfig({
    name: 'growth-schedule-test',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: 'dbos',
    systemDatabasePool: workflowPool,
    runMigrations: false,
    logLevel: 'warn',
  });
  await DBOS.launch();
  DBOS.registerQueue(workflowQueue, { workerConcurrency: 1, minPollingIntervalMs: 10 });
  DBOS.registerQueue(childQueue, { workerConcurrency: 1, minPollingIntervalMs: 10 });
  await DBOS.createSchedule({
    scheduleName,
    workflowFn: scheduledWorkflow!,
    schedule: '*/1 * * * * *',
    options: { queueName: workflowQueue },
  });
  scheduleCreated = true;
});

afterAll(async () => {
  if (DBOS.isInitialized()) {
    try {
      if (scheduleCreated) await DBOS.deleteSchedule(scheduleName);
    } finally {
      await DBOS.shutdown({ workflowCompletionTimeoutMS: 5000 });
    }
  }
  await workflowPool?.end();
  await db?.close();
});

async function waitForScheduledRun(database: GrowthDatabase): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await database.admin.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM dbos.workflow_status WHERE schedule_name = $1',
      [scheduleName],
    );
    if ((result.rows[0]?.count ?? 0) > 0) return result.rows[0]!.count;
    await Bun.sleep(25);
  }
  throw new Error(`Schedule ${scheduleName} did not start a workflow`);
}

test('a workflow started by a schedule during a capture is background, while a workflow the operation enqueues is measured', async () => {
  const database = db!;
  const scheduledRunsBefore = await waitForScheduledRun(database);

  const measured = await capture(database, async () => {
    const handle = await DBOS.startWorkflow(scheduledWorkflow!, { queueName: workflowQueue })();
    await handle.getResult();
    await Bun.sleep(2200);
  });

  expect(measured.capture.statements).toEqual([workflowStatement, childStatement]);
  expect(measured.capture.backgroundStatements).toContain(workflowStatement);
  expect(measured.capture.backgroundStatements).toContain(childStatement);

  const scheduledRuns = await database.admin.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM dbos.workflow_status WHERE schedule_name = $1',
    [scheduleName],
  );
  expect(scheduledRuns.rows[0]?.count ?? 0).toBeGreaterThan(scheduledRunsBefore);
});
